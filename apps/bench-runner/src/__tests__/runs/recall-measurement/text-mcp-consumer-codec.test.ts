import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });

import { ALAYA_MCP_SERVER_INSTRUCTIONS } from "@do-soul/alaya/mcp-server";
import { canonicalJson } from "@do-soul/alaya-protocol";
import {
  TEXT_MCP_ACTION_PROTOCOL, TEXT_MCP_ALLOWED_READ_TOOLS, TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION,
  TEXT_MCP_CONSUMER_REMOTE_BLOCKED_MESSAGE, TextMcpConsumerInputSchema
} from "../../../runs/recall-measurement/text-mcp-consumer/contract.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { bindTextMcpGatewayBody, decodeTextMcpAction, encodeTextMcpRequest, textMcpUtf8Bytes,
  TEXT_MCP_ACTION_RESPONSE_JSON_SCHEMA, TEXT_MCP_ACTION_SCHEMA_NAME }
  from "../../../runs/recall-measurement/text-mcp-consumer/codec.js";
import { executeTextMcpConsumer } from "../../../runs/recall-measurement/text-mcp-consumer/execute.js";
import { prepareSemanticProviderRequest } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { sessionProviderConfig } from "../../support/text-mcp-provider-session-fixture.js";

const surface = {
  instructions_status: "present" as const,
  instructions: ALAYA_MCP_SERVER_INSTRUCTIONS,
  version: { name: "do-soul-alaya", version: "test" },
  capabilities: { tools: {} },
  tools: [{ name: "soul.recall", description: "recall fixture" }]
};

it("decodes allowed reads, terminal answers, host-policy writes, and invalid text independently", () => {
  expect(decodeTextMcpAction('{"action":"read","tool":"soul.recall","arguments":{"query":"Q"}}')).toEqual({
    kind: "read", tool: "soul.recall", arguments: { query: "Q" }
  });
  expect(decodeTextMcpAction('{"action":"read","tool":"soul.open_pointer","arguments":{"id":"p"}}')).toEqual({
    kind: "read", tool: "soul.open_pointer", arguments: { id: "p" }
  });
  expect(decodeTextMcpAction('{"action":"answer","text":"done"}')).toEqual({ kind: "answer", text: "done" });
  expect(decodeTextMcpAction('{"action":"read","tool":"soul.capture_host_session","arguments":{}}')).toEqual({
    kind: "host_policy_refusal", tool: "soul.capture_host_session",
    reason: "tool not on the diagnostic read allowlist"
  });
  expect(decodeTextMcpAction('{"action":"read","tool":"garden.claim_task","arguments":{}}').kind).toBe("host_policy_refusal");
  expect(decodeTextMcpAction("not-json")).toEqual({ kind: "invalid_action", reason: "unparseable_text" });
  expect(decodeTextMcpAction('{"action":"read","tool":"soul.recall","arguments":[]}')).toEqual({
    kind: "invalid_action", reason: "invalid_read"
  });
  expect(TEXT_MCP_ALLOWED_READ_TOOLS).toEqual(["soul.recall", "soul.open_pointer"]);
});

it("encodes live instructions and the diagnostic restriction without clipping envelopes or gold labels", () => {
  const envelope = { content: [{ type: "text", text: "LITERAL_ENVELOPE_TEXT" }], isError: false, extra: { nested: 1 } };
  const encoded = encodeTextMcpRequest({
    surface, query: "Which project was mentioned?",
    events: [{
      kind: "host_setup", generated_by: "host_controlled_setup", tool: "soul.recall",
      arguments: { query: "Which project was mentioned?" }, response_state: "received", envelope
    }]
  });
  expect(encoded.systemPrompt).toContain("LIVE_INSTRUCTIONS_STATUS: present");
  expect(encoded.systemPrompt).toContain(ALAYA_MCP_SERVER_INSTRUCTIONS);
  expect(encoded.systemPrompt).toContain(TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION);
  expect(encoded.systemPrompt).toContain(TEXT_MCP_ACTION_PROTOCOL);
  expect(encoded.systemPrompt).not.toMatch(/gold|question_type|EVALUATOR_ONLY/u);
  expect(encoded.userPrompt).toContain("controlled setup; not model-generated");
  expect(encoded.userPrompt).toContain(canonicalJson(envelope));
  expect(encoded.userPrompt).toContain("LITERAL_ENVELOPE_TEXT");
  expect(encoded.userPrompt).not.toContain("first_page");
  const body = bindTextMcpGatewayBody(encoded);
  expect(body.messages).toEqual([
    { role: "system", content: encoded.systemPrompt },
    { role: "user", content: encoded.userPrompt }
  ]);
  expect(JSON.stringify(body)).not.toContain("Bearer");
  expect(textMcpUtf8Bytes(encoded)).toBe(
    Buffer.byteLength(encoded.systemPrompt, "utf8") + Buffer.byteLength(encoded.userPrompt, "utf8")
  );
});

it("refuses gold fields on the consumer input and remote model execution without a grant", async () => {
  const ceilings = { max_model_turns: 1, max_tool_calls: 0, max_input_bytes: 100, max_output_bytes: 100, wall_ms: 1000 };
  expect(TextMcpConsumerInputSchema.safeParse({
    config: {}, root: "/tmp/text-mcp", query: { query_key: "a".repeat(64), original_query: "Q", gold: "no" },
    host_issued_initial_recall: false, model_kind: "scripted", ceilings
  }).success).toBe(false);
  expect(TextMcpConsumerInputSchema.safeParse({
    config: {}, root: "/tmp/text-mcp",
    query: { query_key: "a".repeat(64), original_query: "Q", interpretation_proposal: { gold: true } },
    host_issued_initial_recall: false, model_kind: "scripted", ceilings
  }).success).toBe(false);
  await expect(executeTextMcpConsumer({
    config: {}, root: "/tmp/text-mcp", query: { query_key: "a".repeat(64), original_query: "Q" },
    host_issued_initial_recall: false, model_kind: "remote",
    ceilings: { max_model_turns: 1, max_tool_calls: 0, max_input_bytes: 100, max_output_bytes: 100, wall_ms: 1000 }
  })).rejects.toMatchObject({ code: "UNAVAILABLE", message: TEXT_MCP_CONSUMER_REMOTE_BLOCKED_MESSAGE });
  await expect(executeTextMcpConsumer({
    config: {}, root: "/tmp/text-mcp", query: { query_key: "a".repeat(64), original_query: "Q" },
    host_issued_initial_recall: false, model_kind: "scripted",
    ceilings: { max_model_turns: 1, max_tool_calls: 0, max_input_bytes: 100, max_output_bytes: 100, wall_ms: 1000 }
  })).rejects.toMatchObject({ code: "VALIDATION" });
});

it("accepts intended text actions and rejects invalid shapes on the transmitted response_format schema", () => {
  const encoded = encodeTextMcpRequest({ surface, query: "Which project was mentioned?", events: [] });
  const body = JSON.parse(prepareSemanticProviderRequest(sessionProviderConfig(), {
    systemPrompt: encoded.systemPrompt, userPrompt: encoded.userPrompt, maxOutputTokens: 128,
    retryMode: "disabled", outputTokenField: "max_tokens", validateRawJson: () => undefined,
    responseJsonSchema: TEXT_MCP_ACTION_RESPONSE_JSON_SCHEMA
  }, TEXT_MCP_ACTION_SCHEMA_NAME).body) as {
    response_format?: { type?: string; json_schema?: { name?: string; schema?: object } };
  };
  expect(body.response_format?.type).toBe("json_schema");
  expect(body.response_format?.json_schema?.name).toBe(TEXT_MCP_ACTION_SCHEMA_NAME);
  const transmitted = body.response_format?.json_schema?.schema;
  expect(transmitted).toEqual(TEXT_MCP_ACTION_RESPONSE_JSON_SCHEMA);
  // Standard JSON Schema (Ajv), not a live-provider strict-subset or remote compatibility claim.
  const validate = new Ajv2020({ strict: false }).compile(transmitted!);
  expect(validate({ action: "read", tool: "soul.recall", arguments: { query: "Q" } })).toBe(true);
  expect(validate({ action: "read", tool: "soul.open_pointer", arguments: { id: "p" } })).toBe(true);
  expect(validate({ action: "answer", text: "done" })).toBe(true);
  expect(validate({ action: "read", tool: "soul.recall", arguments: { query: "Q" }, extra: true })).toBe(false);
  expect(validate({ action: "answer" })).toBe(false);
  expect(validate({ action: "write", tool: "soul.recall", arguments: {} })).toBe(false);
  expect(validate({})).toBe(false);
});

it("projects a plain-query surface and dates the user prompt without changing omitted encoding", () => {
  const tools = [{
    name: "soul.recall",
    description: "On soul.recall, optionally pass query_coordinates when temporal help. "
      + "For single-call coordinates, pass query_coordinates and evidence_conditions (1..4 anchors). Keep payload_continuation.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, query_coordinates: { type: "object" }, interpretation_proposal: { type: "object" } },
      required: ["query"]
    }
  }];
  const coordinateSurface = { ...surface, tools, instructions: ALAYA_MCP_SERVER_INSTRUCTIONS };
  const omitted = encodeTextMcpRequest({ surface: coordinateSurface, query: "Which project was mentioned?", events: [] });
  const coordinates = encodeTextMcpRequest({
    surface: coordinateSurface, query: "Which project was mentioned?", events: [],
    caller_capability_profile: "caller_coordinates"
  });
  const plain = encodeTextMcpRequest({
    surface: coordinateSurface, query: "Which project was mentioned?", events: [],
    caller_capability_profile: "plain_query", question_date: "2023/09/13"
  });
  expect(omitted.systemPrompt).toBe(coordinates.systemPrompt);
  expect(omitted.userPrompt).toBe(coordinates.userPrompt);
  expect(omitted.systemPrompt).toContain("query_coordinates");
  expect(plain.systemPrompt).not.toContain("query_coordinates");
  expect(plain.systemPrompt).not.toContain("interpretation_proposal");
  expect(plain.systemPrompt).not.toContain("evidence_conditions");
  expect(plain.systemPrompt).not.toContain("definitions above are unmodified");
  expect(plain.systemPrompt).toContain("payload_continuation");
  expect(plain.userPrompt.startsWith("Current date: 2023/09/13\nCALLER_QUERY:")).toBe(true);
  expect(omitted.userPrompt.startsWith("CALLER_QUERY:")).toBe(true);
});
