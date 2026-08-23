import type { Store, ChatMessageRecord } from "../state/store.js";
import type { OrderRecord } from "../sheets/orders.js";
import type { PriceList } from "../sheets/priceList.js";
import { calculatePrice, type LineItem } from "../sheets/priceList.js";
import { computeStatus } from "../sheets/orders.js";
import type { AgentResponse, BuildContextInput } from "../ai/claude.js";
import type { DocumentExtraction, ReceiptExtraction } from "../ai/gemini.js";
import { resolveTargetOrder } from "./orderId.js";
import { formatEscalationNotice, formatPaidOrderNotice } from "./escalation.js";
import { logger } from "../utils/logger.js";

export type IncomingKind = "text" | "voice" | "photo" | "document";

export interface IncomingMessage {
  updateId: number;
  clientUserId: string;
  clientName: string;
  businessConnectionId: string;
  clientChatId: number;
  kind: IncomingKind;
  text?: string;
  caption?: string;
  fileId?: string;
  fileBuffer?: Buffer;
  fileMimeType?: string;
  fileName?: string;
  looksLikeReceipt?: boolean;
}

export interface WorkChatSendResult {
  messageId: number;
}

export interface HandleMessageDeps {
  spreadsheetId: string;
  sheets: {
    isExcluded(userId: string): Promise<boolean>;
    findOpenOrdersForClient(userId: string): Promise<{ order: OrderRecord; rowIndex1Based: number }[]>;
    findOrderById(orderId: string): Promise<{ order: OrderRecord; rowIndex1Based: number } | null>;
    generateOrderId(): Promise<string>;
    createOrder(order: OrderRecord): Promise<void>;
    updateOrder(rowIndex1Based: number, order: OrderRecord): Promise<void>;
  };
  ai: {
    transcribeVoice(buffer: Buffer, mimeType?: string): Promise<string>;
    extractDocument(buffer: Buffer, mimeType: string): Promise<DocumentExtraction>;
    extractReceipt(buffer: Buffer, mimeType: string): Promise<ReceiptExtraction>;
    callAgent(
      context: BuildContextInput,
      latestClientMessage: string,
      agentProfile?: string
    ): Promise<AgentResponse>;
    resolveWithStaffInput(
      context: BuildContextInput,
      staffInstruction: string,
      agentProfile?: string
    ): Promise<AgentResponse>;
  };
  drive: {
    uploadClientFile(
      clientUserId: string,
      orderId: string,
      fileName: string,
      buffer: Buffer,
      mimeType: string
    ): Promise<{ fileId: string; webViewLink: string }>;
  };
  telegram: {
    sendToClient(text: string): Promise<void>;
    sendToClientDirect(businessConnectionId: string, chatId: number, text: string): Promise<void>;
    notifyWorkChat(text: string): Promise<WorkChatSendResult | null>;
    logToChannel(text: string): Promise<void>;
  };
  store: Store;
  priceList: PriceList;
  agentProfile: string;
  prepaymentPercent: number;
  standardTurnaroundDays: number;
}

const CYRILLIC_RE = /[Ѐ-ӿ]/;
const CLIENT_TECHNICAL_FAILURE_REPLY =
  "Kechirasiz, hozir texnik nosozlik yuz berdi. Tez orada xodimlarimiz siz bilan bog'lanadi.";
const LATIN_RULE_FAILURE_REPLY =
  "Kechirasiz, hozir javobni aniqlashtirib olamiz. Xodimlarimiz tez orada siz bilan bog'lanadi.";
const clientQueues = new Map<string, Promise<void>>();

export function chatKeyFor(clientUserId: string): string {
  return `client:${clientUserId}`;
}

export function containsCyrillic(text: string): boolean {
  return CYRILLIC_RE.test(text);
}

export function cyrillicToLatinUzbek(text: string): string {
  if (!containsCyrillic(text)) return text;
  const map: Record<string, string> = {
    'А': 'A', 'а': 'a', 'Б': 'B', 'б': 'b', 'В': 'V', 'в': 'v',
    'Г': 'G', 'г': 'g', 'Ғ': "G'", 'ғ': "g'", 'Д': 'D', 'д': 'd',
    'Е': 'E', 'е': 'e', 'Ё': 'Yo', 'ё': 'yo', 'Ж': 'J', 'ж': 'j',
    'З': 'Z', 'з': 'z', 'И': 'I', 'и': 'i', 'Й': 'Y', 'й': 'y',
    'К': 'K', 'к': 'k', 'Қ': 'Q', 'қ': 'q', 'Л': 'L', 'л': 'l',
    'М': 'M', 'м': 'm', 'Н': 'N', 'н': 'n', 'О': 'O', 'о': 'o',
    'Ў': "O'", 'ў': "o'", 'П': 'P', 'п': 'p', 'Р': 'R', 'р': 'r',
    'С': 'S', 'с': 's', 'Т': 'T', 'т': 't', 'У': 'U', 'у': 'u',
    'Ф': 'F', 'ф': 'f', 'Х': 'X', 'х': 'x', 'Ҳ': 'H', 'ҳ': 'h',
    'Ц': 'Ts', 'ц': 'ts', 'Ч': 'Ch', 'ч': 'ch', 'Ш': 'Sh', 'ш': 'sh',
    'Щ': 'Sh', 'щ': 'sh', 'Ъ': "'", 'ъ': "'", 'Ь': '', 'ь': '',
    'Э': 'E', 'э': 'e', 'Ю': 'Yu', 'ю': 'yu', 'Я': 'Ya', 'я': 'ya',
  };
  return text.split('').map((char) => map[char] ?? char).join('');
}

/**
 * Telegram sends (client reply, work-chat notice, log-channel copy) must not cascade:
 * a misconfigured WORK_CHAT_ID or a channel the bot got removed from must never stop
 * the client's reply from going out, the escalation from being recorded locally, or
 * the update from being marked processed. Each send is isolated and logged on failure
 * instead of throwing.
 */
export async function safeSend<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err }, `Telegram send failed (${label}) - continuing`);
    return null;
  }
}

async function failWithClientNotice(
  label: string,
  msg: IncomingMessage,
  deps: HandleMessageDeps,
  reason: string,
  clientReply: string = CLIENT_TECHNICAL_FAILURE_REPLY
): Promise<void> {
  await safeSend(`sendToClient(${label})`, () => deps.telegram.sendToClient(clientReply));
  await safeSend(`notifyWorkChat(${label})`, () =>
    deps.telegram.notifyWorkChat(
      formatEscalationNotice({
        clientName: msg.clientName,
        clientUserId: msg.clientUserId,
        reason,
        lastMessage: msg.text ?? msg.caption ?? `(${msg.kind} message)`,
      })
    )
  );
}

function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function displayTextFor(msg: IncomingMessage): string {
  return msg.text ?? msg.caption ?? `[${msg.kind}]`;
}

export async function handleMessage(msg: IncomingMessage, deps: HandleMessageDeps): Promise<void> {
  const queueKey = chatKeyFor(msg.clientUserId);
  const previous = clientQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => handleMessageCore(msg, deps));
  clientQueues.set(queueKey, current);
  try {
    await current;
  } finally {
    if (clientQueues.get(queueKey) === current) {
      clientQueues.delete(queueKey);
    }
  }
}

async function handleMessageCore(msg: IncomingMessage, deps: HandleMessageDeps): Promise<void> {
  const { store } = deps;

  if (store.hasProcessedUpdate(msg.updateId)) {
    logger.debug({ updateId: msg.updateId }, "Skipping already-processed update");
    return;
  }

  let excluded = false;
  try {
    excluded = await deps.sheets.isExcluded(msg.clientUserId);
  } catch (err) {
    logger.error({ err, updateId: msg.updateId, clientUserId: msg.clientUserId }, "Failed to check excluded list");
    await failWithClientNotice(
      "excluded check failure",
      msg,
      deps,
      "Google Sheets excluded-list check failed"
    );
    store.markUpdateProcessed(msg.updateId);
    return;
  }
  if (excluded) {
    logger.info({ clientUserId: msg.clientUserId }, "Client excluded, logging only");
    store.markUpdateProcessed(msg.updateId);
    return;
  }

  const chatKey = chatKeyFor(msg.clientUserId);

  // Paused (pending human escalation): log what the client says so nothing is lost,
  // but never auto-reply and never re-escalate until a staff member resolves it.
  if (store.isPaused(chatKey)) {
    store.appendMessage(chatKey, {
      role: "client",
      text: displayTextFor(msg),
      timestamp: Date.now(),
    });
    logger.info({ clientUserId: msg.clientUserId }, "Client is paused pending escalation - logging only");
    store.markUpdateProcessed(msg.updateId);
    return;
  }

  let extractedText: string | null = null;
  let receiptExtraction: ReceiptExtraction | null = null;
  let uploadedLink: string | null = null;

  let openOrdersRaw: { order: OrderRecord; rowIndex1Based: number }[];
  try {
    openOrdersRaw = await deps.sheets.findOpenOrdersForClient(msg.clientUserId);
  } catch (err) {
    logger.error({ err, updateId: msg.updateId, clientUserId: msg.clientUserId }, "Failed to load open orders");
    await failWithClientNotice(
      "open orders failure",
      msg,
      deps,
      "Google Sheets open-order lookup failed"
    );
    store.markUpdateProcessed(msg.updateId);
    return;
  }
  const openOrders = openOrdersRaw.map((o) => o.order);

  try {
    if (msg.kind === "voice" && msg.fileBuffer) {
      extractedText = await deps.ai.transcribeVoice(msg.fileBuffer, msg.fileMimeType);
    } else if ((msg.kind === "photo" || msg.kind === "document") && msg.fileBuffer && msg.fileMimeType) {
      const folderOrderId = openOrders.length === 1 ? openOrders[0]!.order_id : "inbox";
      try {
        const uploaded = await deps.drive.uploadClientFile(
          msg.clientUserId,
          folderOrderId,
          msg.fileName ?? `file_${Date.now()}`,
          msg.fileBuffer,
          msg.fileMimeType
        );
        uploadedLink = uploaded.webViewLink;
      } catch (err) {
        logger.error({ err, updateId: msg.updateId }, "Drive upload failed");
        await failWithClientNotice(
          "drive failure",
          msg,
          deps,
          "Google Drive upload failed",
          "Kechirasiz, faylni hozircha saqlay olmadim. Xodimlarimiz xabardor bo'ladi."
        );
        store.markUpdateProcessed(msg.updateId);
        return;
      }

      if (msg.looksLikeReceipt) {
        receiptExtraction = await deps.ai.extractReceipt(msg.fileBuffer, msg.fileMimeType);
        extractedText = `[Payment receipt] ${JSON.stringify(receiptExtraction)} (file: ${uploadedLink})`;
      } else {
        const doc = await deps.ai.extractDocument(msg.fileBuffer, msg.fileMimeType);
        extractedText = `[Document] ${JSON.stringify(doc)} (file: ${uploadedLink})`;
      }
    }
  } catch (err) {
    logger.error({ err, updateId: msg.updateId }, "Gemini extraction failed");
    await safeSend("sendToClient(gemini failure)", () =>
      deps.telegram.sendToClient(
        "Kechirasiz, faylni hozircha o'qiy olmadim. Birozdan so'ng qayta urinib ko'raman, xodimlarimiz ham xabardor bo'ladi."
      )
    );
    await safeSend("notifyWorkChat(gemini failure)", () =>
      deps.telegram.notifyWorkChat(
        formatEscalationNotice({
          clientName: msg.clientName,
          clientUserId: msg.clientUserId,
          reason: "Gemini extraction failed (provider unavailable or error)",
          lastMessage: msg.text ?? msg.caption ?? "(file message)",
        })
      )
    );
    store.markUpdateProcessed(msg.updateId);
    return;
  }

  const latestClientMessage = msg.text ?? msg.caption ?? "(fayl yuborildi)";

  const context: BuildContextInput = {
    priceList: deps.priceList,
    history: store.getConversation(chatKey),
    openOrders,
    extractedText,
    prepaymentPercent: deps.prepaymentPercent,
    standardTurnaroundDays: deps.standardTurnaroundDays,
  };

  let agentResponse: AgentResponse;
  try {
    agentResponse = await deps.ai.callAgent(context, latestClientMessage, deps.agentProfile);
  } catch (err) {
    logger.error({ err, updateId: msg.updateId }, "Claude call failed");
    await safeSend("sendToClient(claude failure)", () =>
      deps.telegram.sendToClient(
        "Kechirasiz, hozir texnik nosozlik yuz berdi. Tez orada xodimlarimiz siz bilan bog'lanadi."
      )
    );
    await safeSend("notifyWorkChat(claude failure)", () =>
      deps.telegram.notifyWorkChat(
        formatEscalationNotice({
          clientName: msg.clientName,
          clientUserId: msg.clientUserId,
          reason: "Claude call failed (provider unavailable or error)",
          lastMessage: latestClientMessage,
        })
      )
    );
    store.markUpdateProcessed(msg.updateId);
    return;
  }

  let skipOrderUpdate = false;
  if (containsCyrillic(agentResponse.clientReplyUz)) {
    logger.warn(
      "Agent reply violated Uzbek-Latin-only rule (Cyrillic detected)"
    );
    agentResponse = {
      clientReplyUz: LATIN_RULE_FAILURE_REPLY,
      escalate: true,
      escalationReason: "Claude generated a Cyrillic client reply despite the Latin-only rule",
      orderUpdate: null,
    };
    skipOrderUpdate = true;
  }

  await safeSend("sendToClient", () => deps.telegram.sendToClient(agentResponse.clientReplyUz));
  await safeSend("logToChannel", () =>
    deps.telegram.logToChannel(
      `-> ${msg.clientName} (${msg.clientUserId}):\n${agentResponse.clientReplyUz}`
    )
  );

  const clientRecord: ChatMessageRecord = {
    role: "client",
    text: latestClientMessage,
    timestamp: Date.now(),
  };
  const agentRecord: ChatMessageRecord = {
    role: "agent",
    text: agentResponse.clientReplyUz,
    timestamp: Date.now(),
  };
  store.appendMessage(chatKey, clientRecord);
  store.appendMessage(chatKey, agentRecord);

  try {
    if (!skipOrderUpdate && agentResponse.orderUpdate) {
      await applyOrderUpdate(
        { clientUserId: msg.clientUserId, clientName: msg.clientName },
        agentResponse.orderUpdate,
        openOrders,
        uploadedLink,
        deps
      );
    }

    if (agentResponse.escalate) {
      store.setPendingEscalation(chatKey, agentResponse.escalationReason ?? "unspecified", {
        clientUserId: msg.clientUserId,
        clientName: msg.clientName,
        businessConnectionId: msg.businessConnectionId,
        clientChatId: msg.clientChatId,
      });
      const sent = await safeSend("notifyWorkChat(escalate)", () =>
        deps.telegram.notifyWorkChat(
          formatEscalationNotice({
            clientName: msg.clientName,
            clientUserId: msg.clientUserId,
            reason: agentResponse.escalationReason ?? "unspecified",
            lastMessage: latestClientMessage,
          })
        )
      );
      if (sent) {
        store.linkEscalationWorkMessage(chatKey, sent.messageId);
      }
    }
  } catch (err) {
    logger.error({ err, updateId: msg.updateId }, "Order update / escalation step failed");
    await failWithClientNotice(
      "post-reply state update failure",
      msg,
      deps,
      "Order update or escalation persistence failed after Claude reply"
    );
  } finally {
    store.markUpdateProcessed(msg.updateId);
  }
}

export async function applyOrderUpdate(
  client: { clientUserId: string; clientName: string },
  orderUpdate: NonNullable<AgentResponse["orderUpdate"]>,
  openOrders: OrderRecord[],
  uploadedLink: string | null,
  deps: HandleMessageDeps
): Promise<void> {
  const target = resolveTargetOrder(orderUpdate.existingOrderId, openOrders);

  if (target) {
    const found = await deps.sheets.findOrderById(target.order_id);
    if (!found) return;
    const updated: OrderRecord = { ...found.order };
    if (orderUpdate.paymentConfirmed && updated.prepayment_status !== "received") {
      updated.prepayment_status = "received";
      if (updated.status === "awaiting_prepayment" || updated.status === "new") {
        updated.status = "in_progress";
      }
      await deps.sheets.updateOrder(found.rowIndex1Based, updated);
      await safeSend("notifyWorkChat(paid, existing order)", () =>
        deps.telegram.notifyWorkChat(
          formatPaidOrderNotice({
            orderId: updated.order_id,
            clientName: client.clientName,
            total: Number(updated.total_price) || 0,
            currency: deps.priceList.currency,
          })
        )
      );
    }
    if (uploadedLink) {
      updated.document_files_links = updated.document_files_links
        ? `${updated.document_files_links}, ${uploadedLink}`
        : uploadedLink;
      await deps.sheets.updateOrder(found.rowIndex1Based, updated);
    }
    return;
  }

  if (orderUpdate.lineItems.length === 0) return;

  const items: LineItem[] = orderUpdate.lineItems.map((li) => ({
    serviceType: li.serviceType,
    quantity: li.quantity,
    translationTier: li.translationTier,
    translationPurpose: li.translationPurpose ?? null,
    apostilleDocType: li.apostilleDocType,
  }));
  const priced = calculatePrice(deps.priceList, items, deps.prepaymentPercent);

  const orderId = await deps.sheets.generateOrderId();
  const now = new Date();
  const { deadlineDate } = computeStatus(todayIso(now), deps.standardTurnaroundDays, now);

  const serviceTypes = [...new Set(items.map((i) => i.serviceType))].join("+");
  const sourceLangs = [...new Set(orderUpdate.lineItems.map((i) => i.sourceLang).filter(Boolean))];
  const targetLangs = [...new Set(orderUpdate.lineItems.map((i) => i.targetLang).filter(Boolean))];

  const order: OrderRecord = {
    order_id: orderId,
    client_user_id: client.clientUserId,
    client_name: orderUpdate.clientName ?? client.clientName,
    phone: orderUpdate.phone ?? "",
    service_type: serviceTypes,
    documents_description: orderUpdate.documentsDescription ?? "",
    document_files_links: uploadedLink ?? "",
    source_lang: sourceLangs.join(",") || "uz",
    target_lang: targetLangs.join(",") || "en",
    urgency: orderUpdate.urgency ?? "",
    quantity: String(items.reduce((s, i) => s + i.quantity, 0)),
    unit_price: priced.items.map((i) => i.unitPrice).join(","),
    total_price: String(priced.total),
    prepayment_status: orderUpdate.paymentConfirmed ? "received" : "pending",
    payment_screenshot_link: orderUpdate.paymentConfirmed ? uploadedLink ?? "" : "",
    order_date: todayIso(now),
    deadline_date: deadlineDate.toISOString().slice(0, 10),
    status: orderUpdate.paymentConfirmed ? "in_progress" : "awaiting_prepayment",
    delivery_method: orderUpdate.deliveryMethod ?? "",
    notes: orderUpdate.notes ?? "",
  };

  await deps.sheets.createOrder(order);

  if (orderUpdate.paymentConfirmed) {
    await safeSend("notifyWorkChat(paid, new order)", () =>
      deps.telegram.notifyWorkChat(
        formatPaidOrderNotice({
          orderId: order.order_id,
          clientName: order.client_name,
          total: priced.total,
          currency: deps.priceList.currency,
        })
      )
    );
  } else {
    await safeSend("notifyWorkChat(new order, unpaid)", () =>
      deps.telegram.notifyWorkChat(
        `🆕 Yangi buyurtma yaratildi: ${order.order_id} (${order.client_name}) — to'lov kutilmoqda.`
      )
    );
  }
}
