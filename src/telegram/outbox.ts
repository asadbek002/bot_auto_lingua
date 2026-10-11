import fs from "node:fs";
import path from "node:path";

/**
 * CRM ga yetkazilmagan xabarlar navbati (diskda). API o'chiq/qayta ishga tushayotgan paytda kelgan xabar
 * yo'qolmaydi: keyinroq qayta yuboriladi. API xabarni tg_message_id bo'yicha ikkilantirmaydi, shuning
 * uchun qayta yuborish xavfsiz.
 */
export interface OutboxItem {
  id: string;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  nextAt: number;
}

export const OUTBOX_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 10 * 60 * 1000;

export function backoffMs(attempts: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_MS);
}

export class Outbox {
  private items: OutboxItem[] = [];
  private seq = 0;

  constructor(private readonly filePath: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as OutboxItem[];
      if (Array.isArray(parsed)) this.items = parsed;
    } catch {
      this.items = [];
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items));
    fs.renameSync(tmp, this.filePath);          // yarim yozilgan fayl qolmasin
  }

  add(payload: Record<string, unknown>, now = Date.now()): OutboxItem {
    const item: OutboxItem = { id: `${now}-${++this.seq}`, payload, createdAt: now, attempts: 0, nextAt: now };
    this.items.push(item);
    this.persist();
    return item;
  }

  size(): number {
    return this.items.length;
  }

  oldestAgeMs(now = Date.now()): number {
    return this.items.length ? now - Math.min(...this.items.map((i) => i.createdAt)) : 0;
  }

  due(now = Date.now()): OutboxItem[] {
    return this.items.filter((i) => i.nextAt <= now);
  }

  remove(id: string): void {
    this.items = this.items.filter((i) => i.id !== id);
    this.persist();
  }

  failed(id: string, now = Date.now()): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    item.attempts += 1;
    item.nextAt = now + backoffMs(item.attempts);
    this.persist();
  }

  /** Juda eski (48 soat) elementlarni olib tashlaydi va ularni qaytaradi (ogohlantirish uchun). */
  expire(now = Date.now()): OutboxItem[] {
    const dead = this.items.filter((i) => now - i.createdAt > OUTBOX_MAX_AGE_MS);
    if (dead.length) {
      this.items = this.items.filter((i) => now - i.createdAt <= OUTBOX_MAX_AGE_MS);
      this.persist();
    }
    return dead;
  }
}
