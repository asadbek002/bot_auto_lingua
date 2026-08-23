import { describe, it, expect, afterEach } from "vitest";
import { handleMessage } from "../../src/pipeline/handleMessage.js";
import { createTestHarness, type TestHarness } from "../mocks/harness.js";
import { baseAgentResponse } from "../mocks/claudeMock.js";

/**
 * ТЗ integration test #5: a provider (Gemini or Claude) being unavailable must result
 * in a graceful client message and a work-chat escalation - never a crash, hang, or
 * silent drop of the message.
 */
describe("provider failure handling (ТЗ integration scenario #5)", () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  it("handles a Gemini extraction failure gracefully and escalates instead of crashing", async () => {
    harness = createTestHarness({
      claudeHandlers: [async () => baseAgentResponse({ clientReplyUz: "should not be reached" })],
      geminiConfig: {
        extractDocument: async () => {
          throw new Error("Gemini API unavailable (simulated 503)");
        },
      },
    });

    await expect(
      handleMessage(
        {
          updateId: 1,
          clientUserId: "8001",
          clientName: "Dilnoza",
          businessConnectionId: "test-business-connection",
          clientChatId: 8001,
          kind: "photo",
          caption: "Guvohnomam",
          fileBuffer: Buffer.from("fake-bytes"),
          fileMimeType: "image/jpeg",
          fileName: "doc.jpg",
        },
        harness.deps
      )
    ).resolves.not.toThrow();

    expect(harness.telegram.clientMessages).toHaveLength(1);
    expect(harness.telegram.clientMessages[0]).not.toMatch(/should not be reached/);
    expect(harness.telegram.workChatMessages).toHaveLength(1);
    expect(harness.telegram.workChatMessages[0]).toMatch(/Gemini/i);
    expect(harness.sheets.orders).toHaveLength(0);
  });

  it("handles a Claude failure gracefully and escalates instead of crashing", async () => {
    harness = createTestHarness({
      claudeHandlers: [
        async () => {
          throw new Error("Anthropic API unavailable (simulated 529)");
        },
      ],
    });

    await expect(
      handleMessage(
        {
          updateId: 1,
          clientUserId: "8002",
          clientName: "Sardor",
          businessConnectionId: "test-business-connection",
          clientChatId: 8002,
          kind: "text",
          text: "Salom",
        },
        harness.deps
      )
    ).resolves.not.toThrow();

    expect(harness.telegram.clientMessages).toHaveLength(1);
    expect(harness.telegram.workChatMessages).toHaveLength(1);
    expect(harness.telegram.workChatMessages[0]).toMatch(/Claude/i);
  });
});
