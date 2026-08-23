import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/state/store.js";
import type { HandleMessageDeps } from "../../src/pipeline/handleMessage.js";
import type { PriceList } from "../../src/sheets/priceList.js";
import { createFakeSheets, type FakeSheets } from "./sheetsMock.js";
import { createFakeTelegram, type FakeTelegram } from "./telegramMock.js";
import { createFakeDrive, type FakeDrive } from "./driveMock.js";
import { createFakeGemini, type FakeGeminiConfig } from "./geminiMock.js";
import { createFakeClaude, type CallAgentHandler } from "./claudeMock.js";

export const TEST_PRICE_LIST: PriceList = {
  currency: "UZS",
  translation: {
    unit: "list",
    standard_to_english: 60000,
    notarized_to_english: 100000,
    soliq_qaytarish_to_english: 50000,
  },
  apostille: {
    unit: "document",
    by_document_type: { diplom: 250000, guvohnoma: 200000, boshqa: 220000 },
  },
};

export interface TestHarness {
  deps: HandleMessageDeps;
  sheets: FakeSheets;
  telegram: FakeTelegram;
  drive: FakeDrive;
  store: Store;
  cleanup: () => void;
}

export function createTestHarness(options: {
  claudeHandlers: CallAgentHandler | CallAgentHandler[];
  resolveHandlers?: CallAgentHandler | CallAgentHandler[];
  geminiConfig?: FakeGeminiConfig;
}): TestHarness {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lingua-test-")), "state.json");
  const store = new Store(tmpFile);

  const sheets = createFakeSheets();
  const telegram = createFakeTelegram();
  const drive = createFakeDrive();
  const gemini = createFakeGemini(options.geminiConfig);
  const claude = createFakeClaude(options.claudeHandlers);
  const resolveClaude = createFakeClaude(
    options.resolveHandlers ?? [
      async () => {
        throw new Error("createTestHarness: no resolveHandlers configured but resolveWithStaffInput was called");
      },
    ]
  );

  const deps: HandleMessageDeps = {
    spreadsheetId: "test-sheet",
    sheets: sheets.ops,
    ai: {
      ...gemini,
      callAgent: claude.callAgent,
      resolveWithStaffInput: (context, staffInstruction, agentProfile) =>
        resolveClaude.callAgent(context, staffInstruction, agentProfile),
    },
    drive: drive.ops,
    telegram: telegram.ops,
    store,
    priceList: TEST_PRICE_LIST,
    agentProfile: "(test profile)",
    prepaymentPercent: 50,
    standardTurnaroundDays: 6,
  };

  return {
    deps,
    sheets,
    telegram,
    drive,
    store,
    cleanup: () => fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }),
  };
}
