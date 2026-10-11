import { logger } from "../utils/logger.js";
import { describeMessage } from "./messageKinds.js";
import { forwardToCRM, sendToCrm, type CrmPayload } from "./crmBridge.js";

/** grammy Context ning CRM uchun kerakli qismi (testlarda soxta ob'ekt beriladi). */
export interface CrmCtx {
  chat?: { id: number; type: string; first_name?: string; last_name?: string; username?: string };
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  msg?: Record<string, any> & { message_id: number; date?: number };
  businessConnectionId?: string;
  update: { update_id: number };
  deletedBusinessMessages?: { chat: { id: number }; message_ids: number[]; business_connection_id: string };
}

export interface CrmDeps {
  store: { hasProcessedUpdate(id: number): boolean; markUpdateProcessed(id: number): void };
  alert?: (text: string) => Promise<unknown>;
}

const fullName = (p?: { first_name?: string; last_name?: string; username?: string }, fallback = ""): string =>
  [p?.first_name, p?.last_name].filter(Boolean).join(" ") || p?.username || fallback;

/**
 * Biznes-chatda chat.id = mijozning user id si. Xabar chat.id dan boshqa foydalanuvchidan bo'lsa — bu
 * biznes egasi (telefonidan yozgan). Tarmoq chaqiruvi (getBusinessConnection) kerak emas, shuning uchun
 * u xato bersa ham xabar yo'qolmaydi va mijozga hech narsa yozilmaydi.
 */
export function isFromOwner(ctx: Pick<CrmCtx, "chat" | "from">): boolean {
  return !!ctx.from && !!ctx.chat && ctx.from.id !== ctx.chat.id;
}

function buildPayload(ctx: CrmCtx, event: "message" | "edited"): CrmPayload | null {
  const chat = ctx.chat;
  const msg = ctx.msg;
  if (!chat || !msg || !ctx.from) return null;
  const owner = isFromOwner(ctx);
  const d = describeMessage(msg);
  return {
    chat_id: String(chat.id),
    business_connection_id: ctx.businessConnectionId ?? "",
    client_user_id: String(chat.id),
    client_name: owner ? fullName(chat, String(chat.id)) : fullName(ctx.from, String(ctx.from.id)),
    client_username: (owner ? chat.username : ctx.from.username) ?? "",
    message_type: d.kind,
    text: d.text,
    file_id: d.fileId,
    file_name: d.fileName,
    file_mime_type: d.mimeType,
    direction: owner ? "outgoing" : "incoming",
    timestamp: msg.date ?? Math.floor(Date.now() / 1000),
    tg_message_id: msg.message_id,
    event,
  };
}

/** CRM rejimi: xabarni YUKLAMASDAN (faqat file_id) CRM ga uzatadi. Hech qachon mijozga xabar yozmaydi. */
export async function handleCrmBusinessMessage(ctx: CrmCtx, deps: CrmDeps, event: "message" | "edited" = "message"): Promise<void> {
  if (ctx.chat?.type !== "private") return;
  const payload = buildPayload(ctx, event);
  if (!payload) return;

  // Takroriy update ni o'tkazib yuboramiz (Telegram qayta yuborishi mumkin); tahrir har safar o'tadi
  if (event === "message") {
    if (deps.store.hasProcessedUpdate(ctx.update.update_id)) return;
  }
  try {
    await forwardToCRM(payload);
    deps.store.markUpdateProcessed(ctx.update.update_id);
  } catch (err) {
    logger.error({ err, chatId: payload.chat_id }, "CRM forward failed unexpectedly");
    await deps.alert?.(`⚠️ CRM ULANISH XATOLIGI\nChat: ${payload.chat_id}\n${err instanceof Error ? err.message : String(err)}`)?.catch?.(() => undefined);
  }
}

export async function handleCrmDeleted(ctx: CrmCtx): Promise<void> {
  const d = ctx.deletedBusinessMessages;
  if (!d || !d.message_ids?.length) return;
  await sendToCrm("/messages/deleted", { chat_id: String(d.chat.id), tg_message_ids: d.message_ids });
}
