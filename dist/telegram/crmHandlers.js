import { logger } from "../utils/logger.js";
import { describeMessage } from "./messageKinds.js";
import { forwardToCRM, sendToCrm } from "./crmBridge.js";
const fullName = (p, fallback = "") => [p?.first_name, p?.last_name].filter(Boolean).join(" ") || p?.username || fallback;
/**
 * Biznes-chatda chat.id = mijozning user id si. Xabar chat.id dan boshqa foydalanuvchidan bo'lsa — bu
 * biznes egasi (telefonidan yozgan). Tarmoq chaqiruvi (getBusinessConnection) kerak emas, shuning uchun
 * u xato bersa ham xabar yo'qolmaydi va mijozga hech narsa yozilmaydi.
 */
export function isFromOwner(ctx) {
    return !!ctx.from && !!ctx.chat && ctx.from.id !== ctx.chat.id;
}
function buildPayload(ctx, event) {
    const chat = ctx.chat;
    const msg = ctx.msg;
    if (!chat || !msg || !ctx.from)
        return null;
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
export async function handleCrmBusinessMessage(ctx, deps, event = "message") {
    if (ctx.chat?.type !== "private")
        return;
    const payload = buildPayload(ctx, event);
    if (!payload)
        return;
    // Takroriy update ni o'tkazib yuboramiz (Telegram qayta yuborishi mumkin); tahrir har safar o'tadi
    if (event === "message") {
        if (deps.store.hasProcessedUpdate(ctx.update.update_id))
            return;
    }
    try {
        await forwardToCRM(payload);
        deps.store.markUpdateProcessed(ctx.update.update_id);
    }
    catch (err) {
        logger.error({ err, chatId: payload.chat_id }, "CRM forward failed unexpectedly");
        await deps.alert?.(`⚠️ CRM ULANISH XATOLIGI\nChat: ${payload.chat_id}\n${err instanceof Error ? err.message : String(err)}`)?.catch?.(() => undefined);
    }
}
export async function handleCrmDeleted(ctx) {
    const d = ctx.deletedBusinessMessages;
    if (!d || !d.message_ids?.length)
        return;
    await sendToCrm("/messages/deleted", { chat_id: String(d.chat.id), tg_message_ids: d.message_ids });
}
//# sourceMappingURL=crmHandlers.js.map