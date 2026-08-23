import { describe, it, expect, afterEach } from "vitest";
import { handleMessage, chatKeyFor } from "../../src/pipeline/handleMessage.js";
import { createTestHarness, type TestHarness } from "../mocks/harness.js";
import { baseAgentResponse } from "../mocks/claudeMock.js";

describe("audit regression coverage", () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  const base = {
    clientUserId: "9901",
    clientName: "Audit Client",
    businessConnectionId: "test-business-connection",
    clientChatId: 9901,
  };

  it("does not leave the client silent when the excluded-list Sheets lookup fails", async () => {
    harness = createTestHarness({
      claudeHandlers: [async () => baseAgentResponse({ clientReplyUz: "should not call Claude" })],
    });
    harness.deps.sheets.isExcluded = async () => {
      throw new Error("Sheets unavailable");
    };

    await expect(
      handleMessage({ updateId: 1, ...base, kind: "text", text: "Salom" }, harness.deps)
    ).resolves.not.toThrow();

    expect(harness.telegram.clientMessages).toHaveLength(1);
    expect(harness.telegram.clientMessages[0]).toMatch(/texnik nosozlik/i);
    expect(harness.telegram.workChatMessages[0]).toMatch(/excluded-list/i);
  });

  it("reports Drive upload failures accurately and does not mislabel them as Gemini failures", async () => {
    harness = createTestHarness({
      claudeHandlers: [async () => baseAgentResponse({ clientReplyUz: "should not call Claude" })],
    });
    harness.deps.drive.uploadClientFile = async () => {
      throw new Error("Drive quota exceeded");
    };

    await handleMessage(
      {
        updateId: 2,
        ...base,
        kind: "photo",
        caption: "Diplom",
        fileBuffer: Buffer.from("fake-image"),
        fileMimeType: "image/jpeg",
        fileName: "diplom.jpg",
      },
      harness.deps
    );

    expect(harness.telegram.clientMessages[0]).toMatch(/saqlay olmadim/i);
    expect(harness.telegram.workChatMessages[0]).toMatch(/Google Drive upload failed/);
    expect(harness.telegram.workChatMessages[0]).not.toMatch(/Gemini extraction failed/);
  });

  it("never sends a Cyrillic Claude reply to the client and escalates instead", async () => {
    harness = createTestHarness({
      claudeHandlers: [
        async () =>
          baseAgentResponse({
            clientReplyUz: "Хоп, ҳужжатингизни қабул қилдик.",
          }),
      ],
    });

    await handleMessage({ updateId: 3, ...base, kind: "text", text: "Salom" }, harness.deps);

    expect(harness.telegram.clientMessages).toHaveLength(1);
    expect(harness.telegram.clientMessages[0]).not.toMatch(/[Ѐ-ӿ]/);
    expect(harness.telegram.workChatMessages[0]).toMatch(/Cyrillic client reply/i);
    expect(harness.store.isPaused(chatKeyFor(base.clientUserId))).toBe(true);
  });

  it("alerts the client and staff if order persistence fails after Claude replied", async () => {
    harness = createTestHarness({
      claudeHandlers: [
        async () =>
          baseAgentResponse({
            clientReplyUz: "Buyurtmangizni qabul qildik.",
            orderUpdate: {
              existingOrderId: null,
              clientName: null,
              phone: null,
              lineItems: [
                {
                  serviceType: "translation",
                  quantity: 1,
                  translationTier: "standard",
                  translationPurpose: "other",
                  sourceLang: "uz",
                  targetLang: "en",
                },
              ],
              documentsDescription: "Diplom",
              urgency: null,
              deliveryMethod: null,
              paymentConfirmed: false,
              notes: null,
            },
          }),
      ],
    });
    harness.deps.sheets.createOrder = async () => {
      throw new Error("Sheets append failed");
    };

    await handleMessage({ updateId: 4, ...base, kind: "text", text: "1 bet tarjima kerak" }, harness.deps);

    expect(harness.telegram.clientMessages).toHaveLength(2);
    expect(harness.telegram.clientMessages[0]).toMatch(/qabul qildik/i);
    expect(harness.telegram.clientMessages[1]).toMatch(/texnik nosozlik/i);
    expect(harness.telegram.workChatMessages[0]).toMatch(/Order update or escalation persistence failed/i);
  });

  it("serializes concurrent messages from the same client so a second turn sees the order created by the first", async () => {
    harness = createTestHarness({
      claudeHandlers: [
        async (context) => {
          expect(context.openOrders).toHaveLength(0);
          return baseAgentResponse({
            clientReplyUz: "Narx 60 000 so'm, old to'lov 30 000 so'm.",
            orderUpdate: {
              existingOrderId: null,
              clientName: null,
              phone: null,
              lineItems: [
                {
                  serviceType: "translation",
                  quantity: 1,
                  translationTier: "standard",
                  translationPurpose: "other",
                  sourceLang: "uz",
                  targetLang: "en",
                },
              ],
              documentsDescription: "Diplom",
              urgency: null,
              deliveryMethod: null,
              paymentConfirmed: false,
              notes: null,
            },
          });
        },
        async (context) => {
          expect(context.openOrders).toHaveLength(1);
          return baseAgentResponse({ clientReplyUz: "Ha, buyurtmangiz ochildi." });
        },
      ],
    });

    await Promise.all([
      handleMessage({ updateId: 5, ...base, kind: "text", text: "1 bet tarjima kerak" }, harness.deps),
      handleMessage({ updateId: 6, ...base, kind: "text", text: "Boshlayvering" }, harness.deps),
    ]);

    expect(harness.sheets.orders).toHaveLength(1);
    expect(harness.telegram.clientMessages).toHaveLength(2);
  });
});
