import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
import { BUSINESS_RULES } from "./businessRules.js";
import type { ChatMessageRecord } from "../state/store.js";
import type { OrderRecord } from "../sheets/orders.js";
import type { PriceList } from "../sheets/priceList.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILE_PATH = path.resolve(__dirname, "../../agent_profile.md");

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

export function loadAgentProfile(filePath: string = DEFAULT_PROFILE_PATH): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "(agent_profile.md not found - using business rules only)";
  }
}

export const lineItemSchema = z.object({
  serviceType: z.enum(["translation", "apostille"]),
  quantity: z.number().int().positive(),
  translationTier: z.enum(["standard", "notarized"]).optional(),
  translationPurpose: z.enum(["soliq_qaytarish", "other"]).nullable().optional(),
  apostilleDocType: z.string().optional(),
  sourceLang: z.string().optional(),
  targetLang: z.string().optional(),
});

export const orderUpdateSchema = z.object({
  existingOrderId: z.string().nullable().optional(),
  clientName: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  lineItems: z.array(lineItemSchema).default([]),
  documentsDescription: z.string().nullable().optional(),
  urgency: z.string().nullable().optional(),
  deliveryMethod: z.string().nullable().optional(),
  paymentConfirmed: z.boolean().default(false),
  notes: z.string().nullable().optional(),
});

export const agentResponseSchema = z.object({
  clientReplyUz: z.string().min(1),
  escalate: z.boolean().default(false),
  escalationReason: z.string().nullable().optional(),
  orderUpdate: orderUpdateSchema.nullable().optional(),
});

export type OrderUpdate = z.infer<typeof orderUpdateSchema>;
export type AgentResponse = z.infer<typeof agentResponseSchema>;

const SUBMIT_RESPONSE_TOOL: Anthropic.Tool = {
  name: "submit_response",
  description:
    "Submit the reply to send the client plus any structured order data. Must always be called - never answer in plain text.",
  input_schema: {
    type: "object",
    properties: {
      clientReplyUz: {
        type: "string",
        description: "The reply to send to the client, in Uzbek, Latin script, always.",
      },
      escalate: {
        type: "boolean",
        description: "True if this situation must be handed to a human (discount request, cancel/modify request, unclear context gap, or anything else outside the hard rules).",
      },
      escalationReason: {
        type: ["string", "null"],
        description: "Short reason for escalation, for the work-chat notification. Null if escalate=false.",
      },
      orderUpdate: {
        type: ["object", "null"],
        description: "Structured order data if this message advances an order (new or existing). Null if no order-relevant info yet.",
        properties: {
          existingOrderId: { type: ["string", "null"] },
          clientName: { type: ["string", "null"] },
          phone: { type: ["string", "null"] },
          lineItems: {
            type: "array",
            items: {
              type: "object",
              properties: {
                serviceType: { type: "string", enum: ["translation", "apostille"] },
                quantity: { type: "number" },
                translationTier: { type: "string", enum: ["standard", "notarized"] },
                translationPurpose: { type: ["string", "null"], enum: ["soliq_qaytarish", "other", null] },
                apostilleDocType: { type: "string" },
                sourceLang: { type: "string" },
                targetLang: { type: "string" },
              },
              required: ["serviceType", "quantity"],
            },
          },
          documentsDescription: { type: ["string", "null"] },
          urgency: { type: ["string", "null"] },
          deliveryMethod: { type: ["string", "null"] },
          paymentConfirmed: { type: "boolean" },
          notes: { type: ["string", "null"] },
        },
      },
    },
    required: ["clientReplyUz", "escalate"],
  },
};

export interface BuildContextInput {
  priceList: PriceList;
  history: ChatMessageRecord[];
  openOrders: OrderRecord[];
  extractedText?: string | null;
  prepaymentPercent: number;
  standardTurnaroundDays: number;
}

export function buildSystemPrompt(input: BuildContextInput, agentProfile: string): string {
  return [
    BUSINESS_RULES,
    "",
    `PREPAYMENT_PERCENT: ${input.prepaymentPercent}`,
    `STANDARD_TURNAROUND_DAYS: ${input.standardTurnaroundDays}`,
    "",
    "--- AGENT PROFILE / STYLE GUIDE (editable by business owner) ---",
    agentProfile,
    "",
    "--- PRICE LIST (authoritative, JSON) ---",
    JSON.stringify(input.priceList, null, 2),
    "",
    "--- CLIENT'S CURRENTLY OPEN ORDERS ---",
    input.openOrders.length > 0 ? JSON.stringify(input.openOrders, null, 2) : "(none)",
  ].join("\n");
}

export function buildUserMessage(
  history: ChatMessageRecord[],
  latestClientMessage: string,
  extractedText?: string | null
): string {
  const historyText = history
    .slice(-30)
    .map((m) => `${m.role === "client" ? "Client" : "Agent"}: ${m.text}`)
    .join("\n");

  const parts = [
    "--- RECENT CONVERSATION HISTORY ---",
    historyText || "(no prior history)",
    "",
    "--- NEW INCOMING MESSAGE ---",
    latestClientMessage,
  ];

  if (extractedText) {
    parts.push("", "--- DATA EXTRACTED FROM ATTACHED FILE/VOICE (by Gemini) ---", extractedText);
  }

  return parts.join("\n");
}

export async function callAgent(
  context: BuildContextInput,
  latestClientMessage: string,
  agentProfile: string = loadAgentProfile()
): Promise<AgentResponse> {
  const anthropic = getClient();
  const system = buildSystemPrompt(context, agentProfile);
  const userMessage = buildUserMessage(context.history, latestClientMessage, context.extractedText);

  const response = await withRetry(
    () =>
      anthropic.messages.create({
        model: env.CLAUDE_MODEL,
        max_tokens: 1500,
        thinking: { type: "disabled" },
        system,
        messages: [{ role: "user", content: userMessage }],
        tools: [SUBMIT_RESPONSE_TOOL],
        tool_choice: { type: "tool", name: "submit_response" },
      }),
    {
      attempts: 2,
      onRetry: (err, attempt) => logger.warn({ err, attempt }, "Claude call retry"),
    }
  );

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude did not return a submit_response tool call");
  }

  const parsed = agentResponseSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues }, "Claude tool output failed validation");
    throw new Error("Claude response failed schema validation");
  }

  return parsed.data;
}

/**
 * Used when a staff member resolves a paused/escalated conversation by replying to the
 * escalation notice in the work chat (rule: agent never invents its own resolution to an
 * escalated situation, but once a human has decided, the agent phrases it naturally in
 * the client's language/style). The full conversation history - including any messages
 * the client sent while paused - is included so nothing is silently skipped.
 */
export async function resolveWithStaffInput(
  context: BuildContextInput,
  staffInstruction: string,
  agentProfile: string = loadAgentProfile()
): Promise<AgentResponse> {
  const anthropic = getClient();
  const system = buildSystemPrompt(context, agentProfile);

  const historyText = context.history
    .slice(-30)
    .map((m) => `${m.role === "client" ? "Client" : "Agent"}: ${m.text}`)
    .join("\n");

  const userMessage = [
    "--- FULL CONVERSATION HISTORY (including any messages sent while paused for escalation) ---",
    historyText || "(no prior history)",
    "",
    "--- STAFF RESOLUTION ---",
    "A human staff member has just resolved the escalated situation with this instruction.",
    "Do not second-guess or override it - phrase it as a natural client-facing reply in your",
    "usual tone, addressing everything relevant in the conversation history above (including",
    "any messages the client sent while the conversation was paused). If the instruction",
    "implies a concrete order/price change, reflect that in orderUpdate as usual.",
    "",
    `Staff instruction: ${staffInstruction}`,
  ].join("\n");

  const response = await withRetry(
    () =>
      anthropic.messages.create({
        model: env.CLAUDE_MODEL,
        max_tokens: 1500,
        thinking: { type: "disabled" },
        system,
        messages: [{ role: "user", content: userMessage }],
        tools: [SUBMIT_RESPONSE_TOOL],
        tool_choice: { type: "tool", name: "submit_response" },
      }),
    {
      attempts: 2,
      onRetry: (err, attempt) => logger.warn({ err, attempt }, "Claude call retry (staff resolution)"),
    }
  );

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude did not return a submit_response tool call (staff resolution)");
  }

  const parsed = agentResponseSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues },
      "Claude tool output failed validation (staff resolution)"
    );
    throw new Error("Claude response failed schema validation (staff resolution)");
  }

  return parsed.data;
}
