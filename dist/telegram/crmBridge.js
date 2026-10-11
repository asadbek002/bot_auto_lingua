import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { GrammyError, InputFile } from "grammy";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { sendBusinessMessage, withBusinessRetry } from "./send.js";
import { Outbox, OUTBOX_MAX_AGE_MS } from "./outbox.js";
// ── Bot rejimi (crm | auto) ─────────────────────────────────────────────────
let cachedMode = null;
export async function getBotModeCached() {
    const now = Date.now();
    if (cachedMode && cachedMode.expiresAt > now) {
        return cachedMode.mode;
    }
    try {
        const res = await fetch(`${env.LINGUA_MANAGER_API_URL}/bot/status`, {
            headers: {
                "X-Bot-Secret": env.LINGUA_MANAGER_API_KEY,
                "x-api-key": env.LINGUA_MANAGER_API_KEY,
            },
            signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
            const data = (await res.json());
            const mode = data.status === "auto" ? "auto" : "crm";
            cachedMode = { mode, expiresAt: now + 5000 };
            return mode;
        }
    }
    catch (err) {
        logger.warn({ err }, "Failed to fetch bot mode from CRM, falling back to env.BOT_MODE");
    }
    const fallback = env.BOT_MODE;
    cachedMode = { mode: fallback, expiresAt: now + 5000 };
    return fallback;
}
let outbox = null;
let notifyWork = null;
let lastStuckAlertAt = 0;
export function getOutbox() {
    if (!outbox) {
        const file = process.env.CRM_OUTBOX_PATH || path.join(path.dirname(env.STATE_FILE_PATH), "crm-outbox.json");
        outbox = new Outbox(file);
    }
    return outbox;
}
/** Testlar uchun: navbat va ogohlantirishni almashtirish. */
export function configureCrmBridge(opts) {
    if (opts.outbox !== undefined)
        outbox = opts.outbox;
    if (opts.notify !== undefined)
        notifyWork = opts.notify;
}
function apiHeaders() {
    return {
        "Content-Type": "application/json",
        "X-Bot-Secret": env.LINGUA_MANAGER_API_KEY,
        "x-api-key": env.LINGUA_MANAGER_API_KEY,
    };
}
export async function postToApi(pathname, body) {
    try {
        const res = await fetch(`${env.LINGUA_MANAGER_API_URL}${pathname}`, {
            method: "POST",
            headers: apiHeaders(),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });
        if (res.ok)
            return { ok: true };
        const errText = (await res.text()).slice(0, 300);
        // 5xx va 429 — vaqtinchalik (qayta uriniladi); boshqa 4xx — sozlama/ma'lumot xatosi, qayta urinish foydasiz
        return { ok: false, retryable: res.status >= 500 || res.status === 429, error: `CRM API HTTP ${res.status}: ${errText}` };
    }
    catch (err) {
        return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
    }
}
const QUICK_RETRY_DELAYS_MS = [0, 800, 2500];
async function sleep(ms) {
    if (ms > 0)
        await new Promise((r) => setTimeout(r, ms));
}
/**
 * Xabarni CRM ga yuboradi. Qisqa qayta urinishlar, so'ng diskdagi navbat — API qayta ishga tushayotganda
 * (deploy ~10-15 s) xabar yo'qolmaydi. Mijozga hech qachon xabar yozmaydi.
 */
export async function sendToCrm(pathname, payload, quickDelays = QUICK_RETRY_DELAYS_MS) {
    let last = { ok: false, retryable: true, error: "no attempt" };
    for (const delay of quickDelays) {
        await sleep(delay);
        last = await postToApi(pathname, payload);
        if (last.ok)
            return "sent";
        if (!last.retryable)
            break;
    }
    if (last.ok)
        return "sent";
    if (!last.retryable) {
        logger.error({ error: last.error, pathname }, "CRM rejected the message (not retryable) - dropped");
        if (notifyWork) {
            await notifyWork(`⚠️ CRM xabarni qabul qilmadi (qayta urinilmaydi)\n${last.error}`).catch(() => undefined);
        }
        return "dropped";
    }
    getOutbox().add({ __path: pathname, ...payload });
    logger.warn({ error: last.error, queued: getOutbox().size() }, "CRM unreachable - message queued for retry");
    return "queued";
}
export async function forwardToCRM(payload) {
    return sendToCrm("/messages", payload);
}
/** Navbatdagi xabarlarni qayta yuboradi. Interval bilan chaqiriladi. */
export async function flushOutbox(now = Date.now()) {
    const box = getOutbox();
    const expired = box.expire(now);
    if (expired.length && notifyWork) {
        await notifyWork(`⚠️ CRM ga ${expired.length} ta xabar 48 soat davomida yetkazilmadi va navbatdan chiqarildi`).catch(() => undefined);
    }
    let sent = 0;
    for (const item of box.due(now)) {
        const { __path, ...payload } = item.payload;
        const res = await postToApi(typeof __path === "string" ? __path : "/messages", payload);
        if (res.ok || !res.retryable) {
            box.remove(item.id);
            if (res.ok)
                sent += 1;
            else
                logger.error({ error: res.error }, "Outbox item rejected by CRM - dropped");
        }
        else {
            box.failed(item.id, now);
        }
    }
    // Navbat 10 daqiqadan ortiq tiqilib qolsa — ish chatiga bir marta ogohlantirish (soatiga bir)
    if (box.size() > 0 && box.oldestAgeMs(now) > 10 * 60_000 && now - lastStuckAlertAt > 3_600_000 && notifyWork) {
        lastStuckAlertAt = now;
        await notifyWork(`⚠️ CRM ga ${box.size()} ta xabar yetkazilmayapti (API javob bermayapti). Xabarlar saqlanmoqda va keyin yuboriladi.`).catch(() => undefined);
    }
    return { sent, left: box.size() };
}
export function startOutboxFlusher(intervalMs = 30_000) {
    void flushOutbox(); // ishga tushganda diskdagi qoldiqni darrov yuboramiz
    const timer = setInterval(() => void flushOutbox(), intervalMs);
    timer.unref?.();
    return timer;
}
export const _constants = { OUTBOX_MAX_AGE_MS };
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // Telegram Bot API yuklash limiti
const digest = (v) => createHash("sha256").update(v).digest();
export function isAuthorized(provided, secret) {
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (!value || !secret)
        return false;
    return timingSafeEqual(digest(value), digest(secret)); // vaqt bo'yicha hujum qilib bo'lmaydi
}
function json(res, status, body) {
    const raw = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) });
    res.end(raw);
}
function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (c) => {
            size += c.length;
            if (size > limit) {
                reject(Object.assign(new Error("Body too large"), { statusCode: 413 }));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}
/** Telegram/ichki xatoni (status, xabar) ga aylantiradi: panel sababini ko'rsatadi. */
function failure(err) {
    if (err instanceof GrammyError) {
        return { status: 502, body: { error: err.description, error_code: err.error_code } };
    }
    const statusCode = err?.statusCode;
    return { status: statusCode ?? 500, body: { error: err instanceof Error ? err.message : String(err) } };
}
function sentFileId(msg) {
    if (!msg)
        return "";
    if (Array.isArray(msg.photo) && msg.photo.length)
        return msg.photo[msg.photo.length - 1].file_id ?? "";
    return (msg.voice ?? msg.video ?? msg.audio ?? msg.document ?? msg.animation)?.file_id ?? "";
}
async function handleReply(bot, req, res) {
    const body = JSON.parse(await readBody(req, MAX_JSON_BYTES));
    if (!body.client_chat_id || !body.business_connection_id || !body.text) {
        json(res, 400, { error: "Missing required fields" });
        return;
    }
    const sent = await sendBusinessMessage(bot, Number(body.client_chat_id), body.business_connection_id, body.text);
    json(res, 200, { ok: true, message_id: sent?.message_id ?? 0 });
}
async function handleReplyFile(bot, req, res) {
    const length = Number(req.headers["content-length"] ?? 0);
    if (length > MAX_UPLOAD_BYTES + 1024 * 1024) {
        json(res, 413, { error: "Fayl juda katta (Telegram 50 MB gacha qabul qiladi)" });
        return;
    }
    // Node 22: Web Request orqali multipart ni qo'shimcha kutubxonasiz o'qiymiz
    const request = new Request("http://localhost/", {
        method: "POST",
        headers: req.headers,
        body: Readable.toWeb(req),
        duplex: "half",
    });
    const form = await request.formData();
    const chatId = Number(form.get("client_chat_id"));
    const connectionId = String(form.get("business_connection_id") ?? "");
    const caption = String(form.get("text") ?? "");
    const msgType = String(form.get("msg_type") ?? "document");
    const file = form.get("file");
    if (!chatId || !connectionId || !(file instanceof File)) {
        json(res, 400, { error: "Missing required fields" });
        return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
        json(res, 413, { error: "Fayl juda katta (Telegram 50 MB gacha qabul qiladi)" });
        return;
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const make = () => new InputFile(buffer, file.name || "file");
    const opts = { business_connection_id: connectionId, ...(caption ? { caption } : {}) };
    const sent = await withBusinessRetry(() => {
        switch (msgType) {
            case "photo": return bot.api.sendPhoto(chatId, make(), opts);
            case "voice": return bot.api.sendVoice(chatId, make(), opts);
            case "video": return bot.api.sendVideo(chatId, make(), opts);
            case "audio": return bot.api.sendAudio(chatId, make(), opts);
            default: return bot.api.sendDocument(chatId, make(), opts);
        }
    }, chatId);
    json(res, 200, { ok: true, message_id: sent?.message_id ?? 0, file_id: sentFileId(sent) });
}
export function createCrmServer(bot, secret = env.BOT_WEBHOOK_SECRET) {
    return http.createServer(async (req, res) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (req.method === "GET" && pathname === "/health") {
            json(res, 200, { status: "ok", queued: getOutbox().size() });
            return;
        }
        // Qolgan hamma endpointlar maxfiy kalit talab qiladi (avval fayl oqimi ochiq edi)
        const authorized = isAuthorized(req.headers["x-api-key"], secret);
        try {
            if (req.method === "GET" && pathname.startsWith("/crm-webhook/file")) {
                if (!authorized) {
                    json(res, 401, { error: "Unauthorized" });
                    return;
                }
                const fileId = new URL(req.url ?? "/", "http://localhost").searchParams.get("file_id") || pathname.split("/").pop();
                if (!fileId) {
                    json(res, 400, { error: "Missing file_id" });
                    return;
                }
                const file = await bot.api.getFile(fileId);
                if (!file.file_path)
                    throw new Error("No file_path returned from Telegram");
                const fileRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
                if (!fileRes.ok || !fileRes.body) {
                    json(res, fileRes.status, { error: "Failed to download from Telegram" });
                    return;
                }
                res.writeHead(200, {
                    "Content-Type": fileRes.headers.get("content-type") || "application/octet-stream",
                    ...(fileRes.headers.get("content-length") ? { "Content-Length": fileRes.headers.get("content-length") } : {}),
                });
                Readable.fromWeb(fileRes.body).pipe(res);
                return;
            }
            if (req.method === "POST" && pathname === "/crm-webhook/reply") {
                if (!authorized) {
                    json(res, 401, { error: "Unauthorized" });
                    return;
                }
                await handleReply(bot, req, res);
                return;
            }
            if (req.method === "POST" && pathname === "/crm-webhook/reply-file") {
                if (!authorized) {
                    json(res, 401, { error: "Unauthorized" });
                    return;
                }
                await handleReplyFile(bot, req, res);
                return;
            }
            json(res, 404, { error: "Not found" });
        }
        catch (err) {
            logger.error({ err, pathname }, "CRM webhook request failed");
            if (res.headersSent) {
                res.end();
                return;
            }
            const f = failure(err);
            json(res, f.status, f.body);
        }
    });
}
export function startCRMWebhookServer(bot) {
    const server = createCrmServer(bot);
    server.on("error", (err) => {
        if (err?.code === "EADDRINUSE") {
            logger.warn({ port: env.BOT_WEBHOOK_PORT }, "CRM Webhook port already in use, reusing existing listener");
        }
        else {
            logger.error({ err }, "CRM Webhook server error");
        }
    });
    server.listen(env.BOT_WEBHOOK_PORT, () => {
        logger.info({ port: env.BOT_WEBHOOK_PORT }, "CRM Webhook HTTP server listening");
    });
    configureCrmBridge({
        notify: env.WORK_CHAT_ID ? (text) => bot.api.sendMessage(env.WORK_CHAT_ID, text) : null,
    });
    startOutboxFlusher();
    return server;
}
//# sourceMappingURL=crmBridge.js.map