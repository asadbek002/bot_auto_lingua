import type { Bot } from "grammy";
import { GrammyError } from "grammy";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { HandleMessageDeps } from "../pipeline/handleMessage.js";

const BUSINESS_SEND_RETRIES = 3;
let BUSINESS_SEND_RETRY_DELAY_MS = 2000;
/** Faqat testlar uchun: qayta urinish kutish vaqtini qisqartirish. */
export function _setBusinessRetryDelay(ms: number): void {
  BUSINESS_SEND_RETRY_DELAY_MS = ms;
}

function isBusinessPeerInvalid(err: unknown): boolean {
  return err instanceof GrammyError && err.description?.includes("BUSINESS_PEER_INVALID");
}

/**
 * Telegram Business Connections intermittently reject sends with BUSINESS_PEER_INVALID even for a
 * peer that just worked (and that works again moments later) - confirmed transient. Retry a few
 * times before giving up. Works for any send method (text, photo, voice, document...).
 */
export async function withBusinessRetry<T>(fn: () => Promise<T>, chatId: number, delayMs?: number): Promise<T> {
  const delay = delayMs ?? BUSINESS_SEND_RETRY_DELAY_MS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= BUSINESS_SEND_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isBusinessPeerInvalid(err) || attempt === BUSINESS_SEND_RETRIES) throw err;
      logger.warn({ attempt, chatId }, "BUSINESS_PEER_INVALID (transient Telegram issue) - retrying send");
      await new Promise((resolve) => setTimeout(resolve, delay * attempt));
    }
  }
  throw lastErr;
}

export async function sendBusinessMessage(
  bot: { api: Pick<Bot["api"], "sendMessage"> },
  chatId: number,
  businessConnectionId: string,
  text: string
) {
  return withBusinessRetry(
    () => bot.api.sendMessage(chatId, text, { business_connection_id: businessConnectionId }),
    chatId
  );
}

/**
 * Not bound to a specific client chat - used for the escalation-resolution flow, where
 * the target client is only known at resolve time (from stored pause metadata), not from
 * the message currently being handled.
 */
export function createGenericTelegramPort(bot: Bot): HandleMessageDeps["telegram"] {
  return {
    async sendToClient() {
      throw new Error("sendToClient is not available on the generic port - use sendToClientDirect");
    },
    async sendToClientDirect(businessConnectionId: string, chatId: number, text: string) {
      await sendBusinessMessage(bot, chatId, businessConnectionId, text);
    },
    async notifyWorkChat(text: string) {
      if (!env.WORK_CHAT_ID) return null;
      const sent = await bot.api.sendMessage(env.WORK_CHAT_ID, text);
      return { messageId: sent.message_id };
    },
    async logToChannel(text: string) {
      if (!env.LOG_CHANNEL_ID) return;
      await bot.api.sendMessage(env.LOG_CHANNEL_ID, text);
    },
  };
}

export function createTelegramPort(
  bot: Bot,
  businessConnectionId: string,
  clientChatId: number
): HandleMessageDeps["telegram"] {
  return {
    ...createGenericTelegramPort(bot),
    async sendToClient(text: string) {
      await sendBusinessMessage(bot, clientChatId, businessConnectionId, text);
    },
  };
}
