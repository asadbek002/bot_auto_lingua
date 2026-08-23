import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }
  return client;
}

async function generate(model: string, prompt: string, buffer: Buffer, mimeType: string) {
  const ai = getClient();
  const response = await withRetry(
    () =>
      ai.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }, { inlineData: { mimeType, data: buffer.toString("base64") } }],
          },
        ],
      }),
    {
      attempts: 2,
      onRetry: (err, attempt) => logger.warn({ err, attempt }, "Gemini call retry"),
    }
  );
  return response.text ?? "";
}

export async function transcribeVoice(buffer: Buffer, mimeType = "audio/ogg"): Promise<string> {
  const text = await generate(
    env.GEMINI_MODEL_LITE,
    "Transcribe this voice message to plain text. The speaker may use Uzbek (Latin or " +
      "Cyrillic), Russian, or a mix. Output ONLY the transcription, no commentary.",
    buffer,
    mimeType
  );
  return text.trim();
}

export interface DocumentExtraction {
  documentType: string;
  keyFields: Record<string, string>;
  summary: string;
}

export async function extractDocument(
  buffer: Buffer,
  mimeType: string
): Promise<DocumentExtraction> {
  const prompt =
    "You are extracting structured data from a document photo/scan/PDF for a " +
    "translation/apostille bureau. Identify the document type (e.g. diplom, " +
    "tug'ilganlik haqida guvohnoma, nikoh haqida guvohnoma, spravka, passport, boshqa) " +
    "and any visible key fields (full name, document number, issue date, issuing " +
    "country). Respond with ONLY strict JSON matching: " +
    '{"documentType": string, "keyFields": {[key: string]: string}, "summary": string}. ' +
    "No markdown, no commentary.";
  const raw = await generate(env.GEMINI_MODEL, prompt, buffer, mimeType);
  return parseJsonSafely<DocumentExtraction>(raw, {
    documentType: "boshqa",
    keyFields: {},
    summary: raw.slice(0, 500),
  });
}

export interface ReceiptExtraction {
  isPaymentReceipt: boolean;
  amount: number | null;
  currency: string | null;
  sender: string | null;
  receiver: string | null;
  transferStatus: "success" | "failed" | "pending" | "unknown";
  summary: string;
}

export async function extractReceipt(
  buffer: Buffer,
  mimeType: string
): Promise<ReceiptExtraction> {
  const prompt =
    "You are extracting structured data from a bank/payment transfer screenshot or " +
    "receipt. Identify: whether this is actually a payment receipt, the amount, " +
    "currency, sender name, receiver name, and whether the transfer shows as " +
    "successful/completed. Respond with ONLY strict JSON matching: " +
    '{"isPaymentReceipt": boolean, "amount": number|null, "currency": string|null, ' +
    '"sender": string|null, "receiver": string|null, ' +
    '"transferStatus": "success"|"failed"|"pending"|"unknown", "summary": string}. ' +
    "No markdown, no commentary.";
  const raw = await generate(env.GEMINI_MODEL, prompt, buffer, mimeType);
  return parseJsonSafely<ReceiptExtraction>(raw, {
    isPaymentReceipt: false,
    amount: null,
    currency: null,
    sender: null,
    receiver: null,
    transferStatus: "unknown",
    summary: raw.slice(0, 500),
  });
}

function parseJsonSafely<T>(raw: string, fallback: T): T {
  try {
    const cleaned = raw.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "");
    return JSON.parse(cleaned) as T;
  } catch (err) {
    logger.warn({ err }, "Failed to parse Gemini JSON output, using fallback");
    return fallback;
  }
}
