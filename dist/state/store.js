import fs from "node:fs";
import path from "node:path";
const DEFAULT_STATE = {
    processedUpdateIds: [],
    conversations: {},
    excludedCache: null,
    pendingEscalations: {},
    deadlineNotifications: {},
};
const MAX_PROCESSED_IDS = 5000;
const MAX_HISTORY_PER_CHAT = 200;
export class Store {
    filePath;
    data;
    constructor(filePath) {
        this.filePath = filePath;
        this.data = this.load();
    }
    load() {
        try {
            const raw = fs.readFileSync(this.filePath, "utf-8");
            const parsed = JSON.parse(raw);
            return { ...DEFAULT_STATE, ...parsed };
        }
        catch {
            return structuredClone(DEFAULT_STATE);
        }
    }
    persist() {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), "utf-8");
        fs.renameSync(tmpPath, this.filePath);
    }
    reload() {
        this.data = this.load();
    }
    hasProcessedUpdate(updateId) {
        return this.data.processedUpdateIds.includes(updateId);
    }
    markUpdateProcessed(updateId) {
        if (this.data.processedUpdateIds.includes(updateId))
            return;
        this.data.processedUpdateIds.push(updateId);
        if (this.data.processedUpdateIds.length > MAX_PROCESSED_IDS) {
            this.data.processedUpdateIds = this.data.processedUpdateIds.slice(-MAX_PROCESSED_IDS);
        }
        this.persist();
    }
    getConversation(chatKey) {
        return this.data.conversations[chatKey] ?? [];
    }
    appendMessage(chatKey, record) {
        const history = this.data.conversations[chatKey] ?? [];
        history.push(record);
        this.data.conversations[chatKey] = history.slice(-MAX_HISTORY_PER_CHAT);
        this.persist();
    }
    getExcludedCache() {
        return this.data.excludedCache;
    }
    setExcludedCache(userIds) {
        this.data.excludedCache = { userIds, cachedAt: Date.now() };
        this.persist();
    }
    setPendingEscalation(chatKey, reason, meta) {
        this.data.pendingEscalations[chatKey] = {
            reason,
            createdAt: Date.now(),
            workChatMessageId: null,
            ...meta,
        };
        this.persist();
    }
    linkEscalationWorkMessage(chatKey, workChatMessageId) {
        const pending = this.data.pendingEscalations[chatKey];
        if (!pending)
            return;
        pending.workChatMessageId = workChatMessageId;
        this.persist();
    }
    clearPendingEscalation(chatKey) {
        delete this.data.pendingEscalations[chatKey];
        this.persist();
    }
    isPaused(chatKey) {
        return Boolean(this.data.pendingEscalations[chatKey]);
    }
    getPendingEscalation(chatKey) {
        return this.data.pendingEscalations[chatKey] ?? null;
    }
    findEscalationByWorkMessageId(workChatMessageId) {
        for (const [chatKey, escalation] of Object.entries(this.data.pendingEscalations)) {
            if (escalation.workChatMessageId === workChatMessageId) {
                return { chatKey, escalation };
            }
        }
        return null;
    }
    findEscalationByClientUserId(clientUserId) {
        for (const [chatKey, escalation] of Object.entries(this.data.pendingEscalations)) {
            if (escalation.clientUserId === clientUserId) {
                return { chatKey, escalation };
            }
        }
        return null;
    }
    getAllConversations() {
        return this.data.conversations;
    }
    hasBeenNotifiedToday(orderId, todayIso) {
        return this.data.deadlineNotifications[orderId] === todayIso;
    }
    markDeadlineNotified(orderId, todayIso) {
        this.data.deadlineNotifications[orderId] = todayIso;
        this.persist();
    }
}
//# sourceMappingURL=store.js.map