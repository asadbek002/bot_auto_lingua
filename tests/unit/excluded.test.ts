import { describe, it, expect, vi, beforeEach } from "vitest";

const state = {
  rows: [] as string[][],
};

vi.mock("../../src/sheets/client.js", () => {
  return {
    SHEET_TABS: { orders: "orders", excluded: "excluded", priceList: "price_list" },
    EXCLUDED_HEADER: ["user_id", "username", "added_by", "date_added", "reason"],
    getRows: vi.fn(async () => [
      ["user_id", "username", "added_by", "date_added", "reason"],
      ...state.rows,
    ]),
    appendRows: vi.fn(async (_id: string, _tab: string, rows: string[][]) => {
      state.rows.push(...rows);
    }),
    getSheetsClient: vi.fn(async () => ({
      spreadsheets: {
        values: {
          clear: vi.fn(async () => {
            state.rows = [];
          }),
        },
      },
    })),
  };
});

import { isExcluded, addExcluded, removeExcluded, listExcluded } from "../../src/sheets/excluded.js";

describe("excluded list gate", () => {
  beforeEach(() => {
    state.rows = [];
  });

  it("reports a user as not excluded when the list is empty", async () => {
    expect(await isExcluded("sheet1", "111")).toBe(false);
  });

  it("reports a user as excluded after being added", async () => {
    await addExcluded("sheet1", {
      user_id: "111",
      username: "someone",
      added_by: "owner",
      date_added: "2026-07-04",
      reason: "test",
    });
    expect(await isExcluded("sheet1", "111")).toBe(true);
    expect(await isExcluded("sheet1", "222")).toBe(false);
  });

  it("does not add a duplicate row for an already-excluded user", async () => {
    await addExcluded("sheet1", {
      user_id: "111",
      username: "a",
      added_by: "owner",
      date_added: "2026-07-04",
      reason: "r1",
    });
    await addExcluded("sheet1", {
      user_id: "111",
      username: "a",
      added_by: "owner",
      date_added: "2026-07-05",
      reason: "r2",
    });
    const list = await listExcluded("sheet1");
    expect(list.filter((r) => r.user_id === "111")).toHaveLength(1);
  });

  it("removes a user from the excluded list via /include", async () => {
    await addExcluded("sheet1", {
      user_id: "111",
      username: "a",
      added_by: "owner",
      date_added: "2026-07-04",
      reason: "r1",
    });
    const removed = await removeExcluded("sheet1", "111");
    expect(removed).toBe(true);
    expect(await isExcluded("sheet1", "111")).toBe(false);
  });

  it("returns false when trying to remove a user that isn't excluded", async () => {
    const removed = await removeExcluded("sheet1", "does-not-exist");
    expect(removed).toBe(false);
  });
});
