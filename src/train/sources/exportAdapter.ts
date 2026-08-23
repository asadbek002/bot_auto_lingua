import fs from "node:fs";
import path from "node:path";

export interface NormalizedMessage {
  from: "client" | "owner";
  text: string;
  date?: string;
}

export interface NormalizedChat {
  source: string;
  chatName: string;
  messages: NormalizedMessage[];
}

interface TDTextEntity {
  type?: string;
  text?: string;
}

interface TDMessage {
  type?: string;
  date?: string;
  from?: string;
  from_id?: string;
  text?: string | (string | TDTextEntity)[];
  media_type?: string;
  photo?: string;
  file?: string;
}

interface TDExport {
  name?: string;
  type?: string;
  id?: number;
  messages?: TDMessage[];
}

function flattenText(text: TDMessage["text"]): string {
  if (!text) return "";
  if (typeof text === "string") return text;
  return text
    .map((part) => (typeof part === "string" ? part : (part.text ?? "")))
    .join("");
}

/**
 * Parses a Telegram Desktop "Export chat history" JSON file for a single one-on-one
 * chat. The owner's own account is whichever `from` value repeats as the sender of
 * outgoing replies - since we don't reliably know which participant is the owner from
 * the file alone across exports, callers should pass `ownerNameHint` when known (their
 * own display name in Telegram) so messages can be labeled owner vs client accurately.
 */
export function parseTelegramDesktopExport(
  filePath: string,
  ownerNameHint?: string
): NormalizedChat {
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as TDExport;

  const messages: NormalizedMessage[] = [];
  for (const m of data.messages ?? []) {
    if (m.type !== "message") continue;
    const text = flattenText(m.text).trim();
    if (!text) continue;

    const isOwner = ownerNameHint ? m.from === ownerNameHint : false;
    messages.push({
      from: isOwner ? "owner" : "client",
      text,
      date: m.date,
    });
  }

  return {
    source: path.basename(filePath),
    chatName: data.name ?? path.basename(filePath),
    messages,
  };
}

export function loadAllExports(dir: string, ownerNameHint?: string): NormalizedChat[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json"));
  return files.map((f) => parseTelegramDesktopExport(path.join(dir, f), ownerNameHint));
}
