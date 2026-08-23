import { describe, it, expect, afterEach } from "vitest";
import { handleMessage, chatKeyFor } from "../../src/pipeline/handleMessage.js";
import { resolveEscalationViaStaffReply, resolveEscalationManually } from "../../src/pipeline/resolveEscalation.js";
import { createTestHarness, type TestHarness } from "../mocks/harness.js";
import { baseAgentResponse } from "../mocks/claudeMock.js";

/**
 * Covers the escalation pause/resume gap: escalation must not be a one-way notice -
 * the client goes silent (paused) until a human resolves it, any messages sent while
 * paused are preserved (not dropped), and resolving via a staff reply to the escalation
 * notice produces one coherent reply that accounts for the whole gap.
 */
describe("escalation pause/resume (ТЗ addendum)", () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  const clientUserId = "9101";
  const clientName = "Otabek";
  const chatKey = chatKeyFor(clientUserId);
  const base = {
    clientUserId,
    clientName,
    businessConnectionId: "test-business-connection",
    clientChatId: Number(clientUserId),
  };

  it("pauses on escalation, ignores messages while paused without losing them, and resolves via staff reply with full context", async () => {
    harness = createTestHarness({
      claudeHandlers: [
        // 1. Client asks for a discount -> must escalate, not decide itself.
        async () =>
          baseAgentResponse({
            clientReplyUz: "Hozircha aniqlashtirib olaman, tez orada javob qilamiz.",
            escalate: true,
            escalationReason: "Client is asking for a discount",
          }),
      ],
      resolveHandlers: [
        async (context) => {
          // The staff-resolution call must see the ENTIRE history, including the two
          // messages the client sent while paused (never answered in real time).
          const texts = context.history.map((m) => m.text);
          expect(texts).toContain("Chegirma qila olasizmi?");
          expect(texts).toContain("Aka javob bering endi");
          expect(texts).toContain("Kutyapman hali ham");
          return baseAgentResponse({
            clientReplyUz:
              "Kutganingiz uchun uzr so'rayman! 10% chegirma bera olamiz - buyurtmangizni shu narxda tasdiqlaysizmi?",
          });
        },
      ],
    });

    // 1. Discount request -> escalate -> pause set.
    await handleMessage(
      { updateId: 1, ...base, kind: "text", text: "Chegirma qila olasizmi?" },
      harness.deps
    );

    expect(harness.store.isPaused(chatKey)).toBe(true);
    expect(harness.telegram.workChatMessages).toHaveLength(1);
    expect(harness.telegram.workChatMessages[0]).toMatch(/ESKALATSIYA/i);
    const escalationMessageId = harness.telegram.workChatMessageIds[0]!;
    expect(harness.telegram.clientMessages).toEqual(["Hozircha aniqlashtirib olaman, tez orada javob qilamiz."]);

    // 2. Client sends two more messages while paused - no reply, no re-escalation, but
    // not silently dropped either.
    await handleMessage(
      { updateId: 2, ...base, kind: "text", text: "Aka javob bering endi" },
      harness.deps
    );
    await handleMessage(
      { updateId: 3, ...base, kind: "text", text: "Kutyapman hali ham" },
      harness.deps
    );

    // Still only the one holding-phrase reply and one escalation notice - pause worked.
    expect(harness.telegram.clientMessages).toHaveLength(1);
    expect(harness.telegram.workChatMessages).toHaveLength(1);
    expect(harness.store.getConversation(chatKey).map((m) => m.text)).toEqual(
      expect.arrayContaining(["Chegirma qila olasizmi?", "Aka javob bering endi", "Kutyapman hali ham"])
    );

    // 3. Staff replies to the escalation notice in the work chat (Способ А) - resolved
    // via the work-message-id link captured when the escalation was sent.
    const linked = harness.store.findEscalationByWorkMessageId(escalationMessageId);
    expect(linked?.chatKey).toBe(chatKey);

    const result = await resolveEscalationViaStaffReply(
      chatKey,
      "10% chegirma berishga rozimiz, tasdiqlasin",
      harness.deps
    );

    expect(result.ok).toBe(true);
    expect(harness.store.isPaused(chatKey)).toBe(false);
    expect(harness.telegram.clientMessages).toHaveLength(2);
    expect(harness.telegram.clientMessages[1]).toMatch(/10%/);
    expect(harness.telegram.directMessages).toHaveLength(1);
    expect(harness.telegram.directMessages[0]).toEqual({
      businessConnectionId: base.businessConnectionId,
      chatId: base.clientChatId,
      text: harness.telegram.clientMessages[1],
    });
  });

  it("Способ Б (/resolved) clears the pause without messaging the client, and missed messages surface on the next normal reply", async () => {
    harness = createTestHarness({
      claudeHandlers: [
        async () =>
          baseAgentResponse({
            clientReplyUz: "Hozircha aniqlashtirib olaman, tez orada javob qilamiz.",
            escalate: true,
            escalationReason: "Client wants to cancel an order",
          }),
        // Next normal turn after resume - must see the missed message in history.
        async (context) => {
          const texts = context.history.map((m) => m.text);
          expect(texts).toContain("Bekor qilishni xohlayman");
          return baseAgentResponse({ clientReplyUz: "Xop aka, buyurtmangiz holatini tekshirib ko'ramiz." });
        },
      ],
    });

    await handleMessage(
      { updateId: 1, ...base, kind: "text", text: "Buyurtmani bekor qilmoqchiman" },
      harness.deps
    );
    expect(harness.store.isPaused(chatKey)).toBe(true);

    // Client writes again while paused - logged, not answered.
    await handleMessage(
      { updateId: 2, ...base, kind: "text", text: "Bekor qilishni xohlayman" },
      harness.deps
    );
    expect(harness.telegram.clientMessages).toHaveLength(1);

    // Staff resolved it manually (talked to the client directly) - just lift the pause.
    const manual = await resolveEscalationManually(clientUserId, harness.deps);
    expect(manual.ok).toBe(true);
    expect(harness.store.isPaused(chatKey)).toBe(false);
    // Способ Б sends nothing to the client itself.
    expect(harness.telegram.clientMessages).toHaveLength(1);

    // Next time the client writes, the bot responds normally and the missed message is
    // part of the context (asserted inside the second claudeHandlers callback above).
    await handleMessage(
      { updateId: 3, ...base, kind: "text", text: "Xolatini ayting" },
      harness.deps
    );
    expect(harness.telegram.clientMessages).toHaveLength(2);
    expect(harness.telegram.clientMessages[1]).toMatch(/tekshirib/);
  });
});
