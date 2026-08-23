import type { BuildContextInput } from "../ai/claude.js";
import type { OrderRecord } from "../sheets/orders.js";
import { logger } from "../utils/logger.js";
import { applyOrderUpdate, containsCyrillic, cyrillicToLatinUzbek, safeSend, type HandleMessageDeps } from "./handleMessage.js";

export type ResolveResult = { ok: true; clientName: string } | { ok: false; error: string };

/**
 * Способ А: a staff member replied directly to the escalation notice in the work chat.
 * Their reply text becomes an instruction for Claude to phrase a natural client-facing
 * message (in the agent's usual tone) - the agent never invents its own resolution to an
 * escalated situation, but a human-approved one is voiced through it. Includes the full
 * conversation history, so any messages the client sent while paused are accounted for.
 */
export async function resolveEscalationViaStaffReply(
  chatKey: string,
  staffInstruction: string,
  deps: HandleMessageDeps
): Promise<ResolveResult> {
  const { store } = deps;
  const pending = store.getPendingEscalation(chatKey);
  if (!pending) {
    return { ok: false, error: "Bu xabar hech qanday faol eskalatsiyaga bog'liq emas." };
  }

  let openOrdersRaw: { order: OrderRecord; rowIndex1Based: number }[];
  try {
    openOrdersRaw = await deps.sheets.findOpenOrdersForClient(pending.clientUserId);
  } catch (err) {
    logger.error({ err, chatKey }, "Failed to load open orders during staff resolution");
    return { ok: false, error: "Google Sheets buyurtmalarini o'qib bo'lmadi. Qaytadan urinib ko'ring." };
  }
  const openOrders = openOrdersRaw.map((o) => o.order);

  const context: BuildContextInput = {
    priceList: deps.priceList,
    history: store.getConversation(chatKey),
    openOrders,
    extractedText: null,
    prepaymentPercent: deps.prepaymentPercent,
    standardTurnaroundDays: deps.standardTurnaroundDays,
  };

  let agentResponse;
  try {
    agentResponse = await deps.ai.resolveWithStaffInput(context, staffInstruction, deps.agentProfile);
  } catch (err) {
    logger.error({ err, chatKey }, "Failed to generate staff-resolved reply");
    return { ok: false, error: "Claude chaqiruvi muvaffaqiyatsiz tugadi. Qaytadan urinib ko'ring." };
  }

  if (containsCyrillic(agentResponse.clientReplyUz)) {
    logger.warn("Staff-resolved reply violated Uzbek-Latin-only rule (Cyrillic detected)");
    return { ok: false, error: "Claude lotin yozuvida javob qaytarmadi. Qaytadan urinib ko'ring." };
  }

  const sentToClient = await safeSend("sendToClientDirect(resolve)", () =>
    deps.telegram.sendToClientDirect(
      pending.businessConnectionId,
      pending.clientChatId,
      agentResponse.clientReplyUz
    )
  );
  if (sentToClient === null) {
    return { ok: false, error: "Mijozga xabar yuborilmadi. Pauza saqlanib qoldi." };
  }
  await safeSend("logToChannel(resolve)", () =>
    deps.telegram.logToChannel(
      `-> ${pending.clientName} (${pending.clientUserId}) [staff-resolved]:\n${agentResponse.clientReplyUz}`
    )
  );

  store.appendMessage(chatKey, {
    role: "agent",
    text: agentResponse.clientReplyUz,
    timestamp: Date.now(),
  });

  if (agentResponse.orderUpdate) {
    try {
      await applyOrderUpdate(
        { clientUserId: pending.clientUserId, clientName: pending.clientName },
        agentResponse.orderUpdate,
        openOrders,
        null,
        deps
      );
    } catch (err) {
      logger.error({ err, chatKey }, "Order update failed during staff-resolved reply");
    }
  }

  store.clearPendingEscalation(chatKey);
  return { ok: true, clientName: pending.clientName };
}

/**
 * Способ Б: staff handled the client directly (outside the bot) and just wants the pause
 * lifted, with nothing sent to the client. Accepts either the client's user id or an
 * order_id belonging to them. Any messages the client sent while paused stay in history
 * and are picked up naturally the next time the bot responds to them.
 */
export async function resolveEscalationManually(
  identifier: string,
  deps: HandleMessageDeps
): Promise<ResolveResult> {
  const { store } = deps;

  let found = store.findEscalationByClientUserId(identifier);

  if (!found) {
    let order;
    try {
      order = await deps.sheets.findOrderById(identifier);
    } catch (err) {
      logger.error({ err, identifier }, "Failed to look up order during manual resolution");
      return { ok: false, error: "Google Sheets buyurtmasini o'qib bo'lmadi. Qaytadan urinib ko'ring." };
    }
    if (order) {
      found = store.findEscalationByClientUserId(order.order.client_user_id);
    }
  }

  if (!found) {
    return { ok: false, error: `"${identifier}" uchun faol pauza topilmadi.` };
  }

  store.clearPendingEscalation(found.chatKey);
  return { ok: true, clientName: found.escalation.clientName };
}
