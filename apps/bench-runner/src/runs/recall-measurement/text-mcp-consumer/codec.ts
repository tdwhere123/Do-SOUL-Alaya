import { canonicalJson } from "@do-soul/alaya-protocol";
import { buildProviderChatRequestBody } from "@do-soul/alaya-engine-gateway";
import {
  TEXT_MCP_ACTION_PROTOCOL, TEXT_MCP_ALLOWED_READ_TOOLS, TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION,
  TEXT_MCP_SCRIPTED_MODEL, isAllowedTextMcpReadTool, type TextMcpCallerCapabilityProfile, type TextMcpDecodedAction,
  type TextMcpEncodedRequest, type TextMcpLiveSurface
} from "./contract.js";
import { projectLiveSurfaceForCaller } from "./caller-capability-profile.js";

/** Named schema for the provider-bound sender. Not the scripted jsonObject fixture. */
export const TEXT_MCP_ACTION_SCHEMA_NAME = "text_mcp_action" as const;
/** Standard JSON Schema union. Outer additionalProperties must not wrap oneOf or every action is forbidden. */
export const TEXT_MCP_ACTION_RESPONSE_JSON_SCHEMA = Object.freeze({
  oneOf: Object.freeze([
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["action", "tool", "arguments"]),
      properties: Object.freeze({
        action: Object.freeze({ const: "read" }),
        tool: Object.freeze({ enum: Object.freeze([...TEXT_MCP_ALLOWED_READ_TOOLS]) }),
        arguments: Object.freeze({ type: "object" })
      })
    }),
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["action", "text"]),
      properties: Object.freeze({
        action: Object.freeze({ const: "answer" }),
        text: Object.freeze({ type: "string" })
      })
    })
  ])
});

export function encodeTextMcpRequest(input: Readonly<{
  surface: TextMcpLiveSurface;
  query: string;
  events: readonly Record<string, unknown>[];
  caller_capability_profile?: TextMcpCallerCapabilityProfile;
  question_date?: string;
}>): TextMcpEncodedRequest {
  const surface = projectLiveSurfaceForCaller(input.surface, input.caller_capability_profile);
  const systemPrompt = [
    formatLiveInstructions(surface),
    "LIVE_MCP_SERVER:",
    canonicalJson({ version: surface.version, capabilities: surface.capabilities }),
    "LIVE_TOOLS:",
    canonicalJson(surface.tools),
    "DIAGNOSTIC_RESTRICTION:",
    TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION,
    "TEXT_ACTION_PROTOCOL:",
    TEXT_MCP_ACTION_PROTOCOL
  ].join("\n");
  const dated = input.question_date === undefined ? [] : [`Current date: ${input.question_date}`];
  return {
    systemPrompt,
    userPrompt: [...dated, "CALLER_QUERY:", input.query, "EVENTS:", formatEvents(input.events)].join("\n")
  };
}

/** Credential-free gateway body. Does not fetch, bind a grant, or load secrets. */
export function bindTextMcpGatewayBody(encoded: TextMcpEncodedRequest): Record<string, unknown> {
  return structuredClone(buildProviderChatRequestBody({
    providerUrl: "http://127.0.0.1:9", apiKey: "", model: TEXT_MCP_SCRIPTED_MODEL,
    systemPrompt: encoded.systemPrompt, userPrompt: encoded.userPrompt, jsonObject: true
  }));
}

export function decodeTextMcpAction(text: string): TextMcpDecodedAction {
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim()); }
  catch { return { kind: "invalid_action", reason: "unparseable_text" }; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid_action", reason: "non_object_action" };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.action === "answer") {
    if (keys.length !== 2 || typeof record.text !== "string") {
      return { kind: "invalid_action", reason: "invalid_answer" };
    }
    return { kind: "answer", text: record.text };
  }
  if (record.action !== "read") return { kind: "invalid_action", reason: "unknown_action" };
  if (keys.length !== 3 || typeof record.tool !== "string" || !isPlainObject(record.arguments)) {
    return { kind: "invalid_action", reason: "invalid_read" };
  }
  const tool = record.tool, args = structuredClone(record.arguments);
  if (!isAllowedTextMcpReadTool(tool)) {
    return { kind: "host_policy_refusal", tool, reason: "tool not on the diagnostic read allowlist" };
  }
  return { kind: "read", tool, arguments: args };
}

export function textMcpUtf8Bytes(encoded: TextMcpEncodedRequest): number {
  return Buffer.byteLength(encoded.systemPrompt, "utf8") + Buffer.byteLength(encoded.userPrompt, "utf8");
}

function formatLiveInstructions(surface: TextMcpLiveSurface): string {
  if (surface.instructions_status === "absent" || surface.instructions === null) {
    return "LIVE_INSTRUCTIONS_STATUS: absent";
  }
  return `LIVE_INSTRUCTIONS_STATUS: present\nLIVE_INSTRUCTIONS:\n${surface.instructions}`;
}

function formatEvents(events: readonly Record<string, unknown>[]): string {
  if (events.length === 0) return "(none)";
  return events.map((event, index) => formatEvent(event, index + 1)).join("\n");
}

function formatEvent(event: Record<string, unknown>, ordinal: number): string {
  const kind = typeof event.kind === "string" ? event.kind : "unknown";
  if (kind === "host_setup" || kind === "mcp_call") {
    const origin = kind === "host_setup" ? "controlled setup; not model-generated" : "model-selected";
    return [
      `--- ${kind} ordinal=${ordinal} origin=${origin} tool=${String(event.tool ?? "")}`,
      "arguments:", canonicalJson(event.arguments ?? null),
      `mcp_response_state: ${String(event.response_state ?? "unknown")}`,
      "mcp_envelope:", canonicalJson(event.envelope ?? null)
    ].join("\n");
  }
  if (kind === "model_turn") {
    return [
      `--- model_turn ordinal=${ordinal}`,
      `finish_reason: ${String(event.finishReason ?? null)}`,
      "decoded_action:", canonicalJson(event.decoded ?? null),
      "model_text:", typeof event.model_text === "string" ? event.model_text : canonicalJson(event.model_text ?? null)
    ].join("\n");
  }
  return `--- ${kind} ordinal=${ordinal}\n${canonicalJson(event)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
