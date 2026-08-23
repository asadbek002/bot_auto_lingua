import type { DocumentExtraction, ReceiptExtraction } from "../../src/ai/gemini.js";
import type { HandleMessageDeps } from "../../src/pipeline/handleMessage.js";

export interface FakeGeminiConfig {
  transcribeVoice?: (buffer: Buffer, mimeType?: string) => Promise<string>;
  extractDocument?: (buffer: Buffer, mimeType: string) => Promise<DocumentExtraction>;
  extractReceipt?: (buffer: Buffer, mimeType: string) => Promise<ReceiptExtraction>;
}

export function createFakeGemini(config: FakeGeminiConfig = {}): HandleMessageDeps["ai"] extends infer _T
  ? Pick<HandleMessageDeps["ai"], "transcribeVoice" | "extractDocument" | "extractReceipt">
  : never {
  return {
    transcribeVoice:
      config.transcribeVoice ?? (async () => "Salom, tarjima kerak edi"),
    extractDocument:
      config.extractDocument ??
      (async () => ({ documentType: "diplom", keyFields: {}, summary: "Diplom hujjati" })),
    extractReceipt:
      config.extractReceipt ??
      (async () => ({
        isPaymentReceipt: true,
        amount: 30000,
        currency: "UZS",
        sender: "Client",
        receiver: "Lingua Translation",
        transferStatus: "success",
        summary: "Payment confirmed",
      })),
  };
}
