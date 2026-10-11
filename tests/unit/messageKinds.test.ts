import { describe, expect, it } from "vitest";
import { describeMessage } from "../../src/telegram/messageKinds.js";

const base = { message_id: 1, date: 1, chat: { id: 5 }, from: { id: 5 } };

describe("describeMessage — Telegram xabar turlari", () => {
  it("matn", () => {
    expect(describeMessage({ ...base, text: "salom" })).toMatchObject({ kind: "text", text: "salom", fileId: "" });
  });

  it("rasm: eng katta o'lcham va izoh", () => {
    const d = describeMessage({ ...base, photo: [{ file_id: "s" }, { file_id: "BIG" }], caption: "pasport" });
    expect(d).toMatchObject({ kind: "photo", fileId: "BIG", text: "pasport", mimeType: "image/jpeg" });
  });

  it("ovoz va audio fayl", () => {
    expect(describeMessage({ ...base, voice: { file_id: "V", mime_type: "audio/ogg" } })).toMatchObject({ kind: "voice", fileId: "V", fileName: "voice.ogg" });
    expect(describeMessage({ ...base, audio: { file_id: "A", performer: "Ali", title: "Qo'shiq" } })).toMatchObject({ kind: "audio", fileName: "Ali - Qo'shiq.mp3" });
  });

  it("video, dumaloq video", () => {
    expect(describeMessage({ ...base, video: { file_id: "VD", file_name: "a.mp4" } })).toMatchObject({ kind: "video", fileId: "VD", fileName: "a.mp4" });
    expect(describeMessage({ ...base, video_note: { file_id: "VN" } })).toMatchObject({ kind: "video_note", fileId: "VN" });
  });

  it("GIF xabarida document ham bor — animation sifatida tanilishi kerak", () => {
    const d = describeMessage({ ...base, animation: { file_id: "G" }, document: { file_id: "G" } });
    expect(d.kind).toBe("animation");
  });

  it("stiker: emoji matn, turi bo'yicha kengaytma", () => {
    expect(describeMessage({ ...base, sticker: { file_id: "S", emoji: "😀" } })).toMatchObject({ kind: "sticker", text: "😀", fileName: "sticker.webp" });
    expect(describeMessage({ ...base, sticker: { file_id: "S", is_animated: true } }).fileName).toBe("sticker.tgs");
    expect(describeMessage({ ...base, sticker: { file_id: "S", is_video: true } }).fileName).toBe("sticker.webm");
  });

  it("hujjat nom va tur bilan", () => {
    expect(describeMessage({ ...base, document: { file_id: "D", file_name: "diplom.pdf", mime_type: "application/pdf" } }))
      .toMatchObject({ kind: "document", fileName: "diplom.pdf", mimeType: "application/pdf" });
  });

  it("joylashuv, joy (venue) va kontakt — matn sifatida", () => {
    expect(describeMessage({ ...base, location: { latitude: 41.3, longitude: 69.2 } }).text).toContain("41.3, 69.2");
    expect(describeMessage({ ...base, venue: { title: "Ofis", address: "Toshkent", location: { latitude: 1, longitude: 2 } } }))
      .toMatchObject({ kind: "location" });
    expect(describeMessage({ ...base, contact: { first_name: "Ali", phone_number: "+998901234567" } }))
      .toMatchObject({ kind: "contact", text: "👤 Ali +998901234567" });
  });

  it("noma'lum tur bo'sh bo'lib qolmaydi", () => {
    const poll = describeMessage({ ...base, poll: { question: "Qaysi?" } });
    expect(poll.kind).toBe("unknown");
    expect(poll.text).toContain("Qaysi?");
    const odd = describeMessage({ ...base, giveaway: { x: 1 } });
    expect(odd).toMatchObject({ kind: "unknown", text: "[giveaway]" });
    expect(describeMessage({ ...base }).text).toBe("[bo'sh xabar]");
  });
});
