import { Bot } from "grammy";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { handleMessage } from "../pipeline/handleMessage.js";
import { resolveEscalationViaStaffReply, resolveEscalationManually } from "../pipeline/resolveEscalation.js";
import { createTelegramPort, createGenericTelegramPort, sendBusinessMessage } from "./send.js";
import { downloadTelegramFile, looksLikeReceipt } from "./files.js";
import { parseCommandTarget, formatExcludedList } from "./commands.js";
import { addExcluded, removeExcluded, listExcluded } from "../sheets/excluded.js";
function toHandleMessageDeps(deps, telegram) {
    return {
        spreadsheetId: deps.spreadsheetId,
        sheets: deps.sheetsOps,
        ai: deps.aiOps,
        drive: deps.driveOps,
        telegram,
        store: deps.store,
        priceList: deps.priceList,
        agentProfile: deps.agentProfile,
        prepaymentPercent: deps.prepaymentPercent,
        standardTurnaroundDays: deps.standardTurnaroundDays,
    };
}
export function createBot(token, deps) {
    const bot = new Bot(token);
    const resolveDeps = toHandleMessageDeps(deps, createGenericTelegramPort(bot));
    bot.on("business_message", async (ctx) => {
        if (ctx.chat?.type !== "private")
            return;
        // Captured up front (both are plain context shortcuts, no network call) so a
        // fallback message can still reach the client even if something fails before
        // handleMessage's own internal Gemini/Claude error handling ever gets a chance to
        // run - e.g. a network blip while downloading a voice/photo file.
        const businessConnectionId = ctx.businessConnectionId;
        const clientChatId = ctx.chat.id;
        try {
            const conn = await ctx.getBusinessConnection();
            if (ctx.from?.id === conn.user.id) {
                // The business owner typed this themselves in the real Telegram app - not a
                // client message, do not run the agent on it.
                return;
            }
            if (!ctx.from)
                return;
            const msg = ctx.msg;
            const clientUserId = String(ctx.from.id);
            const clientName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") ||
                ctx.from.username ||
                clientUserId;
            const base = { updateId: ctx.update.update_id, clientUserId, clientName, businessConnectionId: businessConnectionId, clientChatId };
            let incoming;
            if (msg.voice) {
                const dl = await downloadTelegramFile((id) => bot.api.getFile(id), msg.voice.file_id, "audio/ogg", "voice.ogg");
                incoming = {
                    ...base,
                    kind: "voice",
                    fileBuffer: dl.buffer,
                    fileMimeType: dl.mimeType,
                    fileName: dl.fileName,
                };
            }
            else if (msg.photo && msg.photo.length > 0) {
                const largest = msg.photo[msg.photo.length - 1];
                const dl = await downloadTelegramFile((id) => bot.api.getFile(id), largest.file_id, "image/jpeg", "photo.jpg");
                incoming = {
                    ...base,
                    kind: "photo",
                    caption: msg.caption,
                    fileBuffer: dl.buffer,
                    fileMimeType: dl.mimeType,
                    fileName: dl.fileName,
                    looksLikeReceipt: looksLikeReceipt(msg.caption),
                };
            }
            else if (msg.document) {
                const dl = await downloadTelegramFile((id) => bot.api.getFile(id), msg.document.file_id, msg.document.mime_type ?? "application/octet-stream", msg.document.file_name ?? "document");
                incoming = {
                    ...base,
                    kind: "document",
                    caption: msg.caption,
                    fileBuffer: dl.buffer,
                    fileMimeType: dl.mimeType,
                    fileName: dl.fileName,
                    looksLikeReceipt: looksLikeReceipt(msg.caption),
                };
            }
            else {
                incoming = { ...base, kind: "text", text: msg.text ?? "" };
            }
            const telegramPort = createTelegramPort(bot, businessConnectionId, clientChatId);
            await handleMessage(incoming, toHandleMessageDeps(deps, telegramPort));
        }
        catch (err) {
            logger.error({ err }, "Unhandled error in business_message handler");
            // Everything inside handleMessage already degrades gracefully on its own
            // (Gemini/Claude failures get an apology + escalation). This catch only fires for
            // failures OUTSIDE that - e.g. a network blip while downloading a file, or
            // ctx.getBusinessConnection() itself failing - which would otherwise leave the
            // client with pure silence and no record of what happened.
            if (businessConnectionId) {
                await sendBusinessMessage(bot, clientChatId, businessConnectionId, "Kechirasiz, hozir texnik nosozlik yuz berdi. Tez orada xodimlarimiz siz bilan bog'lanadi.").catch((sendErr) => logger.error({ sendErr }, "Fallback client message also failed"));
            }
            if (env.WORK_CHAT_ID) {
                await bot.api
                    .sendMessage(env.WORK_CHAT_ID, `⚠️ ESKALATSIYA\nTexnik xatolik (business_message handler)\nclient chat_id: ${clientChatId}\nXato: ${err instanceof Error ? err.message : String(err)}`)
                    .catch((sendErr) => logger.error({ sendErr }, "Fallback work-chat notice also failed"));
            }
        }
    });
    registerWorkChatCommands(bot, deps);
    registerEscalationResolution(bot, resolveDeps);
    return bot;
}
function isFromWorkChat(chatId) {
    if (!env.WORK_CHAT_ID)
        return false;
    return String(chatId) === env.WORK_CHAT_ID;
}
/**
 * Способ Б: staff resolved the client directly (outside the bot) and just wants the
 * pause lifted - /resolved <order_id or client_id>, no reply needed to trigger it.
 */
function registerResolvedCommand(bot, resolveDeps) {
    bot.command("resolved", async (ctx) => {
        if (!isFromWorkChat(ctx.chat.id))
            return;
        const identifier = (ctx.match ?? "").trim();
        if (!identifier) {
            await ctx.reply("Foydalanish: /resolved <order_id yoki client_id>");
            return;
        }
        const result = await resolveEscalationManually(identifier, resolveDeps);
        if (result.ok) {
            await ctx.reply(`✅ Pauza olib tashlandi: ${result.clientName}`);
        }
        else {
            await ctx.reply(`❌ ${result.error}`);
        }
    });
}
/**
 * Способ А: staff replies directly to the escalation notice in the work chat with the
 * text to relay. Only fires for a genuine reply to a message we recognize as an active
 * escalation notice - any other reply (or plain chatter) in the work chat is ignored.
 */
function registerEscalationResolution(bot, resolveDeps) {
    registerResolvedCommand(bot, resolveDeps);
    bot.on("message:text", async (ctx) => {
        if (!isFromWorkChat(ctx.chat.id))
            return;
        const replyTo = ctx.msg.reply_to_message;
        if (!replyTo)
            return;
        const found = resolveDeps.store.findEscalationByWorkMessageId(replyTo.message_id);
        if (!found)
            return;
        const result = await resolveEscalationViaStaffReply(found.chatKey, ctx.msg.text, resolveDeps);
        if (result.ok) {
            await ctx.reply(`✅ Mijozga yuborildi, pauza olib tashlandi: ${result.clientName}`);
        }
        else {
            await ctx.reply(`❌ ${result.error}`);
        }
    });
}
function registerWorkChatCommands(bot, deps) {
    bot.command("exclude", async (ctx) => {
        if (!isFromWorkChat(ctx.chat.id))
            return;
        const target = parseCommandTarget(ctx.match ?? "");
        if (!target) {
            await ctx.reply("Foydalanish: /exclude @username yoki /exclude user_id");
            return;
        }
        let userId = target.value;
        let username = target.type === "username" ? target.value : "";
        if (target.type === "username") {
            try {
                const chat = await bot.api.getChat(`@${target.value}`);
                userId = String(chat.id);
            }
            catch (err) {
                logger.warn({ err, username: target.value }, "Could not resolve username to id");
                await ctx.reply("Username orqali user_id'ni topa olmadim. Iltimos, raqamli user_id yuboring.");
                return;
            }
        }
        await addExcluded(deps.spreadsheetId, {
            user_id: userId,
            username,
            added_by: String(ctx.from?.id ?? "unknown"),
            date_added: new Date().toISOString(),
            reason: "manual /exclude",
        });
        await ctx.reply(`Istisnolarga qo'shildi: ${username ? "@" + username : userId}`);
    });
    bot.command("include", async (ctx) => {
        if (!isFromWorkChat(ctx.chat.id))
            return;
        const target = parseCommandTarget(ctx.match ?? "");
        if (!target) {
            await ctx.reply("Foydalanish: /include @username yoki /include user_id");
            return;
        }
        if (target.type === "username") {
            const all = await listExcluded(deps.spreadsheetId);
            const found = all.find((r) => r.username === target.value);
            if (!found) {
                await ctx.reply("Bu username istisnolar ro'yxatida topilmadi.");
                return;
            }
            await removeExcluded(deps.spreadsheetId, found.user_id);
        }
        else {
            await removeExcluded(deps.spreadsheetId, target.value);
        }
        await ctx.reply("Istisnolardan olib tashlandi.");
    });
    bot.command("list_excluded", async (ctx) => {
        if (!isFromWorkChat(ctx.chat.id))
            return;
        const all = await listExcluded(deps.spreadsheetId);
        await ctx.reply(formatExcludedList(all));
    });
}
//# sourceMappingURL=bot.js.map