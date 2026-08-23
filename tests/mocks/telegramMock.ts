import type { HandleMessageDeps } from "../../src/pipeline/handleMessage.js";

export interface FakeTelegram {
  clientMessages: string[];
  workChatMessages: string[];
  workChatMessageIds: number[];
  logChannelMessages: string[];
  directMessages: { businessConnectionId: string; chatId: number; text: string }[];
  ops: HandleMessageDeps["telegram"];
}

export function createFakeTelegram(): FakeTelegram {
  const clientMessages: string[] = [];
  const workChatMessages: string[] = [];
  const workChatMessageIds: number[] = [];
  const logChannelMessages: string[] = [];
  const directMessages: { businessConnectionId: string; chatId: number; text: string }[] = [];
  let nextMessageId = 1000;

  const ops: HandleMessageDeps["telegram"] = {
    async sendToClient(text) {
      clientMessages.push(text);
    },
    async sendToClientDirect(businessConnectionId, chatId, text) {
      directMessages.push({ businessConnectionId, chatId, text });
      clientMessages.push(text);
    },
    async notifyWorkChat(text) {
      workChatMessages.push(text);
      const messageId = ++nextMessageId;
      workChatMessageIds.push(messageId);
      return { messageId };
    },
    async logToChannel(text) {
      logChannelMessages.push(text);
    },
  };

  return { clientMessages, workChatMessages, workChatMessageIds, logChannelMessages, directMessages, ops };
}
