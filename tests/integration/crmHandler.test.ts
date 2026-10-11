import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/config/env.js";
import { configureCrmBridge, getOutbox } from "../../src/telegram/crmBridge.js";
import { handleCrmBusinessMessage, handleCrmDeleted, isFromOwner, type CrmCtx } from "../../src/telegram/crmHandlers.js";
import { Outbox } from "../../src/telegram/outbox.js";
import { startFakeApi } from "../helpers/fakeApi.js";

let dir: string;
let api: Awaited<ReturnType<typeof startFakeApi>>;
const processed = new Set<number>();
const store = {
  hasProcessedUpdate: (id: number) => processed.has(id),
  markUpdateProcessed: (id: number) => { processed.add(id); },
};
const alert = vi.fn(async () => undefined);
const deps = { store, alert };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "crmh-"));
  configureCrmBridge({ outbox: new Outbox(path.join(dir, "o.json")), notify: alert });
  processed.clear();
  alert.mockClear();
  api = await startFakeApi(200);
  env.LINGUA_MANAGER_API_URL = api.url;
});
afterEach(async () => {
  await api.close().catch(() => undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

const CLIENT = { id: 777, first_name: "Ali", last_name: "Valiyev", username: "ali_v" };
const OWNER = { id: 1, first_name: "Egasi" };

function ctx(msg: Record<string, any>, over: Partial<CrmCtx> = {}, updateId = 1): CrmCtx {
  return {
    chat: { id: CLIENT.id, type: "private", first_name: CLIENT.first_name, last_name: CLIENT.last_name, username: CLIENT.username },
    from: CLIENT,
    msg: { message_id: 50, date: 1700000000, ...msg },
    businessConnectionId: "bc-1",
    update: { update_id: updateId },
    ...over,
  };
}

describe("CRM rejimi: business_message", () => {
  it("mijoz matni: tg ID, username va ulanish ID bilan, hech narsa yuklanmaydi", async () => {
    await handleCrmBusinessMessage(ctx({ text: "Assalomu aleykum" }), deps);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.path).toBe("/messages");
    expect(api.calls[0]!.body).toMatchObject({
      chat_id: "777", business_connection_id: "bc-1", client_name: "Ali Valiyev", client_username: "ali_v",
      message_type: "text", text: "Assalomu aleykum", direction: "incoming", tg_message_id: 50, timestamp: 1700000000, event: "message",
    });
  });

  it("egasining telefondan yozgan javobi 'chiquvchi' sifatida CRM ga boradi", async () => {
    const c = ctx({ text: "Narx 150 000" }, { from: OWNER });
    expect(isFromOwner(c)).toBe(true);
    await handleCrmBusinessMessage(c, deps);
    expect(api.calls[0]!.body).toMatchObject({
      direction: "outgoing", chat_id: "777", client_name: "Ali Valiyev", client_username: "ali_v", text: "Narx 150 000",
    });
  });

  it("katta fayl: faqat file_id uzatiladi — xabar yo'qolmaydi (yuklash yo'q)", async () => {
    await handleCrmBusinessMessage(ctx({ document: { file_id: "BIGDOC", file_name: "kitob.pdf", file_size: 90_000_000, mime_type: "application/pdf" }, caption: "diplom" }), deps);
    expect(api.calls[0]!.body).toMatchObject({ message_type: "document", file_id: "BIGDOC", file_name: "kitob.pdf", text: "diplom" });
  });

  it.each([
    ["video", { video: { file_id: "V1" } }, "video"],
    ["video_note", { video_note: { file_id: "VN" } }, "video_note"],
    ["sticker", { sticker: { file_id: "S", emoji: "👍" } }, "sticker"],
    ["audio", { audio: { file_id: "A", file_name: "a.mp3" } }, "audio"],
    ["location", { location: { latitude: 1, longitude: 2 } }, "location"],
    ["contact", { contact: { first_name: "X", phone_number: "+998" } }, "contact"],
    ["so'rovnoma", { poll: { question: "?" } }, "unknown"],
  ])("%s endi bo'sh matn emas, o'z turi bilan boradi", async (_n, msg, kind) => {
    await handleCrmBusinessMessage(ctx(msg), deps);
    const b = api.calls[0]!.body;
    expect(b.message_type).toBe(kind);
    expect(b.file_id || b.text).toBeTruthy();
  });

  it("takroriy update ikki marta yuborilmaydi", async () => {
    await handleCrmBusinessMessage(ctx({ text: "bir" }, {}, 9), deps);
    await handleCrmBusinessMessage(ctx({ text: "bir" }, {}, 9), deps);
    expect(api.calls).toHaveLength(1);
  });

  it("API o'chiq bo'lsa: xabar navbatda, mijozga hech narsa yozilmaydi, xato otilmaydi", async () => {
    await api.close();
    await expect(handleCrmBusinessMessage(ctx({ text: "muhim" }), deps)).resolves.toBeUndefined();
    expect(getOutbox().size()).toBe(1);
    expect(processed.has(1)).toBe(true);
    expect(alert).not.toHaveBeenCalled();                // darrov shovqin yo'q (10 daqiqadan keyin eslatadi)
  });

  it("tahrir voqeasi: event=edited", async () => {
    await handleCrmBusinessMessage(ctx({ text: "tuzatilgan" }), deps, "edited");
    expect(api.calls[0]!.body).toMatchObject({ event: "edited", tg_message_id: 50, text: "tuzatilgan" });
  });

  it("o'chirilgan xabarlar CRM ga yuboriladi", async () => {
    await handleCrmDeleted({ update: { update_id: 3 }, deletedBusinessMessages: { chat: { id: 777 }, message_ids: [50, 51], business_connection_id: "bc-1" } });
    expect(api.calls[0]).toMatchObject({ path: "/messages/deleted" });
    expect(api.calls[0]!.body).toEqual({ chat_id: "777", tg_message_ids: [50, 51] });
  });

  it("guruh yoki xizmat xabarlari e'tiborsiz", async () => {
    await handleCrmBusinessMessage(ctx({ text: "x" }, { chat: { id: -100, type: "supergroup" } }), deps);
    await handleCrmBusinessMessage({ update: { update_id: 4 } } as CrmCtx, deps);
    expect(api.calls).toHaveLength(0);
  });
});
