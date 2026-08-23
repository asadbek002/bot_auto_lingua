import fs from "node:fs";
import path from "node:path";
import { parse, type HTMLElement } from "node-html-parser";

/**
 * One-off converter: Telegram Desktop's HTML "Export Telegram Data" format (per-chat
 * messages.html / messages2.html / ...) -> the same JSON shape src/train/sources/
 * exportAdapter.ts already expects from the native JSON export, so train.ts needs no
 * changes. Filters to private (1-on-1) chats only, per the ТЗ rule that the agent never
 * reads/analyzes groups or channels - and excludes the account's own "Saved messages"
 * self-chat, which the export also tags as "private" but isn't a client conversation.
 */

interface CliArgs {
  exportDir: string;
  outDir: string;
  ownerName?: string;
  minMessages: number;
}

interface ChatIndexEntry {
  folder: string;
  type: string;
  name: string;
  count: number;
}

interface RawMessage {
  type: "message";
  date: string;
  from: string;
  from_id: string;
  text: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    exportDir: "",
    outDir: "training_data",
    minMessages: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--export-dir") args.exportDir = argv[++i] ?? "";
    else if (a === "--out-dir") args.outDir = argv[++i] ?? args.outDir;
    else if (a === "--owner-name") args.ownerName = argv[++i];
    else if (a === "--min-messages") args.minMessages = Number(argv[++i] ?? "1");
  }
  if (!args.exportDir) {
    throw new Error(
      "Usage: tsx src/train/convertHtmlExport.ts --export-dir <path to DataExport_YYYY-MM-DD> [--out-dir training_data] [--owner-name \"Name\"] [--min-messages 1]"
    );
  }
  return args;
}

function detectOwnerName(exportDir: string): string | undefined {
  const p = path.join(exportDir, "export_results.html");
  if (!fs.existsSync(p)) return undefined;
  const html = fs.readFileSync(p, "utf-8");
  const root = parse(html);
  const rows = root.querySelectorAll(".rows.names .row");
  for (const row of rows) {
    const label = row.querySelector(".label")?.text.trim();
    const value = row.querySelector(".value")?.text.trim();
    if (label === "First name" && value) return value;
  }
  return undefined;
}

function loadChatIndex(exportDir: string): ChatIndexEntry[] {
  const p = path.join(exportDir, "lists", "chats.html");
  const html = fs.readFileSync(p, "utf-8");
  const root = parse(html);
  const entries: ChatIndexEntry[] = [];

  for (const a of root.querySelectorAll(".entry_list > .entry")) {
    const href = a.getAttribute("href") ?? "";
    const folderMatch = href.match(/chats\/(chat_\d+)\/messages\.html/);
    if (!folderMatch) continue;
    const type = a.querySelector(".pull_right.info.details")?.text.trim() ?? "?";
    const name = a.querySelector(".name")?.text.trim() ?? "?";
    const countText = a.querySelector(".details_entry")?.text.trim() ?? "0";
    const count = parseInt(countText.replace(/[^\d]/g, ""), 10) || 0;
    entries.push({ folder: folderMatch[1]!, type, name, count });
  }
  return entries;
}

function sortMessageFiles(folderPath: string): string[] {
  const files = fs.readdirSync(folderPath).filter((f) => /^messages\d*\.html$/.test(f));
  return files.sort((a, b) => {
    const na = a === "messages.html" ? 1 : parseInt(a.match(/\d+/)![0], 10);
    const nb = b === "messages.html" ? 1 : parseInt(b.match(/\d+/)![0], 10);
    return na - nb;
  });
}

function ddmmyyyyToIso(title: string | undefined): string {
  if (!title) return "";
  const m = title.match(/(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return "";
  const [, dd, mm, yyyy, hh, min, ss] = m;
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`;
}

function mediaPlaceholder(msgEl: HTMLElement): string {
  const cls = (className: string) => msgEl.querySelector(`.${className}`);
  if (cls("media_photo")) return "[photo]";
  if (cls("media_voice_message")) return "[voice message]";
  if (cls("media_video")) return "[video]";
  if (cls("media_location")) return "[location]";
  if (cls("media_call")) return "[call]";
  if (cls("media_file")) {
    const title = msgEl.querySelector(".media_file .title")?.text.trim();
    return title ? `[file: ${title}]` : "[file]";
  }
  return "";
}

function isDirectChildOfPlainBody(el: HTMLElement): boolean {
  const parent = el.parentNode as HTMLElement | null;
  if (!parent) return false;
  const parentClass = parent.getAttribute("class") ?? "";
  return parentClass.trim() === "body";
}

function extractMessagesFromChat(folderPath: string, ownerNameHint: string | undefined): {
  messages: RawMessage[];
  parseErrors: string[];
} {
  const files = sortMessageFiles(folderPath);
  const messages: RawMessage[] = [];
  const parseErrors: string[] = [];
  let lastSender = "";

  for (const file of files) {
    const filePath = path.join(folderPath, file);
    let html: string;
    try {
      html = fs.readFileSync(filePath, "utf-8");
    } catch (err: any) {
      parseErrors.push(`${file}: read failed (${err.message})`);
      continue;
    }

    let root;
    try {
      root = parse(html);
    } catch (err: any) {
      parseErrors.push(`${file}: HTML parse failed (${err.message})`);
      continue;
    }

    const msgEls = root.querySelectorAll(".message");
    for (const msgEl of msgEls) {
      const cls = msgEl.getAttribute("class") ?? "";
      if (cls.includes("service")) continue;

      const fromNameEls = msgEl.querySelectorAll(".from_name");
      const ownFromNameEl = fromNameEls.find((e) => isDirectChildOfPlainBody(e));
      if (ownFromNameEl) {
        lastSender = ownFromNameEl.text.trim();
      }
      if (!lastSender) continue; // can't attribute this message to anyone yet - skip

      const textEls = msgEl.querySelectorAll(".text");
      const ownTextEl = textEls.find((e) => isDirectChildOfPlainBody(e));
      let text = ownTextEl?.text.trim() ?? "";
      if (!text) text = mediaPlaceholder(msgEl);
      if (!text) continue;

      const dateTitle = msgEl.querySelector(".date.details")?.getAttribute("title");
      const isoDate = ddmmyyyyToIso(dateTitle);

      messages.push({ type: "message", date: isoDate, from: lastSender, from_id: "", text });
    }
  }

  void ownerNameHint;
  return { messages, parseErrors };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-Ѐ-ӿĀ-ſ]/g, "_").slice(0, 60);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ownerName = args.ownerName ?? detectOwnerName(args.exportDir);
  if (!ownerName) {
    console.warn(
      "Could not auto-detect owner name from export_results.html and none given via --owner-name. " +
        "All messages will be attributed as 'client' when train.ts runs, which will weaken tone extraction."
    );
  } else {
    console.log(`Owner name: "${ownerName}"`);
  }

  const index = loadChatIndex(args.exportDir);
  const excludedNames = new Set(["saved messages", "избранное"]);

  const candidates = index.filter(
    (e) =>
      e.type === "private" &&
      e.count >= args.minMessages &&
      !excludedNames.has(e.name.trim().toLowerCase())
  );

  console.log(
    `Chat index: ${index.length} total, ${index.filter((e) => e.type === "private").length} private, ` +
      `${candidates.length} qualify (>= ${args.minMessages} messages, excluding self-chat)`
  );

  fs.mkdirSync(args.outDir, { recursive: true });

  let chatsWritten = 0;
  let chatsSkippedEmpty = 0;
  let chatsSkippedError = 0;
  let totalMessages = 0;
  let totalChars = 0;
  const errorLog: string[] = [];

  for (const entry of candidates) {
    const folderPath = path.join(args.exportDir, "chats", entry.folder);
    try {
      const { messages, parseErrors } = extractMessagesFromChat(folderPath, ownerName);
      if (parseErrors.length > 0) {
        errorLog.push(`${entry.folder} (${entry.name}): ${parseErrors.join("; ")}`);
      }
      if (messages.length === 0) {
        chatsSkippedEmpty++;
        continue;
      }

      const outPath = path.join(
        args.outDir,
        `${entry.folder}_${sanitizeFilename(entry.name)}.json`
      );
      fs.writeFileSync(
        outPath,
        JSON.stringify({ name: entry.name, type: "personal_chat", id: null, messages }, null, 2),
        "utf-8"
      );
      chatsWritten++;
      totalMessages += messages.length;
      totalChars += messages.reduce((s, m) => s + m.text.length, 0);
    } catch (err: any) {
      chatsSkippedError++;
      errorLog.push(`${entry.folder} (${entry.name}): FAILED - ${err.message}`);
    }
  }

  console.log("\n=== Conversion summary ===");
  console.log(`Chats written:        ${chatsWritten}`);
  console.log(`Chats skipped (empty after extraction): ${chatsSkippedEmpty}`);
  console.log(`Chats skipped (error): ${chatsSkippedError}`);
  console.log(`Total messages written: ${totalMessages}`);
  console.log(`Total characters written: ${totalChars.toLocaleString()}`);
  console.log(`Output dir: ${path.resolve(args.outDir)}`);

  if (errorLog.length > 0) {
    const logPath = path.join(args.outDir, "_conversion_errors.log");
    fs.writeFileSync(logPath, errorLog.join("\n"), "utf-8");
    console.log(`\n${errorLog.length} chats had issues - see ${logPath}`);
  }
}

main().catch((err) => {
  console.error("Conversion failed:", err.message);
  process.exit(1);
});
