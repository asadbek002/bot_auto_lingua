import fs from "node:fs";
import path from "node:path";
function flattenText(text) {
    if (!text)
        return "";
    if (typeof text === "string")
        return text;
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
export function parseTelegramDesktopExport(filePath, ownerNameHint) {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    const messages = [];
    for (const m of data.messages ?? []) {
        if (m.type !== "message")
            continue;
        const text = flattenText(m.text).trim();
        if (!text)
            continue;
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
export function loadAllExports(dir, ownerNameHint) {
    if (!fs.existsSync(dir))
        return [];
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json"));
    return files.map((f) => parseTelegramDesktopExport(path.join(dir, f), ownerNameHint));
}
//# sourceMappingURL=exportAdapter.js.map