import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { loadAllExports } from "./sources/exportAdapter.js";
import { loadLiveConversations } from "./sources/liveLogAdapter.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_OUTPUT_PATH = path.resolve(__dirname, "../../agent_profile.md");
const FINDINGS_CACHE_PATH = path.resolve(__dirname, "../../training_data/_merged_findings.json");
const MAX_BATCH_CHARS = 150000;
const MAX_SAMPLES_PER_CATEGORY = 60;
function parseArgs(argv) {
    const args = { exportDir: "training_data", includeLive: false, provider: "gemini" };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--export-dir")
            args.exportDir = argv[++i] ?? args.exportDir;
        else if (arg === "--live")
            args.includeLive = true;
        else if (arg === "--owner-name")
            args.ownerName = argv[++i];
        else if (arg === "--from-findings")
            args.fromFindings = argv[++i];
        else if (arg === "--provider") {
            const p = (argv[++i] ?? "").toLowerCase();
            if (p === "claude" || p === "gemini")
                args.provider = p;
        }
    }
    return args;
}
function chatToText(chat) {
    return chat.messages.map((m) => `${m.from === "owner" ? "OWNER" : "CLIENT"}: ${m.text}`).join("\n");
}
function batchChats(chats) {
    const batches = [];
    let current = "";
    for (const chat of chats) {
        const text = `--- Chat: ${chat.chatName} ---\n${chatToText(chat)}\n`;
        if (current.length + text.length > MAX_BATCH_CHARS && current.length > 0) {
            batches.push(current);
            current = "";
        }
        current += text;
    }
    if (current.length > 0)
        batches.push(current);
    return batches;
}
const EMPTY_FINDINGS = {
    toneSamples: [],
    priceMentions: [],
    processSteps: [],
    glossary: [],
    faq: [],
};
const EXTRACTION_PROMPT = `You are analyzing real WhatsApp/Telegram-style chat logs between a
Uzbekistan translation/apostille bureau owner (OWNER) and their clients (CLIENT).
Extract, from ONLY this batch of chats, structured findings as strict JSON:
{
  "toneSamples": string[] (representative OWNER phrases showing greeting/closing style, tone),
  "priceMentions": string[] (any concrete prices/services mentioned, quoted verbatim),
  "processSteps": string[] (the sequence of questions/steps OWNER asks when handling a new order),
  "glossary": [{"term": string, "meaning": string}] (Uzbek slang/abbreviations/typos used by clients and what they mean, e.g. "kk" -> "kerak"),
  "faq": [{"question": string, "answer": string}] (recurring client questions and how OWNER typically answered)
}
Output ONLY the JSON, no markdown fences, no commentary. If a category has nothing
relevant in this batch, use an empty array for it. Keep each category to at most the
15 most representative/distinct items - do not try to list every occurrence, this is
one batch among many and duplicates across batches are merged later. Keep each string
short (one line).

CHAT LOGS:`;
async function extractFromBatchGemini(ai, batchText) {
    const prompt = `${EXTRACTION_PROMPT}\n${batchText}`;
    try {
        const res = await ai.models.generateContent({
            model: env.GEMINI_MODEL,
            contents: prompt,
        });
        const text = res.text ?? "";
        const cleaned = text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "");
        return { ...EMPTY_FINDINGS, ...JSON.parse(cleaned) };
    }
    catch (err) {
        logger.warn({ err }, "Failed Gemini extraction for training batch");
        return EMPTY_FINDINGS;
    }
}
async function extractFromBatchClaude(anthropic, batchText) {
    const prompt = `${EXTRACTION_PROMPT}\n${batchText}`;
    try {
        const response = await anthropic.messages.create({
            model: env.CLAUDE_MODEL,
            max_tokens: 8000,
            thinking: { type: "disabled" },
            messages: [{ role: "user", content: prompt }],
        });
        const textBlock = response.content.find((b) => b.type === "text");
        if (!textBlock)
            return EMPTY_FINDINGS;
        const cleaned = textBlock.text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "");
        return { ...EMPTY_FINDINGS, ...JSON.parse(cleaned) };
    }
    catch (err) {
        logger.warn({ err }, "Failed Claude extraction for training batch");
        return EMPTY_FINDINGS;
    }
}
function mergeFindings(all) {
    const merged = {
        toneSamples: [],
        priceMentions: [],
        processSteps: [],
        glossary: [],
        faq: [],
    };
    const seenGlossary = new Set();
    const seenFaq = new Set();
    const seenTone = new Set();
    const seenPrice = new Set();
    const seenStep = new Set();
    const pushDeduped = (arr, seen, value) => {
        const key = value.trim().toLowerCase();
        if (!key || seen.has(key))
            return;
        seen.add(key);
        arr.push(value.trim());
    };
    for (const f of all) {
        for (const t of f.toneSamples) {
            if (merged.toneSamples.length < MAX_SAMPLES_PER_CATEGORY)
                pushDeduped(merged.toneSamples, seenTone, t);
        }
        for (const p of f.priceMentions) {
            if (merged.priceMentions.length < MAX_SAMPLES_PER_CATEGORY)
                pushDeduped(merged.priceMentions, seenPrice, p);
        }
        for (const s of f.processSteps) {
            if (merged.processSteps.length < MAX_SAMPLES_PER_CATEGORY)
                pushDeduped(merged.processSteps, seenStep, s);
        }
        for (const g of f.glossary) {
            const key = g.term.toLowerCase();
            if (!seenGlossary.has(key)) {
                seenGlossary.add(key);
                merged.glossary.push(g);
            }
        }
        for (const q of f.faq) {
            const key = q.question.toLowerCase();
            if (!seenFaq.has(key)) {
                seenFaq.add(key);
                merged.faq.push(q);
            }
        }
    }
    return merged;
}
const SYNTHESIS_PROMPT = `Using these merged findings extracted from real chat history of a
Uzbekistan translation/apostille bureau, write a complete agent_profile.md in the exact
section structure below. This file will be read by both a human business owner and fed
into an AI system prompt, so it must be clear, concise Markdown.

Sections required, in this order:
# Agent Profile - Lingua Translation
## 1. Tone and style
## 2. Services and prices
## 3. Typical order process (question sequence)
## 4. Glossary - Uzbek slang / abbreviations / typos (as a markdown table: | Seen in chat | Meaning |)
## 5. FAQ (frequent questions & standard answers)
## 6. Escalation stub phrase (sent to client while a human is being pulled in)

Ground everything in the findings below - do not invent prices or facts not present.
If a section has too little data, keep it short and say so plainly rather than padding.

FINDINGS (JSON):`;
async function synthesizeProfileGemini(ai, findings) {
    const prompt = `${SYNTHESIS_PROMPT}\n${JSON.stringify(findings, null, 2)}`;
    try {
        const res = await ai.models.generateContent({
            model: env.GEMINI_MODEL,
            contents: prompt,
        });
        const raw = res.text?.trim() ?? "# Agent Profile - Lingua Translation\n\n(generation failed)";
        return raw.replace(/^```(?:markdown)?\n?/i, "").replace(/```\s*$/, "").trim();
    }
    catch (err) {
        logger.error({ err }, "Gemini profile synthesis failed");
        return "# Agent Profile - Lingua Translation\n\n(generation failed)";
    }
}
async function synthesizeProfileClaude(anthropic, findings) {
    const prompt = `${SYNTHESIS_PROMPT}\n${JSON.stringify(findings, null, 2)}`;
    try {
        const response = await anthropic.messages.create({
            model: env.CLAUDE_MODEL,
            max_tokens: 8000,
            thinking: { type: "disabled" },
            messages: [{ role: "user", content: prompt }],
        });
        const textBlock = response.content.find((b) => b.type === "text");
        const raw = textBlock?.text.trim() ?? "# Agent Profile - Lingua Translation\n\n(generation failed)";
        return raw.replace(/^```(?:markdown)?\n?/i, "").replace(/```\s*$/, "").trim();
    }
    catch (err) {
        logger.error({ err }, "Claude profile synthesis failed");
        return "# Agent Profile - Lingua Translation\n\n(generation failed)";
    }
}
export async function runTraining(args) {
    const provider = args.provider ?? (env.GEMINI_API_KEY ? "gemini" : "claude");
    logger.info({ provider }, "Starting training run using free provider");
    let geminiAi = null;
    let anthropicAi = null;
    if (provider === "gemini") {
        if (!env.GEMINI_API_KEY)
            throw new Error("GEMINI_API_KEY is not set in .env");
        geminiAi = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    }
    else {
        if (!env.ANTHROPIC_API_KEY)
            throw new Error("ANTHROPIC_API_KEY is not set in .env");
        anthropicAi = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    }
    let merged;
    if (args.fromFindings) {
        logger.info({ path: args.fromFindings }, "Skipping extraction, loading cached findings");
        merged = JSON.parse(fs.readFileSync(args.fromFindings, "utf-8"));
    }
    else {
        const exportChats = loadAllExports(args.exportDir, args.ownerName);
        const liveChats = args.includeLive ? loadLiveConversations(env.STATE_FILE_PATH) : [];
        const allChats = [...exportChats, ...liveChats];
        if (allChats.length === 0) {
            logger.warn({ exportDir: args.exportDir }, "No training data found (no export JSON files and --live not used or empty). Nothing to do.");
            return "";
        }
        logger.info({ chats: allChats.length, provider }, "Loaded chats for training");
        const batches = batchChats(allChats);
        logger.info({ batches: batches.length }, "Split into batches for extraction");
        const partials = [];
        for (const [i, batch] of batches.entries()) {
            logger.info({ batch: i + 1, total: batches.length }, "Extracting findings from batch");
            if (geminiAi) {
                partials.push(await extractFromBatchGemini(geminiAi, batch));
            }
            else if (anthropicAi) {
                partials.push(await extractFromBatchClaude(anthropicAi, batch));
            }
        }
        merged = mergeFindings(partials);
        logger.info({
            toneSamples: merged.toneSamples.length,
            priceMentions: merged.priceMentions.length,
            glossary: merged.glossary.length,
            faq: merged.faq.length,
        }, "Merged findings across all batches");
        fs.mkdirSync(path.dirname(FINDINGS_CACHE_PATH), { recursive: true });
        fs.writeFileSync(FINDINGS_CACHE_PATH, JSON.stringify(merged, null, 2), "utf-8");
        logger.info({ path: FINDINGS_CACHE_PATH }, "Cached merged findings");
    }
    const profile = geminiAi
        ? await synthesizeProfileGemini(geminiAi, merged)
        : await synthesizeProfileClaude(anthropicAi, merged);
    fs.writeFileSync(PROFILE_OUTPUT_PATH, profile, "utf-8");
    logger.info({ path: PROFILE_OUTPUT_PATH }, "Wrote updated agent_profile.md");
    return profile;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    await runTraining(args);
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    main().catch((err) => {
        logger.error({ err }, "Training run failed");
        process.exit(1);
    });
}
//# sourceMappingURL=train.js.map