import { describe, it, expect } from "vitest";
import { computeNextOrderId, resolveTargetOrder } from "../../src/pipeline/orderId.js";
import type { OrderRecord } from "../../src/sheets/orders.js";

function makeOrder(overrides: Partial<OrderRecord>): OrderRecord {
  return {
    order_id: "ORD-20260704-0001",
    client_user_id: "111",
    client_name: "Ali",
    phone: "",
    service_type: "translation",
    documents_description: "",
    document_files_links: "",
    source_lang: "uz",
    target_lang: "en",
    urgency: "",
    quantity: "1",
    unit_price: "60000",
    total_price: "60000",
    prepayment_status: "pending",
    payment_screenshot_link: "",
    order_date: "2026-07-04",
    deadline_date: "2026-07-11",
    status: "awaiting_prepayment",
    delivery_method: "",
    notes: "",
    ...overrides,
  };
}

describe("computeNextOrderId", () => {
  it("generates the first order id of the day as sequence 0001", () => {
    const id = computeNextOrderId([], new Date("2026-07-04T10:00:00Z"));
    expect(id).toBe("ORD-20260704-0001");
  });

  it("increments the sequence based on how many orders already exist that day", () => {
    const existing = ["ORD-20260704-0001", "ORD-20260704-0002"];
    const id = computeNextOrderId(existing, new Date("2026-07-04T10:00:00Z"));
    expect(id).toBe("ORD-20260704-0003");
  });

  it("does not collide even if the naive sequence guess is already taken", () => {
    // Simulates a gap: 2 orders exist today but 0003 is already used (e.g. from a
    // manually-created row), so the generator must skip past it.
    const existing = ["ORD-20260704-0001", "ORD-20260704-0003"];
    const id = computeNextOrderId(existing, new Date("2026-07-04T10:00:00Z"));
    expect(existing).not.toContain(id);
  });

  it("resets the sequence on a new day", () => {
    const existing = ["ORD-20260703-0005"];
    const id = computeNextOrderId(existing, new Date("2026-07-04T10:00:00Z"));
    expect(id).toBe("ORD-20260704-0001");
  });

  it("allows the same client to have multiple parallel open orders with distinct ids", () => {
    const first = computeNextOrderId([], new Date("2026-07-04T10:00:00Z"));
    const second = computeNextOrderId([first], new Date("2026-07-04T10:00:00Z"));
    expect(first).not.toBe(second);
  });
});

describe("resolveTargetOrder", () => {
  const openOrders = [makeOrder({ order_id: "ORD-A" }), makeOrder({ order_id: "ORD-B" })];

  it("returns null when no hint is given (treated as a new order)", () => {
    expect(resolveTargetOrder(null, openOrders)).toBeNull();
    expect(resolveTargetOrder(undefined, openOrders)).toBeNull();
  });

  it("matches an existing open order when the hint corresponds to one", () => {
    const result = resolveTargetOrder("ORD-B", openOrders);
    expect(result?.order_id).toBe("ORD-B");
  });

  it("does not trust a hinted order id that isn't actually one of the client's open orders", () => {
    const result = resolveTargetOrder("ORD-NONEXISTENT", openOrders);
    expect(result).toBeNull();
  });
});
