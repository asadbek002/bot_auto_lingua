import { describe, it, expect, afterEach } from "vitest";
import { handleMessage } from "../../src/pipeline/handleMessage.js";
import { createTestHarness, type TestHarness } from "../mocks/harness.js";
import { baseAgentResponse } from "../mocks/claudeMock.js";
import { env } from "../../src/config/env.js";

function buildSilentWav(): Buffer {
  // Minimal valid 16-bit PCM mono WAV, ~0.1s of silence at 8kHz - just enough to be a
  // structurally valid audio file for a wiring smoke test (not a speech-accuracy test).
  const sampleRate = 8000;
  const numSamples = 800;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

/**
 * ТЗ integration test #4: a voice message must be transcribed (via Gemini) and the
 * resulting text handed on to Claude to produce a normal reply. If GEMINI_API_KEY is
 * configured in .env this exercises a REAL Gemini call (wiring smoke test only - a
 * silent synthetic WAV has no real speech content to assert on); otherwise it falls
 * back to a scripted mock transcription so the suite still fully passes without live
 * keys.
 */
describe("voice message handling (ТЗ integration scenario #4)", () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  const hasGeminiKey = Boolean(env.GEMINI_API_KEY);

  it(
    hasGeminiKey
      ? "transcribes a real (synthetic silent) audio buffer via the live Gemini API without erroring"
      : "falls back to a mocked transcription and still completes the turn (no GEMINI_API_KEY set)",
    async () => {
      let transcribeVoice: (buffer: Buffer, mimeType?: string) => Promise<string>;

      if (hasGeminiKey) {
        const gemini = await import("../../src/ai/gemini.js");
        transcribeVoice = gemini.transcribeVoice;
      } else {
        transcribeVoice = async () => "Salom, menga tarjima kerak edi, narxi qancha bo'ladi?";
      }

      harness = createTestHarness({
        claudeHandlers: [
          async (context) => {
            expect(context.extractedText).toBeTruthy();
            expect(typeof context.extractedText).toBe("string");
            return baseAgentResponse({
              clientReplyUz: "Assalomu alaykum! Qanday hujjatni tarjima qilish kerak?",
            });
          },
        ],
        geminiConfig: { transcribeVoice },
      });

      await handleMessage(
        {
          updateId: 1,
          clientUserId: "7001",
          clientName: "Bekzod",
          businessConnectionId: "test-business-connection",
          clientChatId: 7001,
          kind: "voice",
          fileBuffer: buildSilentWav(),
          fileMimeType: "audio/wav",
        },
        harness.deps
      );

      expect(harness.telegram.clientMessages).toHaveLength(1);
      expect(harness.telegram.clientMessages[0]).toMatch(/hujjat/i);
    },
    30000
  );
});
