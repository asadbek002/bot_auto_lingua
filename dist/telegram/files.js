import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
/**
 * Downloads a Telegram file by file_id using the plain Bot API (no extra plugin needed):
 * getFile -> https://api.telegram.org/file/bot<token>/<file_path>.
 */
export async function downloadTelegramFile(getFile, fileId, fallbackMimeType, fallbackName) {
    const file = await withRetry(() => getFile(fileId), {
        attempts: 3,
        onRetry: (err, attempt) => logger.warn({ err, attempt, fileId }, "Telegram getFile retry"),
    });
    if (!file.file_path) {
        throw new Error(`Telegram file ${fileId} has no file_path`);
    }
    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await withRetry(() => fetch(url), {
        attempts: 3,
        onRetry: (err, attempt) => logger.warn({ err, attempt, fileId }, "Telegram file download retry"),
    });
    if (!res.ok) {
        throw new Error(`Failed to download Telegram file ${fileId}: ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    const fileName = file.file_path.split("/").pop() ?? fallbackName;
    return { buffer: Buffer.from(arrayBuffer), mimeType: fallbackMimeType, fileName };
}
const RECEIPT_KEYWORDS = [
    "chek",
    "screenshot",
    "skrin",
    "to'lov",
    "tolov",
    "click",
    "payme",
    "перевод",
    "чек",
    "квитанция",
];
export function looksLikeReceipt(caption) {
    if (!caption)
        return false;
    const lower = caption.toLowerCase();
    return RECEIPT_KEYWORDS.some((kw) => lower.includes(kw));
}
//# sourceMappingURL=files.js.map