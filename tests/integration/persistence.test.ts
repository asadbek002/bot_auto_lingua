import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/state/store.js";
import { handleMessage } from "../../src/pipeline/handleMessage.js";
import { createTestHarness, type TestHarness } from "../mocks/harness.js";
import { baseAgentResponse } from "../mocks/claudeMock.js";

/**
 * ТЗ integration test #6: force a "crash" mid-dialogue (drop the in-memory Store and
 * re-instantiate it from disk, simulating a process restart) and confirm conversation
 * history and idempotency state survived - not just held in memory.
 */
describe("persistence across restart (ТЗ integration scenario #6)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps conversation history and processed-update idempotency after the process restarts", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingua-persist-"));
    const stateFile = path.join(tmpDir, "state.json");

    const store1 = new Store(stateFile);
    const harness: TestHarness = { ...createTestHarness({ claudeHandlers: [] }) };
    // Swap in the real on-disk store instead of the harness's throwaway temp one.
    harness.deps.store = store1;
    harness.deps.ai.callAgent = async () =>
      baseAgentResponse({ clientReplyUz: "Assalomu alaykum, xush kelibsiz!" });

    await handleMessage(
      {
        updateId: 42,
        clientUserId: "9001",
        clientName: "Nodira",
        businessConnectionId: "test-business-connection",
        clientChatId: 9001,
        kind: "text",
        text: "Salom",
      },
      harness.deps
    );

    expect(store1.getConversation("client:9001")).toHaveLength(2);
    expect(store1.hasProcessedUpdate(42)).toBe(true);

    // Simulate the process dying and restarting: throw away store1, read fresh from disk.
    const store2 = new Store(stateFile);

    expect(store2.getConversation("client:9001")).toHaveLength(2);
    expect(store2.getConversation("client:9001")[0]!.text).toBe("Salom");
    expect(store2.getConversation("client:9001")[1]!.text).toMatch(/Assalomu alaykum/);
    expect(store2.hasProcessedUpdate(42)).toBe(true);

    // A redelivery of the same update_id after "restart" must be a no-op (idempotency
    // survives the restart, not just the in-memory run).
    const claudeCallsBefore = 0;
    let claudeCalls = claudeCallsBefore;
    harness.deps.store = store2;
    harness.deps.ai.callAgent = async () => {
      claudeCalls += 1;
      return baseAgentResponse({ clientReplyUz: "should not be called again" });
    };
    await handleMessage(
      {
        updateId: 42,
        clientUserId: "9001",
        clientName: "Nodira",
        businessConnectionId: "test-business-connection",
        clientChatId: 9001,
        kind: "text",
        text: "Salom",
      },
      harness.deps
    );
    expect(claudeCalls).toBe(0);
    expect(store2.getConversation("client:9001")).toHaveLength(2);

    harness.cleanup();
  });
});
