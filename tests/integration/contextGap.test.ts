import { describe, it, expect, afterEach } from "vitest";
import { handleMessage } from "../../src/pipeline/handleMessage.js";
import { createTestHarness, type TestHarness } from "../mocks/harness.js";
import { baseAgentResponse } from "../mocks/claudeMock.js";

/**
 * ТЗ integration test #3: client references an agreement that does not exist anywhere
 * in the conversation history (e.g. "we agreed on the phone with your colleague").
 * The pipeline must not fabricate an order/price from thin air - it should pass the
 * full (empty/unrelated) history through untouched and let the reply stay a
 * clarifying question with no order side effects.
 */
describe("context gap handling (ТЗ integration scenario #3)", () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  it("does not fabricate a discount/order when the client references a nonexistent prior agreement", async () => {
    harness = createTestHarness({
      claudeHandlers: [
        async (context) => {
          // The pipeline must hand over the real (empty) history - proving the "hole"
          // genuinely isn't there for the model to have found.
          expect(context.history).toHaveLength(0);
          expect(context.openOrders).toHaveLength(0);
          return baseAgentResponse({
            clientReplyUz:
              "Kechirasiz, bunday kelishuv haqida ma'lumotim yo'q. Aniq kim bilan va qachon gaplashgan edingiz?",
            escalate: false,
            orderUpdate: null,
          });
        },
      ],
    });

    await handleMessage(
      {
        updateId: 1,
        clientUserId: "6001",
        clientName: "Malika",
        businessConnectionId: "test-business-connection",
        clientChatId: 6001,
        kind: "text",
        text: "Sizning xodimingiz bilan telefon orqali gaplashgandim, 30% chegirma berishga rozi bo'lgandi, shu bo'yicha buyurtma bering",
      },
      harness.deps
    );

    expect(harness.telegram.clientMessages).toHaveLength(1);
    expect(harness.telegram.clientMessages[0]).toMatch(/kim bilan|qachon|ma'lumotim yo'q/i);
    expect(harness.sheets.orders).toHaveLength(0);
    expect(harness.telegram.workChatMessages).toHaveLength(0);
  });
});
