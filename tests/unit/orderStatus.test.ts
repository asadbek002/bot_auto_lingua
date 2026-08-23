import { describe, it, expect } from "vitest";
import { computeStatus } from "../../src/sheets/orders.js";

describe("computeStatus", () => {
  it("computes a deadline N working days after the order date, skipping weekends", () => {
    // 2026-07-06 is a Monday.
    const { deadlineDate } = computeStatus("2026-07-06", 6, new Date("2026-07-06"));
    // 6 working days from Monday 2026-07-06 -> Tue 7, Wed 8, Thu 9, Fri 10, (skip Sat/Sun), Mon 13, Tue 14
    expect(deadlineDate.toISOString().slice(0, 10)).toBe("2026-07-14");
  });

  it("reports not overdue and days remaining when well before the deadline", () => {
    const { isOverdue, daysRemaining } = computeStatus(
      "2026-07-06",
      6,
      new Date("2026-07-07")
    );
    expect(isOverdue).toBe(false);
    expect(daysRemaining).toBeGreaterThan(0);
  });

  it("reports overdue when now is after the computed deadline", () => {
    const { isOverdue, daysRemaining } = computeStatus(
      "2026-07-06",
      6,
      new Date("2026-07-20")
    );
    expect(isOverdue).toBe(true);
    expect(daysRemaining).toBeLessThan(0);
  });

  it("reports due tomorrow (daysRemaining === 1) the day before the deadline", () => {
    const { deadlineDate } = computeStatus("2026-07-06", 6, new Date("2026-07-06"));
    const dayBefore = new Date(deadlineDate);
    dayBefore.setDate(dayBefore.getDate() - 1);
    const { daysRemaining, isOverdue } = computeStatus("2026-07-06", 6, dayBefore);
    expect(daysRemaining).toBe(1);
    expect(isOverdue).toBe(false);
  });
});
