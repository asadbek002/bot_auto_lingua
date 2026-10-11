/**
 * Telegram xabarini CRM uchun tavsiflaydi. Hech narsa yuklab olinmaydi — faqat file_id va metama'lumot.
 * Avval faqat voice/photo/document tanilar, qolgan hamma narsa (video, stiker, joylashuv...) bo'sh "matn"
 * bo'lib CRM ga ketardi; endi har bir tur o'z belgisi bilan boradi, noma'lum tur "unknown" va aniq matn bilan.
 */
export type CrmKind =
  | "text"
  | "photo"
  | "voice"
  | "audio"
  | "video"
  | "video_note"
  | "animation"
  | "sticker"
  | "document"
  | "location"
  | "contact"
  | "unknown";

export interface DescribedMessage {
  kind: CrmKind;
  text: string;
  fileId: string;
  fileName: string;
  mimeType: string;
}

// Kontent bo'lmagan xizmat maydonlari — "noma'lum tur"ni aniqlashda e'tiborga olinmaydi
const META_KEYS = new Set([
  "message_id", "date", "chat", "from", "business_connection_id", "sender_business_bot", "sender_chat",
  "forward_origin", "reply_to_message", "edit_date", "media_group_id", "entities", "caption_entities",
  "link_preview_options", "has_media_spoiler", "show_caption_above_media", "is_topic_message", "via_bot",
  "author_signature", "reply_markup", "external_reply", "quote", "story", "reply_to_story",
]);

type AnyMsg = Record<string, any>;

function empty(kind: CrmKind, text = ""): DescribedMessage {
  return { kind, text, fileId: "", fileName: "", mimeType: "" };
}

export function describeMessage(msg: AnyMsg): DescribedMessage {
  const caption: string = msg.caption ?? "";

  if (msg.voice) {
    return { kind: "voice", text: caption, fileId: msg.voice.file_id, fileName: "voice.ogg", mimeType: msg.voice.mime_type ?? "audio/ogg" };
  }
  if (msg.audio) {
    const a = msg.audio;
    const name = a.file_name ?? ([a.performer, a.title].filter(Boolean).join(" - ") || "audio") + ".mp3";
    return { kind: "audio", text: caption, fileId: a.file_id, fileName: name, mimeType: a.mime_type ?? "audio/mpeg" };
  }
  if (msg.video_note) {
    return { kind: "video_note", text: "", fileId: msg.video_note.file_id, fileName: "video_note.mp4", mimeType: "video/mp4" };
  }
  if (msg.video) {
    return { kind: "video", text: caption, fileId: msg.video.file_id, fileName: msg.video.file_name ?? "video.mp4", mimeType: msg.video.mime_type ?? "video/mp4" };
  }
  // GIF xabarida ham "document" maydoni bo'ladi — document dan OLDIN tekshiriladi
  if (msg.animation) {
    return { kind: "animation", text: caption, fileId: msg.animation.file_id, fileName: msg.animation.file_name ?? "animation.mp4", mimeType: msg.animation.mime_type ?? "video/mp4" };
  }
  if (msg.sticker) {
    const s = msg.sticker;
    const ext = s.is_animated ? "tgs" : s.is_video ? "webm" : "webp";
    const mime = s.is_animated ? "application/x-tgsticker" : s.is_video ? "video/webm" : "image/webp";
    return { kind: "sticker", text: s.emoji ?? "", fileId: s.file_id, fileName: `sticker.${ext}`, mimeType: mime };
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    return { kind: "photo", text: caption, fileId: largest.file_id, fileName: "photo.jpg", mimeType: "image/jpeg" };
  }
  if (msg.document) {
    return { kind: "document", text: caption, fileId: msg.document.file_id, fileName: msg.document.file_name ?? "document", mimeType: msg.document.mime_type ?? "application/octet-stream" };
  }
  if (msg.venue) {
    const v = msg.venue;
    return empty("location", `📍 ${v.title ?? ""} ${v.address ?? ""} https://maps.google.com/?q=${v.location?.latitude},${v.location?.longitude}`.replace(/\s+/g, " ").trim());
  }
  if (msg.location) {
    const { latitude, longitude } = msg.location;
    return empty("location", `📍 ${latitude}, ${longitude} https://maps.google.com/?q=${latitude},${longitude}`);
  }
  if (msg.contact) {
    const c = msg.contact;
    return empty("contact", `👤 ${[c.first_name, c.last_name].filter(Boolean).join(" ")} ${c.phone_number ?? ""}`.trim());
  }
  if (msg.poll) return empty("unknown", `📊 So'rovnoma: ${msg.poll.question ?? ""}`.trim());
  if (msg.dice) return empty("unknown", `🎲 ${msg.dice.emoji ?? ""} ${msg.dice.value ?? ""}`.trim());
  if (typeof msg.text === "string") return empty("text", msg.text);

  // Tanilmagan tur: bo'sh pufak emas — qaysi tur ekani yoziladi
  const key = Object.keys(msg).find((k) => !META_KEYS.has(k));
  return empty("unknown", caption || (key ? `[${key}]` : "[bo'sh xabar]"));
}
