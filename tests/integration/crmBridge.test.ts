import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { GrammyError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/config/env.js";
import { Outbox } from "../../src/telegram/outbox.js";
import {
  configureCrmBridge, createCrmServer, flushOutbox, getOutbox, isAuthorized, sendToCrm,
} from "../../src/telegram/crmBridge.js";
import { _setBusinessRetryDelay } from "../../src/telegram/send.js";
import { startFakeApi } from "../helpers/fakeApi.js";

let dir: string;
const notify = vi.fn(async () => undefined);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-"));
  configureCrmBridge({ outbox: new Outbox(path.join(dir, "outbox.json")), notify });
  notify.mockClear();
  _setBusinessRetryDelay(1);
  env.LINGUA_MANAGER_API_KEY = "sirli-kalit";
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("CRM ga yuborish: qayta urinish va navbat", () => {
  it("muvaffaqiyatli yuborish — kalit sarlavhalari bilan", async () => {
    const api = await startFakeApi(200);
    env.LINGUA_MANAGER_API_URL = api.url;
    expect(await sendToCrm("/messages", { text: "salom" }, [0])).toBe("sent");
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.headers["x-bot-secret"]).toBe("sirli-kalit");
    expect(api.calls[0]!.body.text).toBe("salom");
    await api.close();
  });

  it("API vaqtincha 503 bersa — qayta urinib yetkazadi", async () => {
    const api = await startFakeApi(503);
    env.LINGUA_MANAGER_API_URL = api.url;
    setTimeout(() => { api.state.status = 200; }, 20);
    expect(await sendToCrm("/messages", { text: "x" }, [0, 60, 60])).toBe("sent");
    expect(api.calls.length).toBeGreaterThan(1);
    await api.close();
  });

  it("API o'chiq: xabar diskdagi navbatga tushadi va keyin yo'qolmay yetadi", async () => {
    const api = await startFakeApi(200);
    const url = api.url;
    await api.close();                                             // API qayta ishga tushayotgan payt
    env.LINGUA_MANAGER_API_URL = url;
    expect(await sendToCrm("/messages", { text: "muhim", tg_message_id: 7 }, [0])).toBe("queued");
    expect(getOutbox().size()).toBe(1);

    const again = await startFakeApi(200);                         // API qaytdi (boshqa port — URL ni yangilaymiz)
    env.LINGUA_MANAGER_API_URL = again.url;
    const res = await flushOutbox(Date.now() + 3_600_000);
    expect(res).toEqual({ sent: 1, left: 0 });
    expect(again.calls[0]!.body).toMatchObject({ text: "muhim", tg_message_id: 7 });
    expect(again.calls[0]!.body.__path).toBeUndefined();           // ichki maydon API ga ketmaydi
    await again.close();
  });

  it("navbatdagi xabar API hali javob bermasa qoladi va kutish oshadi", async () => {
    const api = await startFakeApi(500);
    env.LINGUA_MANAGER_API_URL = api.url;
    expect(await sendToCrm("/messages", { text: "x" }, [0])).toBe("queued");
    const now = Date.now() + 60_000;
    expect(await flushOutbox(now)).toEqual({ sent: 0, left: 1 });
    expect(getOutbox().due(now + 1000)).toHaveLength(0);           // keyingi urinish keyinroq
    await api.close();
  });

  it("CRM 4xx bersa (masalan kalit xato) — qayta urinilmaydi, ish chatiga xabar", async () => {
    const api = await startFakeApi(403);
    env.LINGUA_MANAGER_API_URL = api.url;
    expect(await sendToCrm("/messages", { text: "x" }, [0, 0, 0])).toBe("dropped");
    expect(api.calls).toHaveLength(1);
    expect(getOutbox().size()).toBe(0);
    expect(notify).toHaveBeenCalledOnce();
    await api.close();
  });
});

// ── Panel → Telegram ─────────────────────────────────────────────────────────

function fakeBot() {
  const api = {
    sendMessage: vi.fn(async () => ({ message_id: 101 })),
    sendPhoto: vi.fn(async () => ({ message_id: 102, photo: [{ file_id: "p1" }, { file_id: "PBIG" }] })),
    sendVoice: vi.fn(async () => ({ message_id: 103, voice: { file_id: "VOICE" } })),
    sendVideo: vi.fn(async () => ({ message_id: 104, video: { file_id: "VID" } })),
    sendAudio: vi.fn(async () => ({ message_id: 105, audio: { file_id: "AUD" } })),
    sendDocument: vi.fn(async () => ({ message_id: 106, document: { file_id: "DOC" } })),
    getFile: vi.fn(async () => ({ file_path: "x" })),
  };
  return { api: api as any };
}

async function listen(bot: ReturnType<typeof fakeBot>) {
  const server = createCrmServer(bot, "kalit123");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const H = { "x-api-key": "kalit123" };

describe("CRM webhook serveri", () => {
  it("kalit tekshiruvi: /health ochiq, qolganlari yopiq (fayl oqimi ham)", async () => {
    const bot = fakeBot();
    const s = await listen(bot);
    expect((await fetch(`${s.url}/health`)).status).toBe(200);
    expect((await fetch(`${s.url}/crm-webhook/reply`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${s.url}/crm-webhook/reply`, { method: "POST", headers: { "x-api-key": "xato" }, body: "{}" })).status).toBe(401);
    expect((await fetch(`${s.url}/crm-webhook/reply-file`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${s.url}/crm-webhook/file?file_id=abc`)).status).toBe(401);
    expect((await fetch(`${s.url}/nope`, { headers: H })).status).toBe(404);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    await s.close();
  });

  it("isAuthorized: bo'sh yoki xato kalit o'tmaydi", () => {
    expect(isAuthorized("a", "a")).toBe(true);
    expect(isAuthorized("a", "b")).toBe(false);
    expect(isAuthorized(undefined, "b")).toBe(false);
    expect(isAuthorized("", "")).toBe(false);
  });

  it("matn javobi: Telegram xabar ID qaytadi", async () => {
    const bot = fakeBot();
    const s = await listen(bot);
    const r = await fetch(`${s.url}/crm-webhook/reply`, {
      method: "POST", headers: H,
      body: JSON.stringify({ client_chat_id: "555", business_connection_id: "bc1", text: "salom" }),
    });
    expect(await r.json()).toEqual({ ok: true, message_id: 101 });
    expect(bot.api.sendMessage).toHaveBeenCalledWith(555, "salom", { business_connection_id: "bc1" });
    const bad = await fetch(`${s.url}/crm-webhook/reply`, { method: "POST", headers: H, body: JSON.stringify({ client_chat_id: 1 }) });
    expect(bad.status).toBe(400);
    await s.close();
  });

  it("BUSINESS_PEER_INVALID vaqtincha xato — qayta uriniladi", async () => {
    const bot = fakeBot();
    const peer = new GrammyError("x", { ok: false, error_code: 400, description: "Bad Request: BUSINESS_PEER_INVALID" } as any, "sendMessage", {});
    bot.api.sendMessage.mockRejectedValueOnce(peer).mockResolvedValueOnce({ message_id: 9 });
    const s = await listen(bot);
    const r = await fetch(`${s.url}/crm-webhook/reply`, { method: "POST", headers: H, body: JSON.stringify({ client_chat_id: 1, business_connection_id: "b", text: "t" }) });
    expect(await r.json()).toEqual({ ok: true, message_id: 9 });
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    await s.close();
  });

  it("Telegram xatosi 502 va sabab matni bilan qaytadi (panel ko'rsatadi)", async () => {
    const bot = fakeBot();
    const blocked = new GrammyError("x", { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } as any, "sendMessage", {});
    bot.api.sendMessage.mockRejectedValue(blocked);
    const s = await listen(bot);
    const r = await fetch(`${s.url}/crm-webhook/reply`, { method: "POST", headers: H, body: JSON.stringify({ client_chat_id: 1, business_connection_id: "b", text: "t" }) });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: "Forbidden: bot was blocked by the user", error_code: 403 });
    await s.close();
  });

  const upload = (url: string, type: string, name: string, mime: string, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("client_chat_id", "555"); fd.set("business_connection_id", "bc1"); fd.set("msg_type", type);
    Object.entries(extra).forEach(([k, v]) => fd.set(k, v));
    fd.set("file", new Blob([new Uint8Array([1, 2, 3, 4])], { type: mime }), name);
    return fetch(`${url}/crm-webhook/reply-file`, { method: "POST", headers: H, body: fd });
  };

  it("fayl yuborish: tur bo'yicha to'g'ri metod, izoh va file_id", async () => {
    const bot = fakeBot();
    const s = await listen(bot);

    let r = await upload(s.url, "photo", "a.jpg", "image/jpeg", { text: "izoh" });
    expect(await r.json()).toEqual({ ok: true, message_id: 102, file_id: "PBIG" });
    expect(bot.api.sendPhoto).toHaveBeenCalledOnce();
    const [chat, input, opts] = bot.api.sendPhoto.mock.calls[0] as any[];
    expect(chat).toBe(555);
    expect(opts).toEqual({ business_connection_id: "bc1", caption: "izoh" });
    expect(input.constructor.name).toBe("InputFile");

    r = await upload(s.url, "voice", "voice.ogg", "audio/ogg");
    expect((await r.json()).file_id).toBe("VOICE");
    expect(bot.api.sendVoice).toHaveBeenCalledOnce();
    expect((bot.api.sendVoice.mock.calls[0] as any[])[2]).toEqual({ business_connection_id: "bc1" });   // izohsiz

    await upload(s.url, "video", "v.mp4", "video/mp4");
    await upload(s.url, "audio", "s.mp3", "audio/mpeg");
    await upload(s.url, "document", "d.pdf", "application/pdf");
    await upload(s.url, "nomaʼlum", "x.bin", "application/octet-stream");
    expect(bot.api.sendVideo).toHaveBeenCalledOnce();
    expect(bot.api.sendAudio).toHaveBeenCalledOnce();
    expect(bot.api.sendDocument).toHaveBeenCalledTimes(2);          // hujjat + noma'lum tur
    await s.close();
  });

  it("fayl yuborishda maydonlar yetishmasa 400", async () => {
    const bot = fakeBot();
    const s = await listen(bot);
    const fd = new FormData();
    fd.set("client_chat_id", "555");
    const r = await fetch(`${s.url}/crm-webhook/reply-file`, { method: "POST", headers: H, body: fd });
    expect(r.status).toBe(400);
    await s.close();
  });
});
