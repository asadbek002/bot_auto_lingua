import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Outbox, backoffMs, OUTBOX_MAX_AGE_MS } from "../../src/telegram/outbox.js";

const tmp: string[] = [];
function file(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-"));
  tmp.push(dir);
  return path.join(dir, "outbox.json");
}
afterEach(() => { tmp.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })); });

describe("Outbox — CRM ga yetmagan xabarlar navbati", () => {
  it("qayta ishga tushganda diskdan tiklanadi", () => {
    const f = file();
    const a = new Outbox(f);
    a.add({ text: "bir" }, 1000);
    a.add({ text: "ikki" }, 2000);
    const b = new Outbox(f);                         // jarayon qayta ishga tushdi
    expect(b.size()).toBe(2);
    expect(b.due(5000).map((i) => i.payload.text)).toEqual(["bir", "ikki"]);
  });

  it("buzilgan fayl navbatni bo'sh qiladi, jarayonni to'xtatmaydi", () => {
    const f = file();
    fs.writeFileSync(f, "{buzilgan");
    expect(new Outbox(f).size()).toBe(0);
  });

  it("xato bo'lsa kutish oshib boradi, muvaffaqiyatda o'chadi", () => {
    const box = new Outbox(file());
    const item = box.add({ x: 1 }, 0);
    expect(box.due(0)).toHaveLength(1);
    box.failed(item.id, 0);
    expect(box.due(1000)).toHaveLength(0);                         // 15 s kutadi
    expect(box.due(backoffMs(1))).toHaveLength(1);
    box.failed(item.id, 0);
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));
    expect(backoffMs(50)).toBe(10 * 60 * 1000);                    // 10 daqiqadan oshmaydi
    box.remove(item.id);
    expect(box.size()).toBe(0);
  });

  it("48 soatdan eski xabar navbatdan chiqariladi va qaytariladi", () => {
    const box = new Outbox(file());
    box.add({ eski: true }, 0);
    box.add({ yangi: true }, OUTBOX_MAX_AGE_MS);
    const dead = box.expire(OUTBOX_MAX_AGE_MS + 1);
    expect(dead).toHaveLength(1);
    expect(box.size()).toBe(1);
    expect(box.oldestAgeMs(OUTBOX_MAX_AGE_MS + 1)).toBe(1);
  });
});
