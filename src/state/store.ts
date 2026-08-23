import fs from "node:fs";
import path from "node:path";

export interface ChatMessageRecord {
  role: "client" | "agent";
  text: string;
  timestamp: number;
}

export interface PendingEscalation {
  reason: string;
  createdAt: number;
  clientUserId: string;
  clientName: string;
  businessConnectionId: string;
  clientChatId: number;
  workChatMessageId: number | null;
}

export interface StateData {
  processedUpdateIds: number[];
  conversations: Record<string, ChatMessageRecord[]>;
  excludedCache: { userIds: string[]; cachedAt: number } | null;
  pendingEscalations: Record<string, PendingEscalation>;
  deadlineNotifications: Record<string, string>;
}

const DEFAULT_STATE: StateData = {
  processedUpdateIds: [],
  conversations: {},
  excludedCache: null,
  pendingEscalations: {},
  deadlineNotifications: {},
};

const MAX_PROCESSED_IDS = 5000;
const MAX_HISTORY_PER_CHAT = 200;

export class Store {
  private filePath: string;
  private data: StateData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): StateData {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<StateData>;
      return { ...DEFAULT_STATE, ...parsed };
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.filePath);
  }

  reload(): void {
    this.data = this.load();
  }

  hasProcessedUpdate(updateId: number): boolean {
    return this.data.processedUpdateIds.includes(updateId);
  }

  markUpdateProcessed(updateId: number): void {
    if (this.data.processedUpdateIds.includes(updateId)) return;
    this.data.processedUpdateIds.push(updateId);
    if (this.data.processedUpdateIds.length > MAX_PROCESSED_IDS) {
      this.data.processedUpdateIds = this.data.processedUpdateIds.slice(
        -MAX_PROCESSED_IDS
      );
    }
    this.persist();
  }

  getConversation(chatKey: string): ChatMessageRecord[] {
    return this.data.conversations[chatKey] ?? [];
  }

  appendMessage(chatKey: string, record: ChatMessageRecord): void {
    const history = this.data.conversations[chatKey] ?? [];
    history.push(record);
    this.data.conversations[chatKey] = history.slice(-MAX_HISTORY_PER_CHAT);
    this.persist();
  }

  getExcludedCache(): { userIds: string[]; cachedAt: number } | null {
    return this.data.excludedCache;
  }

  setExcludedCache(userIds: string[]): void {
    this.data.excludedCache = { userIds, cachedAt: Date.now() };
    this.persist();
  }

  setPendingEscalation(
    chatKey: string,
    reason: string,
    meta: {
      clientUserId: string;
      clientName: string;
      businessConnectionId: string;
      clientChatId: number;
    }
  ): void {
    this.data.pendingEscalations[chatKey] = {
      reason,
      createdAt: Date.now(),
      workChatMessageId: null,
      ...meta,
    };
    this.persist();
  }

  linkEscalationWorkMessage(chatKey: string, workChatMessageId: number): void {
    const pending = this.data.pendingEscalations[chatKey];
    if (!pending) return;
    pending.workChatMessageId = workChatMessageId;
    this.persist();
  }

  clearPendingEscalation(chatKey: string): void {
    delete this.data.pendingEscalations[chatKey];
    this.persist();
  }

  isPaused(chatKey: string): boolean {
    return Boolean(this.data.pendingEscalations[chatKey]);
  }

  getPendingEscalation(chatKey: string): PendingEscalation | null {
    return this.data.pendingEscalations[chatKey] ?? null;
  }

  findEscalationByWorkMessageId(
    workChatMessageId: number
  ): { chatKey: string; escalation: PendingEscalation } | null {
    for (const [chatKey, escalation] of Object.entries(this.data.pendingEscalations)) {
      if (escalation.workChatMessageId === workChatMessageId) {
        return { chatKey, escalation };
      }
    }
    return null;
  }

  findEscalationByClientUserId(
    clientUserId: string
  ): { chatKey: string; escalation: PendingEscalation } | null {
    for (const [chatKey, escalation] of Object.entries(this.data.pendingEscalations)) {
      if (escalation.clientUserId === clientUserId) {
        return { chatKey, escalation };
      }
    }
    return null;
  }

  getAllConversations(): Record<string, ChatMessageRecord[]> {
    return this.data.conversations;
  }

  hasBeenNotifiedToday(orderId: string, todayIso: string): boolean {
    return this.data.deadlineNotifications[orderId] === todayIso;
  }

  markDeadlineNotified(orderId: string, todayIso: string): void {
    this.data.deadlineNotifications[orderId] = todayIso;
    this.persist();
  }
}
