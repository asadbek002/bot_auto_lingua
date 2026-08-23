import { describe, it, expect, afterEach } from "vitest";
import { handleMessage, type IncomingMessage } from "../../src/pipeline/handleMessage.js";
import { createTestHarness, type TestHarness } from "../mocks/harness.js";
import { baseAgentResponse } from "../mocks/claudeMock.js";
import type { CallAgentHandler } from "../mocks/claudeMock.js";

/**
 * End-to-end scripted scenario covering the ТЗ's integration test #2: one client's
 * order lifecycle from first greeting through paid order creation, a next-day status
 * check, and a discount request on a (hypothetical) other order that must escalate
 * rather than being decided by the agent.
 */
describe("full order flow (ТЗ integration scenario #2)", () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  it("walks a client from greeting to a paid, tracked order, then correctly escalates a discount ask", async () => {
    const clientUserId = "5001";
    const clientName = "Aziz";

    const handlers: CallAgentHandler[] = [
      // 1. Greeting
      async () =>
        baseAgentResponse({
          clientReplyUz: "Vaalaykum assalom! Sizga qanday yordam bera olaman?",
        }),
      // 2. Client describes the document (photo already processed by Gemini upstream) -
      // agent asks clarifying questions instead of guessing.
      async (context) => {
        expect(context.extractedText).toContain("diplom");
        return baseAgentResponse({
          clientReplyUz:
            "Diplomingizni ko'rdim. Qaysi tilga tarjima kerak va bu tarjima nima uchun kerak (masalan, soliq qaytarish uchunmi)?",
        });
      },
      // 3. Client confirms language + explicitly says NOT for soliq -> agent prices and creates the order
      async () =>
        baseAgentResponse({
          clientReplyUz:
            "Rahmat! 2 varaq oddiy tarjima uchun narx: 120 000 so'm, old to'lov (50%) 60 000 so'm. To'lovni yuborsangiz, ishni boshlaymiz.",
          orderUpdate: {
            existingOrderId: null,
            clientName,
            phone: null,
            lineItems: [
              {
                serviceType: "translation",
                quantity: 2,
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
      // 4. Client sends payment screenshot -> agent marks the existing order paid
      async (context) => {
        expect(context.openOrders).toHaveLength(1);
        const orderId = context.openOrders[0]!.order_id;
        expect(context.extractedText).toContain("Payment receipt");
        return baseAgentResponse({
          clientReplyUz: "To'lovingiz qabul qilindi, rahmat! Buyurtmangiz ishga tushdi.",
          orderUpdate: {
            existingOrderId: orderId,
            clientName: null,
            phone: null,
            lineItems: [],
            documentsDescription: null,
            urgency: null,
            deliveryMethod: null,
            paymentConfirmed: true,
            notes: null,
          },
        });
      },
      // 5. Next day: status question, answered from deadline data, no escalation
      async (context) => {
        expect(context.openOrders).toHaveLength(1);
        expect(context.openOrders[0]!.status).toBe("in_progress");
        return baseAgentResponse({
          clientReplyUz: "Buyurtmangiz jarayonda, muddati belgilangan kunda tayyor bo'ladi.",
        });
      },
      // 6. Discount request on a different matter -> must escalate, not decide itself
      async () =>
        baseAgentResponse({
          clientReplyUz: "Hozircha aniqlashtirib olaman, tez orada javob qilamiz.",
          escalate: true,
          escalationReason: "Client asked for a discount",
        }),
    ];

    harness = createTestHarness({ claudeHandlers: handlers });

    const base = {
      clientUserId,
      clientName,
      businessConnectionId: "test-business-connection",
      clientChatId: Number(clientUserId),
    };

    await handleMessage(
      { updateId: 1, ...base, kind: "text", text: "Assalomu alaykum" },
      harness.deps
    );
    expect(harness.telegram.clientMessages[0]).toMatch(/Vaalaykum/);

    await handleMessage(
      {
        updateId: 2,
        ...base,
        kind: "photo",
        caption: "Diplomim",
        fileBuffer: Buffer.from("fake-image-bytes"),
        fileMimeType: "image/jpeg",
        fileName: "diplom.jpg",
      },
      harness.deps
    );
    expect(harness.telegram.clientMessages[1]).toMatch(/qaysi tilga|Qaysi tilga/i);

    await handleMessage(
      { updateId: 3, ...base, kind: "text", text: "Inglizchaga, oddiy, soliq uchun emas" },
      harness.deps
    );
    expect(harness.sheets.orders).toHaveLength(1);
    const order = harness.sheets.orders[0]!;
    expect(order.status).toBe("awaiting_prepayment");
    expect(order.total_price).toBe("120000");
    expect(harness.telegram.workChatMessages.some((m) => m.includes(order.order_id))).toBe(true);

    await handleMessage(
      {
        updateId: 4,
        ...base,
        kind: "photo",
        caption: "to'lov cheki",
        fileBuffer: Buffer.from("fake-receipt-bytes"),
        fileMimeType: "image/jpeg",
        fileName: "receipt.jpg",
        looksLikeReceipt: true,
      },
      harness.deps
    );
    expect(harness.sheets.orders[0]!.prepayment_status).toBe("received");
    expect(harness.sheets.orders[0]!.status).toBe("in_progress");
    expect(harness.telegram.workChatMessages.some((m) => m.includes("to'lov qabul qilindi"))).toBe(
      true
    );

    await handleMessage(
      { updateId: 5, ...base, kind: "text", text: "Buyurtmam qayerda?" },
      harness.deps
    );
    expect(harness.telegram.clientMessages[4]).toMatch(/jarayonda|muddat/i);

    const workChatCountBeforeDiscount = harness.telegram.workChatMessages.length;
    await handleMessage(
      { updateId: 6, ...base, kind: "text", text: "Chegirma qila olasizmi?" },
      harness.deps
    );
    expect(harness.telegram.workChatMessages.length).toBeGreaterThan(workChatCountBeforeDiscount);
    expect(harness.telegram.workChatMessages.at(-1)).toMatch(/discount/i);
    expect(harness.telegram.clientMessages.at(-1)).toMatch(/aniqlashtirib/i);
    // Price must not have changed as a side effect of the discount request.
    expect(harness.sheets.orders[0]!.total_price).toBe("120000");
  });
});
