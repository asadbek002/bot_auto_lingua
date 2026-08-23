import { env } from "./src/config/env.js";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

console.log("Testing Claude model:", env.CLAUDE_MODEL);
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
try {
  const res = await anthropic.messages.create({
    model: env.CLAUDE_MODEL,
    max_tokens: 10,
    messages: [{ role: "user", content: "Hi" }],
  });
  console.log("Claude response SUCCESS:", res.content);
} catch (err: any) {
  console.error("Claude ERROR:", err?.message || err);
}

console.log("\nTesting Gemini model:", env.GEMINI_MODEL);
const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
try {
  const res = await ai.models.generateContent({
    model: env.GEMINI_MODEL,
    contents: "Hi",
  });
  console.log("Gemini response SUCCESS:", res.text);
} catch (err: any) {
  console.error("Gemini ERROR:", err?.message || err);
}
