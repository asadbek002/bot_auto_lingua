import { calculatePrice } from "../sheets/priceList.js";
import { computeStatus } from "../sheets/orders.js";
import { resolveTargetOrder } from "./orderId.js";
import { formatEscalationNotice, formatPaidOrderNotice } from "./escalation.js";
import { logger } from "../utils/logger.js";
const CYRILLIC_RE = /[Ѐ-ӿ]/;
const CLIENT_TECHNICAL_FAILURE_REPLY = "Kechirasiz, hozir texnik nosozlik yuz berdi. Tez orada xodimlarimiz siz bilan bog'lanadi.";
const LATIN_RULE_FAILURE_REPLY = "Kechirasiz, hozir javobni aniqlashtirib olamiz. Xodimlarimiz tez orada siz bilan bog'lanadi.";
const clientQueues = new Map();
export function chatKeyFor(clientUserId) {
    return `client:${clientUserId}`;
}
export function containsCyrillic(text) {
    return CYRILLIC_RE.test(text);
}
export function cyrillicToLatinUzbek(text) {
    if (!containsCyrillic(text))
        return text;
    const map = {
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
export async function safeSend(label, fn) {
    try {
        return await fn();
    }
    catch (err) {
        logger.error({ err }, `Telegram send failed (${label}) - continuing`);
        return null;
    }
}
async function failWithClientNotice(label, msg, deps, reason, clientReply = CLIENT_TECHNICAL_FAILURE_REPLY) {
    await safeSend(`sendToClient(${label})`, () => deps.telegram.sendToClient(clientReply));
    await safeSend(`notifyWorkChat(${label})`, () => deps.telegram.notifyWorkChat(formatEscalationNotice({
        clientName: msg.clientName,
        clientUserId: msg.clientUserId,
        reason,
        lastMessage: msg.text ?? msg.caption ?? `(${msg.kind} message)`,
    })));
}
function todayIso(now = new Date()) {
    return now.toISOString().slice(0, 10);
}
function displayTextFor(msg) {
    return msg.text ?? msg.caption ?? `[${msg.kind}]`;
}
export async function handleMessage(msg, deps) {
    const queueKey = chatKeyFor(msg.clientUserId);
    const previous = clientQueues.get(queueKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => handleMessageCore(msg, deps));
    clientQueues.set(queueKey, current);
    try {
        await current;
    }
    finally {
        if (clientQueues.get(queueKey) === current) {
            clientQueues.delete(queueKey);
        }
    }
}
async function handleMessageCore(msg, deps) {
    const { store } = deps;
    if (store.hasProcessedUpdate(msg.updateId)) {
        logger.debug({ updateId: msg.updateId }, "Skipping already-processed update");
        return;
    }
    let excluded = false;
    try {
        excluded = await deps.sheets.isExcluded(msg.clientUserId);
    }
    catch (err) {
        logger.error({ err, updateId: msg.updateId, clientUserId: msg.clientUserId }, "Failed to check excluded list");
        await failWithClientNotice("excluded check failure", msg, deps, "Google Sheets excluded-list check failed");
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
    let extractedText = null;
    let receiptExtraction = null;
    let uploadedLink = null;
    let openOrdersRaw;
    try {
        openOrdersRaw = await deps.sheets.findOpenOrdersForClient(msg.clientUserId);
    }
    catch (err) {
        logger.error({ err, updateId: msg.updateId, clientUserId: msg.clientUserId }, "Failed to load open orders");
        await failWithClientNotice("open orders failure", msg, deps, "Google Sheets open-order lookup failed");
        store.markUpdateProcessed(msg.updateId);
        return;
    }
    const openOrders = openOrdersRaw.map((o) => o.order);
    try {
        if (msg.kind === "voice" && msg.fileBuffer) {
            extractedText = await deps.ai.transcribeVoice(msg.fileBuffer, msg.fileMimeType);
        }
        else if ((msg.kind === "photo" || msg.kind === "document") && msg.fileBuffer && msg.fileMimeType) {
            const folderOrderId = openOrders.length === 1 ? openOrders[0].order_id : "inbox";
            try {
                const uploaded = await deps.drive.uploadClientFile(msg.clientUserId, folderOrderId, msg.fileName ?? `file_${Date.now()}`, msg.fileBuffer, msg.fileMimeType);
                uploadedLink = uploaded.webViewLink;
            }
            catch (err) {
                logger.error({ err, updateId: msg.updateId }, "Drive upload failed");
                await failWithClientNotice("drive failure", msg, deps, "Google Drive upload failed", "Kechirasiz, faylni hozircha saqlay olmadim. Xodimlarimiz xabardor bo'ladi.");
                store.markUpdateProcessed(msg.updateId);
                return;
            }
            if (msg.looksLikeReceipt) {
                receiptExtraction = await deps.ai.extractReceipt(msg.fileBuffer, msg.fileMimeType);
                extractedText = `[Payment receipt] ${JSON.stringify(receiptExtraction)} (file: ${uploadedLink})`;
            }
            else {
                const doc = await deps.ai.extractDocument(msg.fileBuffer, msg.fileMimeType);
                extractedText = `[Document] ${JSON.stringify(doc)} (file: ${uploadedLink})`;
            }
        }
    }
    catch (err) {
        logger.error({ err, updateId: msg.updateId }, "Gemini extraction failed");
        await safeSend("sendToClient(gemini failure)", () => deps.telegram.sendToClient("Kechirasiz, faylni hozircha o'qiy olmadim. Birozdan so'ng qayta urinib ko'raman, xodimlarimiz ham xabardor bo'ladi."));
        await safeSend("notifyWorkChat(gemini failure)", () => deps.telegram.notifyWorkChat(formatEscalationNotice({
            clientName: msg.clientName,
            clientUserId: msg.clientUserId,
            reason: "Gemini extraction failed (provider unavailable or error)",
            lastMessage: msg.text ?? msg.caption ?? "(file message)",
        })));
        store.markUpdateProcessed(msg.updateId);
        return;
    }
    const latestClientMessage = msg.text ?? msg.caption ?? "(fayl yuborildi)";
    const context = {
        priceList: deps.priceList,
        history: store.getConversation(chatKey),
        openOrders,
        extractedText,
        prepaymentPercent: deps.prepaymentPercent,
        standardTurnaroundDays: deps.standardTurnaroundDays,
    };
    let agentResponse;
    try {
        agentResponse = await deps.ai.callAgent(context, latestClientMessage, deps.agentProfile);
    }
    catch (err) {
        logger.error({ err, updateId: msg.updateId }, "Claude call failed");
        await safeSend("sendToClient(claude failure)", () => deps.telegram.sendToClient("Kechirasiz, hozir texnik nosozlik yuz berdi. Tez orada xodimlarimiz siz bilan bog'lanadi."));
        await safeSend("notifyWorkChat(claude failure)", () => deps.telegram.notifyWorkChat(formatEscalationNotice({
            clientName: msg.clientName,
            clientUserId: msg.clientUserId,
            reason: "Claude call failed (provider unavailable or error)",
            lastMessage: latestClientMessage,
        })));
        store.markUpdateProcessed(msg.updateId);
        return;
    }
    let skipOrderUpdate = false;
    if (containsCyrillic(agentResponse.clientReplyUz)) {
        logger.warn("Agent reply violated Uzbek-Latin-only rule (Cyrillic detected)");
        agentResponse = {
            clientReplyUz: LATIN_RULE_FAILURE_REPLY,
            escalate: true,
            escalationReason: "Claude generated a Cyrillic client reply despite the Latin-only rule",
            orderUpdate: null,
        };
        skipOrderUpdate = true;
    }
    await safeSend("sendToClient", () => deps.telegram.sendToClient(agentResponse.clientReplyUz));
    await safeSend("logToChannel", () => deps.telegram.logToChannel(`-> ${msg.clientName} (${msg.clientUserId}):\n${agentResponse.clientReplyUz}`));
    const clientRecord = {
        role: "client",
        text: latestClientMessage,
        timestamp: Date.now(),
    };
    const agentRecord = {
        role: "agent",
        text: agentResponse.clientReplyUz,
        timestamp: Date.now(),
    };
    store.appendMessage(chatKey, clientRecord);
    store.appendMessage(chatKey, agentRecord);
    try {
        if (!skipOrderUpdate && agentResponse.orderUpdate) {
            await applyOrderUpdate({ clientUserId: msg.clientUserId, clientName: msg.clientName }, agentResponse.orderUpdate, openOrders, uploadedLink, deps);
        }
        if (agentResponse.escalate) {
            store.setPendingEscalation(chatKey, agentResponse.escalationReason ?? "unspecified", {
                clientUserId: msg.clientUserId,
                clientName: msg.clientName,
                businessConnectionId: msg.businessConnectionId,
                clientChatId: msg.clientChatId,
            });
            const sent = await safeSend("notifyWorkChat(escalate)", () => deps.telegram.notifyWorkChat(formatEscalationNotice({
                clientName: msg.clientName,
                clientUserId: msg.clientUserId,
                reason: agentResponse.escalationReason ?? "unspecified",
                lastMessage: latestClientMessage,
            })));
            if (sent) {
                store.linkEscalationWorkMessage(chatKey, sent.messageId);
            }
        }
    }
    catch (err) {
        logger.error({ err, updateId: msg.updateId }, "Order update / escalation step failed");
        await failWithClientNotice("post-reply state update failure", msg, deps, "Order update or escalation persistence failed after Claude reply");
    }
    finally {
        store.markUpdateProcessed(msg.updateId);
    }
}
export async function applyOrderUpdate(client, orderUpdate, openOrders, uploadedLink, deps) {
    const target = resolveTargetOrder(orderUpdate.existingOrderId, openOrders);
    if (target) {
        const found = await deps.sheets.findOrderById(target.order_id);
        if (!found)
            return;
        const updated = { ...found.order };
        if (orderUpdate.paymentConfirmed && updated.prepayment_status !== "received") {
            updated.prepayment_status = "received";
            if (updated.status === "awaiting_prepayment" || updated.status === "new") {
                updated.status = "in_progress";
            }
            await deps.sheets.updateOrder(found.rowIndex1Based, updated);
            await safeSend("notifyWorkChat(paid, existing order)", () => deps.telegram.notifyWorkChat(formatPaidOrderNotice({
                orderId: updated.order_id,
                clientName: client.clientName,
                total: Number(updated.total_price) || 0,
                currency: deps.priceList.currency,
            })));
        }
        if (uploadedLink) {
            updated.document_files_links = updated.document_files_links
                ? `${updated.document_files_links}, ${uploadedLink}`
                : uploadedLink;
            await deps.sheets.updateOrder(found.rowIndex1Based, updated);
        }
        return;
    }
    if (orderUpdate.lineItems.length === 0)
        return;
    const items = orderUpdate.lineItems.map((li) => ({
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
    const order = {
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
        await safeSend("notifyWorkChat(paid, new order)", () => deps.telegram.notifyWorkChat(formatPaidOrderNotice({
            orderId: order.order_id,
            clientName: order.client_name,
            total: priced.total,
            currency: deps.priceList.currency,
        })));
    }
    else {
        await safeSend("notifyWorkChat(new order, unpaid)", () => deps.telegram.notifyWorkChat(`🆕 Yangi buyurtma yaratildi: ${order.order_id} (${order.client_name}) — to'lov kutilmoqda.`));
    }
}
//# sourceMappingURL=handleMessage.js.map