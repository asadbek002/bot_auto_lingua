import { describe, it, expect } from "vitest";
import { parseCommandTarget, formatExcludedList } from "../../src/telegram/commands.js";

describe("parseCommandTarget", () => {
  it("parses a username argument", () => {
    expect(parseCommandTarget("@johndoe")).toEqual({ type: "username", value: "johndoe" });
  });

  it("parses a numeric user id argument", () => {
    expect(parseCommandTarget("123456789")).toEqual({ type: "user_id", value: "123456789" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseCommandTarget("  123456789  ")).toEqual({ type: "user_id", value: "123456789" });
  });

  it("returns null for an empty argument", () => {
    expect(parseCommandTarget("")).toBeNull();
    expect(parseCommandTarget("   ")).toBeNull();
  });

  it("returns null for a bare '@' with no username", () => {
    expect(parseCommandTarget("@")).toBeNull();
  });

  it("returns null for garbage that is neither a username nor a numeric id", () => {
    expect(parseCommandTarget("not-a-valid-id!!")).toBeNull();
  });
});

describe("formatExcludedList", () => {
  it("says the list is empty when there are no rows", () => {
    expect(formatExcludedList([])).toMatch(/bo'sh/);
  });

  it("formats rows with username, id, reason and date", () => {
    const text = formatExcludedList([
      { user_id: "111", username: "ali", reason: "spam", date_added: "2026-07-04" },
    ]);
    expect(text).toContain("@ali");
    expect(text).toContain("111");
    expect(text).toContain("spam");
    expect(text).toContain("2026-07-04");
  });

  it("falls back to user_id display when no username is present", () => {
    const text = formatExcludedList([
      { user_id: "222", username: "", reason: "", date_added: "" },
    ]);
    expect(text).toContain("222");
    expect(text).not.toContain("@");
  });
});
