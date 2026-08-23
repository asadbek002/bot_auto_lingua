import type { AgentResponse, BuildContextInput } from "../../src/ai/claude.js";
import type { HandleMessageDeps } from "../../src/pipeline/handleMessage.js";

export type CallAgentHandler = (
  context: BuildContextInput,
  latestClientMessage: string,
  agentProfile?: string
) => Promise<AgentResponse> | AgentResponse;

export interface FakeClaude {
  calls: { context: BuildContextInput; latestClientMessage: string }[];
  callAgent: HandleMessageDeps["ai"]["callAgent"];
}

/**
 * Scriptable fake for Claude's callAgent: pass a queue of handlers (or a single
 * handler reused for every call) that decide what AgentResponse to return based on
 * the incoming message - lets tests simulate a multi-turn conversation deterministically
 * without hitting the real API.
 */
export function createFakeClaude(handlers: CallAgentHandler | CallAgentHandler[]): FakeClaude {
  const queue = Array.isArray(handlers) ? [...handlers] : null;
  const single = Array.isArray(handlers) ? null : handlers;
  const calls: FakeClaude["calls"] = [];

  const callAgent: HandleMessageDeps["ai"]["callAgent"] = async (context, latestClientMessage, agentProfile) => {
    calls.push({ context, latestClientMessage });
    const handler = queue ? queue.shift() : single;
    if (!handler) {
      throw new Error("createFakeClaude: no more scripted responses queued");
    }
    return handler(context, latestClientMessage, agentProfile);
  };

  return { calls, callAgent };
}

export function baseAgentResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    clientReplyUz: "Assalomu alaykum!",
    escalate: false,
    escalationReason: null,
    orderUpdate: null,
    ...overrides,
  };
}
