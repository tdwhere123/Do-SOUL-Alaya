import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });

import { ALAYA_MCP_SERVER_INSTRUCTIONS } from "@do-soul/alaya/mcp-server";
import { SOUL_RECALL_CALLER_GUIDANCE, soulToolDefs } from "@do-soul/alaya-engine-gateway";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { projectLiveSurfaceForCaller } from "../../../runs/recall-measurement/text-mcp-consumer/caller-capability-profile.js";
import {
  TEXT_MCP_ACTION_PROTOCOL, TEXT_MCP_ALLOWED_READ_TOOLS, TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION,
  TEXT_MCP_CONSUMER_REMOTE_BLOCKED_MESSAGE, TextMcpConsumerInputSchema
} from "../../../runs/recall-measurement/text-mcp-consumer/contract.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { bindTextMcpGatewayBody, decodeTextMcpAction, encodeTextMcpRequest,
  textMcpUtf8Bytes, TEXT_MCP_ACTION_RESPONSE_JSON_SCHEMA, TEXT_MCP_ACTION_SCHEMA_NAME }
  from "../../../runs/recall-measurement/text-mcp-consumer/codec.js";
import { projectSingleCopyToolResult } from "../../../runs/recall-measurement/text-mcp-consumer/single-copy-projection.js";
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

it("discloses zero remaining tool calls immediately before events and preserves other prompt bytes", () => {
  const input = { surface, query: "Which project?", events: [] };
  const initial = encodeTextMcpRequest(input);
  expect(initial.userPrompt).toBe("CALLER_QUERY:\nWhich project?\nEVENTS:\n(none)");
  expect(encodeTextMcpRequest({ ...input, remaining_tool_calls: 1 })).toEqual(initial);
  const exhausted = encodeTextMcpRequest({ ...input, remaining_tool_calls: 0 });
  expect(exhausted.systemPrompt).toBe(initial.systemPrompt);
  expect(exhausted.userPrompt).toBe([
    "CALLER_QUERY:", input.query,
    'TOOL_BUDGET_STATUS: No tool calls remain (0 remaining). Answer now from the evidence already returned using {"action":"answer","text":"..."}; state uncertainty if needed.',
    "EVENTS:", "(none)"
  ].join("\n"));
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
    description: [...SOUL_RECALL_CALLER_GUIDANCE, "Keep payload_continuation."].join("\n"),
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
  expect(plain.systemPrompt).not.toContain("question_time");
  expect(plain.systemPrompt).toContain("For conversation passages");
  expect(plain.systemPrompt).not.toContain("definitions above are unmodified");
  expect(plain.systemPrompt).toContain("payload_continuation");
  expect(plain.userPrompt.startsWith("Current date: 2023/09/13\nCALLER_QUERY:")).toBe(true);
  expect(omitted.userPrompt.startsWith("CALLER_QUERY:")).toBe(true);
});

it("strips evidence_conditions and query_coordinates for plain_query while retaining the concrete example for caller_coordinates", () => {
  const recallDef = soulToolDefs.find(tool => tool.name === "soul.recall");
  expect(recallDef).toBeDefined();
  const liveSurface = {
    ...surface,
    instructions: ALAYA_MCP_SERVER_INSTRUCTIONS,
    tools: [{
      name: "soul.recall",
      description: recallDef!.description,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, query_coordinates: { type: "object" }, interpretation_proposal: { type: "object" } },
        required: ["query"]
      }
    }]
  };

  const callerCoordinates = projectLiveSurfaceForCaller(liveSurface, "caller_coordinates");
  const callerRecall = callerCoordinates.tools[0] as { description: string };
  expect(callerCoordinates.instructions).toContain('"evidence_conditions": [{"statement":');
  expect(callerCoordinates.instructions).toContain('"evidence_relation": "derived"');
  expect(callerRecall.description).toContain('"evidence_conditions": [{"statement":');
  expect(callerRecall.description).toContain('"evidence_relation": "derived"');

  const plainQuery = projectLiveSurfaceForCaller(liveSurface, "plain_query");
  const plainRecall = plainQuery.tools[0] as { description: string };
  expect(plainQuery.instructions).not.toMatch(/query_coordinates|evidence_conditions|evidence_relation|question_time|interpretation_proposal/u);
  expect(plainRecall.description).not.toMatch(/query_coordinates|evidence_conditions|evidence_relation|question_time|interpretation_proposal/u);
  expect(plainQuery.instructions).toContain("For conversation passages");
  expect(plainRecall.description).toContain("For conversation passages");
});

it("strips soul.interpretation from caller_coordinates and plain_query surfaces while leaving consumer tools untouched", () => {
  const recallTool = {
    name: "soul.recall",
    description: "Optional caller coordinates on soul.recall ...\nKeep consumer tool.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, query_coordinates: { type: "object" } },
      required: ["query"]
    }
  };
  const openPointerTool = {
    name: "soul.open_pointer",
    description: "Open pointer",
    inputSchema: { type: "object", properties: { object_id: { type: "string" } }, required: ["object_id"] }
  };
  const interpretationTool = {
    name: "soul.interpretation",
    description: "Host interpretation tool",
    inputSchema: { type: "object", properties: { operation: { type: "string" } } }
  };
  const hostSurface = {
    ...surface,
    instructions: "Keep instructions.",
    tools: [recallTool, interpretationTool, openPointerTool]
  };

  const callerCoordinates = projectLiveSurfaceForCaller(hostSurface, "caller_coordinates");
  expect(callerCoordinates.tools.map((tool) => (tool as { name: string }).name)).toEqual([
    "soul.recall",
    "soul.open_pointer"
  ]);
  expect((callerCoordinates.tools[0] as { inputSchema: { properties: Record<string, unknown> } }).inputSchema.properties)
    .toHaveProperty("query_coordinates");
  expect(callerCoordinates.tools[1]).toEqual(openPointerTool);

  const plainQuery = projectLiveSurfaceForCaller(hostSurface, "plain_query");
  expect(plainQuery.tools.map((tool) => (tool as { name: string }).name)).toEqual([
    "soul.recall",
    "soul.open_pointer"
  ]);
  expect((plainQuery.tools[0] as { inputSchema: { properties: Record<string, unknown> } }).inputSchema.properties)
    .not.toHaveProperty("query_coordinates");
  expect(plainQuery.tools[1]).toEqual(openPointerTool);

  const consumerSurface = {
    ...surface,
    instructions: "Keep instructions.",
    tools: [recallTool, openPointerTool]
  };
  expect(projectLiveSurfaceForCaller(consumerSurface, "caller_coordinates")).toBe(consumerSurface);
  expect(projectLiveSurfaceForCaller(consumerSurface, undefined)).toBe(consumerSurface);
});

it("projects duplicate CallToolResult text envelopes to a single structuredContent copy without mutating the audit envelope", () => {
  const payload = { ok: true, tool_name: "soul.recall", output: { results: [{ id: "r1", text: "Aster" }] } };
  const envelope = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    _meta: { trace: "t-1" }
  };
  const snapshot = structuredClone(envelope);
  const projected = projectSingleCopyToolResult(envelope);
  expect(projected).toEqual({ structuredContent: payload, _meta: { trace: "t-1" } });
  expect(projected).not.toHaveProperty("content");
  expect(envelope).toEqual(snapshot);

  const encoded = encodeTextMcpRequest({
    surface,
    query: "Which project was mentioned?",
    events: [{
      kind: "mcp_call", origin: "model_selected", tool: "soul.recall",
      arguments: { query: "Which project was mentioned?" }, response_state: "received", envelope
    }]
  });
  expect(encoded.userPrompt).toContain(`mcp_envelope:\n${canonicalJson(projected)}`);
  expect(encoded.userPrompt).not.toContain(canonicalJson(envelope));
  expect(envelope).toEqual(snapshot);
});

it("collapses canonical key-order and whitespace differences while rejecting array/value mismatches", () => {
  const structuredContent = { z: 2, a: { d: 4, c: [1, 2] } };
  const reordered = {
    content: [{ type: "text", text: '{\n  "a": { "c": [1, 2], "d": 4 },\n  "z": 2\n}' }],
    structuredContent
  };
  expect(projectSingleCopyToolResult(reordered)).toEqual({ structuredContent });

  const arrayReordered = {
    content: [{ type: "text", text: '{"a":{"c":[2,1],"d":4},"z":2}' }],
    structuredContent
  };
  expect(projectSingleCopyToolResult(arrayReordered)).toEqual(arrayReordered);

  const typeMismatch = {
    content: [{ type: "text", text: '{"z":"2","a":{"d":4,"c":[1,2]}}' }],
    structuredContent
  };
  expect(projectSingleCopyToolResult(typeMismatch)).toEqual(typeMismatch);
});

it("preserves content verbatim for non-duplicate text, non-text, multi-block, invalid JSON, extra block metadata, and error envelopes", () => {
  const payload = { ok: false, error: { code: "VALIDATION", message: "bad input" } };
  const duplicateError = {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    _meta: { requestId: "req-1" }
  };
  expect(projectSingleCopyToolResult(duplicateError)).toEqual({
    isError: true,
    structuredContent: payload,
    _meta: { requestId: "req-1" }
  });

  const distinctDiagnosticError = {
    isError: true,
    content: [{ type: "text", text: "Distinct diagnostic text for operator" }],
    structuredContent: payload
  };
  expect(projectSingleCopyToolResult(distinctDiagnosticError)).toEqual(distinctDiagnosticError);

  const distinctJsonText = {
    content: [{ type: "text", text: JSON.stringify({ ...payload, extraNote: "keep" }) }],
    structuredContent: payload
  };
  expect(projectSingleCopyToolResult(distinctJsonText)).toEqual(distinctJsonText);

  const multiBlock = {
    content: [{ type: "text", text: JSON.stringify(payload) }, { type: "text", text: "second block" }],
    structuredContent: payload
  };
  expect(projectSingleCopyToolResult(multiBlock)).toEqual(multiBlock);

  const nonText = {
    content: [{ type: "image", data: "abc", mimeType: "image/png" }],
    structuredContent: payload
  };
  expect(projectSingleCopyToolResult(nonText)).toEqual(nonText);

  const annotatedBlock = {
    content: [{ type: "text", text: JSON.stringify(payload), annotations: { audience: ["assistant"] } }],
    structuredContent: payload
  };
  expect(projectSingleCopyToolResult(annotatedBlock)).toEqual(annotatedBlock);

  const missingStructured = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  expect(projectSingleCopyToolResult(missingStructured)).toEqual(missingStructured);
});

it("preserves non-JSON structured values (Date, NaN/Infinity, 1e400 overflow) and never invokes toJSON or getters", () => {
  const dateEnvelope = {
    content: [{ type: "text", text: '{"x":"2026-01-01T00:00:00.000Z"}' }],
    structuredContent: { x: new Date("2026-01-01T00:00:00.000Z") }
  };
  expect(projectSingleCopyToolResult(dateEnvelope)).toBe(dateEnvelope);

  const nanEnvelope = {
    content: [{ type: "text", text: '{"n":null}' }],
    structuredContent: { n: Number.NaN }
  };
  expect(projectSingleCopyToolResult(nanEnvelope)).toBe(nanEnvelope);

  const infEnvelope = {
    content: [{ type: "text", text: '{"n":null}' }],
    structuredContent: { n: Number.POSITIVE_INFINITY }
  };
  expect(projectSingleCopyToolResult(infEnvelope)).toBe(infEnvelope);

  const overflowEnvelope = {
    content: [{ type: "text", text: '{"n":1e400}' }],
    structuredContent: { n: Number.POSITIVE_INFINITY }
  };
  expect(projectSingleCopyToolResult(overflowEnvelope)).toBe(overflowEnvelope);

  let toJsonCalled = 0;
  const toJsonEnvelope = {
    content: [{ type: "text", text: '{"a":1}' }],
    structuredContent: {
      a: 1,
      toJSON() {
        toJsonCalled += 1;
        return { a: 1 };
      }
    }
  };
  expect(projectSingleCopyToolResult(toJsonEnvelope)).toBe(toJsonEnvelope);
  expect(toJsonCalled).toBe(0);

  let getterCalled = 0;
  const getterObj: Record<string, unknown> = {};
  Object.defineProperty(getterObj, "a", {
    enumerable: true,
    get() {
      getterCalled += 1;
      return 1;
    }
  });
  const getterEnvelope = {
    content: [{ type: "text", text: '{"a":1}' }],
    structuredContent: getterObj
  };
  expect(projectSingleCopyToolResult(getterEnvelope)).toBe(getterEnvelope);
  expect(getterCalled).toBe(0);
});

it("preserves non-enumerable properties, custom Array prototypes, and rounded/underflowed JSON numbers verbatim", () => {
  const hiddenKeyObj: Record<string, unknown> = { shown: 2 };
  Object.defineProperty(hiddenKeyObj, "hidden", { value: 1, enumerable: false });
  const hiddenEnvelope = {
    content: [{ type: "text", text: '{"hidden":1}' }],
    structuredContent: hiddenKeyObj
  };
  expect(projectSingleCopyToolResult(hiddenEnvelope)).toBe(hiddenEnvelope);

  let arrayToJsonCalled = 0;
  const customArray = [1];
  Object.setPrototypeOf(customArray, {
    toJSON() {
      arrayToJsonCalled += 1;
      return [2];
    }
  });
  const customArrayEnvelope = {
    content: [{ type: "text", text: "[2]" }],
    structuredContent: customArray
  };
  expect(projectSingleCopyToolResult(customArrayEnvelope)).toBe(customArrayEnvelope);
  expect(arrayToJsonCalled).toBe(0);

  const roundedIntEnvelope = {
    content: [{ type: "text", text: '{"n":9007199254740993}' }],
    structuredContent: { n: 9007199254740992 }
  };
  expect(projectSingleCopyToolResult(roundedIntEnvelope)).toBe(roundedIntEnvelope);

  const underflowEnvelope = {
    content: [{ type: "text", text: '{"n":1e-400}' }],
    structuredContent: { n: 0 }
  };
  expect(projectSingleCopyToolResult(underflowEnvelope)).toBe(underflowEnvelope);

  const quotedBigIntTextEnvelope = {
    content: [{ type: "text", text: '{\n  "n": "9007199254740993",\n  "v": 1e+21\n}' }],
    structuredContent: { v: 1e+21, n: "9007199254740993" }
  };
  expect(projectSingleCopyToolResult(quotedBigIntTextEnvelope)).toEqual({
    structuredContent: { v: 1e+21, n: "9007199254740993" }
  });
});

it("preserves envelopes whose text JSON has duplicate object keys while collapsing distinct sibling keys", () => {
  const topDuplicate = {
    content: [{ type: "text", text: '{"n":1,"n":2}' }],
    structuredContent: { n: 2 }
  };
  expect(projectSingleCopyToolResult(topDuplicate)).toBe(topDuplicate);

  const nestedDuplicate = {
    content: [{ type: "text", text: '{"a":{"x":1,"x":1}}' }],
    structuredContent: { a: { x: 1 } }
  };
  expect(projectSingleCopyToolResult(nestedDuplicate)).toBe(nestedDuplicate);

  const escapedDuplicate = {
    content: [{ type: "text", text: '{"a":1,"\\u0061":2}' }],
    structuredContent: { a: 2 }
  };
  expect(projectSingleCopyToolResult(escapedDuplicate)).toBe(escapedDuplicate);

  const siblingKeysEnvelope = {
    content: [{ type: "text", text: '{\n  "b": { "x": 2 },\n  "a": { "x": 1 }\n}' }],
    structuredContent: { a: { x: 1 }, b: { x: 2 } }
  };
  expect(projectSingleCopyToolResult(siblingKeysEnvelope)).toEqual({
    structuredContent: { a: { x: 1 }, b: { x: 2 } }
  });
});

it("handles deeply nested JSON text without stack overflow in encodeTextMcpRequest", () => {
  const deepUnderflowText = "[".repeat(4096) + "1e-400" + "]".repeat(4096);
  const deepValidText = "[".repeat(4096) + "1" + "]".repeat(4096);
  for (const text of [deepUnderflowText, deepValidText]) {
    const envelope = {
      content: [{ type: "text", text }],
      structuredContent: { n: 0 }
    };
    const encoded = encodeTextMcpRequest({
      surface,
      query: "Deep JSON check",
      events: [{
        kind: "host_setup",
        generated_by: "host_controlled_setup",
        tool: "soul.recall",
        arguments: { query: "Deep JSON check" },
        response_state: "received",
        envelope
      }]
    });
    expect(encoded.userPrompt).toContain(canonicalJson(envelope));
  }

  let deepStructured: unknown = 1;
  for (let i = 0; i < 8192; i += 1) deepStructured = [deepStructured];
  const deepStructuredEnvelope = { content: [{ type: "text", text: '{"n":0}' }], structuredContent: deepStructured };
  expect(projectSingleCopyToolResult(deepStructuredEnvelope)).toBe(deepStructuredEnvelope);
});

it("formats deeply nested structuredContent envelopes end-to-end without stack overflow", () => {
  for (const depth of [4096, 8192]) {
    let deepValue: unknown = 1;
    for (let i = 0; i < depth; i += 1) deepValue = i % 2 === 0 ? [deepValue] : { k: deepValue };
    const matchingText = canonicalJson(deepValue);
    const matchingEnvelope = {
      content: [{ type: "text", text: matchingText }],
      structuredContent: deepValue,
      isError: false
    };
    const collapsed = encodeTextMcpRequest({
      surface,
      query: "Deep structured single-copy check",
      events: [{
        kind: "mcp_call",
        generated_by: "model_selected_tool",
        tool: "soul.recall",
        arguments: { query: "Deep structured single-copy check" },
        response_state: "received",
        envelope: matchingEnvelope
      }]
    });
    expect(collapsed.userPrompt).toContain(canonicalJson({ structuredContent: deepValue, isError: false }));
    expect(collapsed.userPrompt).not.toContain('"content"');

    const nonMatchingEnvelope = {
      content: [{ type: "text", text: '{"other":true}' }],
      structuredContent: deepValue,
      isError: false
    };
    const preserved = encodeTextMcpRequest({
      surface,
      query: "Deep structured mismatch check",
      events: [{
        kind: "mcp_call",
        generated_by: "model_selected_tool",
        tool: "soul.recall",
        arguments: { query: "Deep structured mismatch check" },
        response_state: "received",
        envelope: nonMatchingEnvelope
      }]
    });
    expect(preserved.userPrompt).toContain(canonicalJson(nonMatchingEnvelope));
  }
});

it("preserves envelopes with non-enumerable properties, own getters, or non-plain content arrays verbatim", () => {
  const nonEnumStructured: Record<string, unknown> = { content: [{ type: "text", text: '{"x":1}' }] };
  Object.defineProperty(nonEnumStructured, "structuredContent", { value: { x: 1 }, enumerable: false });
  expect(projectSingleCopyToolResult(nonEnumStructured)).toBe(nonEnumStructured);
  const encodedNonEnum = encodeTextMcpRequest({
    surface,
    query: "Non-enumerable structuredContent",
    events: [{
      kind: "mcp_call",
      generated_by: "model_selected_tool",
      tool: "soul.recall",
      arguments: { query: "Non-enumerable structuredContent" },
      response_state: "received",
      envelope: nonEnumStructured
    }]
  });
  expect(encodedNonEnum.userPrompt).toContain('{"content":[{"text":"{\\"x\\":1}","type":"text"}]}');

  let getterReads = 0;
  const getterStructured: Record<string, unknown> = { content: [{ type: "text", text: '{"x":1}' }] };
  Object.defineProperty(getterStructured, "structuredContent", {
    enumerable: true,
    get() { getterReads += 1; return { x: 1 }; }
  });
  expect(projectSingleCopyToolResult(getterStructured)).toBe(getterStructured);

  const getterContent: Record<string, unknown> = { structuredContent: { x: 1 } };
  Object.defineProperty(getterContent, "content", {
    enumerable: true,
    get() { getterReads += 1; return [{ type: "text", text: '{"x":1}' }]; }
  });
  expect(projectSingleCopyToolResult(getterContent)).toBe(getterContent);

  const getterSlotArr: unknown[] = [];
  Object.defineProperty(getterSlotArr, 0, {
    enumerable: true,
    get() { getterReads += 1; return { type: "text", text: '{"x":1}' }; }
  });
  const getterSlotEnvelope = { content: getterSlotArr, structuredContent: { x: 1 } };
  expect(projectSingleCopyToolResult(getterSlotEnvelope)).toBe(getterSlotEnvelope);

  const getterBlock: Record<string, unknown> = { type: "text" };
  Object.defineProperty(getterBlock, "text", {
    enumerable: true,
    get() { getterReads += 1; return '{"x":1}'; }
  });
  const getterBlockEnvelope = { content: [getterBlock], structuredContent: { x: 1 } };
  expect(projectSingleCopyToolResult(getterBlockEnvelope)).toBe(getterBlockEnvelope);
  expect(getterReads).toBe(0);

  class CustomArray extends Array<unknown> {}
  const customArray = CustomArray.of({ type: "text", text: '{"x":1}' });
  const customArrayEnvelope = { content: customArray, structuredContent: { x: 1 } };
  expect(projectSingleCopyToolResult(customArrayEnvelope)).toBe(customArrayEnvelope);

  const extraNonEnumEnvelope: Record<string, unknown> = {
    content: [{ type: "text", text: '{"x":1}' }],
    structuredContent: { x: 1 }
  };
  Object.defineProperty(extraNonEnumEnvelope, "meta", { value: 1, enumerable: false });
  expect(projectSingleCopyToolResult(extraNonEnumEnvelope)).toBe(extraNonEnumEnvelope);

  const extraNonEnumBlock: Record<string, unknown> = { type: "text", text: '{"x":1}' };
  Object.defineProperty(extraNonEnumBlock, "meta", { value: 1, enumerable: false });
  const extraNonEnumBlockEnvelope = { content: [extraNonEnumBlock], structuredContent: { x: 1 } };
  expect(projectSingleCopyToolResult(extraNonEnumBlockEnvelope)).toBe(extraNonEnumBlockEnvelope);
});

it("refuses Proxy values (including throwing traps, forged toJSON, and revoked Proxies) without throwing", () => {
  const divergentContentProxy = new Proxy([{ type: "text", text: '{"x":1}' }], {
    get(target, key, receiver) {
      return key === "0" ? { type: "text", text: "distinct evidence" } : Reflect.get(target, key, receiver);
    }
  });
  const divergentEnvelope = { content: divergentContentProxy, structuredContent: { x: 1 } };
  expect(projectSingleCopyToolResult(divergentEnvelope)).toBe(divergentEnvelope);
  const encodedDivergent = encodeTextMcpRequest({
    surface,
    query: "Proxy content trap check",
    events: [{
      kind: "mcp_call",
      generated_by: "model_selected_tool",
      tool: "soul.recall",
      arguments: { query: "Proxy content trap check" },
      response_state: "received",
      envelope: divergentEnvelope
    }]
  });
  expect(encodedDivergent.userPrompt).toContain("distinct evidence");

  const throwingEnvelopeProxy = new Proxy(
    { content: [{ type: "text", text: '{"x":1}' }], structuredContent: { x: 1 } },
    { getPrototypeOf() { throw new Error("getPrototypeOf trap must not run"); } }
  );
  expect(projectSingleCopyToolResult(throwingEnvelopeProxy)).toBe(throwingEnvelopeProxy);
  expect(() => encodeTextMcpRequest({
    surface,
    query: "Throwing getPrototypeOf envelope proxy",
    events: [{
      kind: "mcp_call",
      generated_by: "model_selected_tool",
      tool: "soul.recall",
      arguments: { query: "Throwing getPrototypeOf envelope proxy" },
      response_state: "received",
      envelope: throwingEnvelopeProxy
    }]
  })).not.toThrow();

  const throwingContentProxy = new Proxy([{ type: "text", text: '{"x":1}' }], {
    getPrototypeOf() { throw new Error("getPrototypeOf trap must not run on content"); }
  });
  const throwingContentEnvelope = { content: throwingContentProxy, structuredContent: { x: 1 } };
  expect(projectSingleCopyToolResult(throwingContentEnvelope)).toBe(throwingContentEnvelope);
  expect(() => encodeTextMcpRequest({
    surface,
    query: "Throwing getPrototypeOf content proxy",
    events: [{
      kind: "mcp_call",
      generated_by: "model_selected_tool",
      tool: "soul.recall",
      arguments: { query: "Throwing getPrototypeOf content proxy" },
      response_state: "received",
      envelope: throwingContentEnvelope
    }]
  })).not.toThrow();

  const forgedToJsonProxy = new Proxy({ x: 2 }, {
    get(target, key, receiver) {
      return key === "toJSON" ? () => ({ x: 1 }) : Reflect.get(target, key, receiver);
    }
  });
  const forgedStructuredEnvelope = {
    content: [{ type: "text", text: '{"x":1}' }],
    structuredContent: forgedToJsonProxy
  };
  expect(projectSingleCopyToolResult(forgedStructuredEnvelope)).toBe(forgedStructuredEnvelope);
  const encodedForged = encodeTextMcpRequest({
    surface,
    query: "Forged toJSON proxy check",
    events: [{
      kind: "mcp_call",
      generated_by: "model_selected_tool",
      tool: "soul.recall",
      arguments: { query: "Forged toJSON proxy check" },
      response_state: "received",
      envelope: forgedStructuredEnvelope
    }]
  });
  expect(encodedForged.userPrompt).toContain('"content":[{"text":"{\\"x\\":1}","type":"text"}]');

  const revokedObj = Proxy.revocable({}, {});
  revokedObj.revoke();
  expect(projectSingleCopyToolResult(revokedObj.proxy)).toBe(revokedObj.proxy);
  const revokedContent = Proxy.revocable([{ type: "text", text: '{"x":1}' }], {});
  revokedContent.revoke();
  const revokedContentEnvelope = { content: revokedContent.proxy, structuredContent: { x: 1 } };
  expect(projectSingleCopyToolResult(revokedContentEnvelope)).toBe(revokedContentEnvelope);
});

it("blocks inherited Array.prototype Proxy, re-prototyped boxed primitives, and mutating sibling _meta Proxies", () => {
  const originalArrayProto = Object.getPrototypeOf(Array.prototype);
  const protoProxy = new Proxy(originalArrayProto ?? Object.prototype, {
    get(target, key, receiver) {
      return key === "toJSON" ? () => [2] : Reflect.get(target, key, receiver);
    }
  });
  Object.setPrototypeOf(Array.prototype, protoProxy);
  try {
    const inheritedProxyEnvelope = {
      content: [{ type: "text", text: '{"x":[2]}' }],
      structuredContent: { x: [1] }
    };
    expect(projectSingleCopyToolResult(inheritedProxyEnvelope)).toBe(inheritedProxyEnvelope);
    const encodedInherited = encodeTextMcpRequest({
      surface,
      query: "Inherited Array.prototype proxy",
      events: [{
        kind: "mcp_call",
        generated_by: "model_selected_tool",
        tool: "soul.recall",
        arguments: { query: "Inherited Array.prototype proxy" },
        response_state: "received",
        envelope: inheritedProxyEnvelope
      }]
    });
    expect(encodedInherited.userPrompt).toContain('{\\"x\\":[2]}');
  } finally {
    Object.setPrototypeOf(Array.prototype, originalArrayProto);
  }

  for (const [boxed, text] of [
    [Object.setPrototypeOf(Object(true), Object.prototype), '{"v":true}'],
    [Object.setPrototypeOf(Object(1), Object.prototype), '{"v":1}'],
    [Object.setPrototypeOf(Object("s"), Object.prototype), '{"v":"s"}']
  ] as const) {
    const boxedEnvelope = {
      content: [{ type: "text", text }],
      structuredContent: { v: boxed }
    };
    expect(projectSingleCopyToolResult(boxedEnvelope)).toBe(boxedEnvelope);
  }

  const structuredPayload = { x: 1 };
  const mutatingMeta = new Proxy({ tag: "m" }, {
    get(target, key, receiver) {
      structuredPayload.x = 2;
      return Reflect.get(target, key, receiver);
    }
  });
  const mutatingMetaEnvelope = {
    _meta: mutatingMeta,
    content: [{ type: "text", text: '{"x":1}' }],
    structuredContent: structuredPayload
  };
  expect(projectSingleCopyToolResult(mutatingMetaEnvelope)).toBe(mutatingMetaEnvelope);
  expect(structuredPayload.x).toBe(1);
  const encodedMutating = encodeTextMcpRequest({
    surface,
    query: "Mutating sibling _meta proxy",
    events: [{
      kind: "mcp_call",
      generated_by: "model_selected_tool",
      tool: "soul.recall",
      arguments: { query: "Mutating sibling _meta proxy" },
      response_state: "received",
      envelope: mutatingMetaEnvelope
    }]
  });
  expect(encodedMutating.userPrompt).toContain('{\\"x\\":1}');
});

it("blocks Object.prototype.value pollution, Array.prototype set traps, and deep-clones projected values", () => {
  const originalProtoValueDesc = Object.getOwnPropertyDescriptor(Object.prototype, "value");
  let reads = 0;
  const pollutedGetterEnvelope = {
    content: [{ type: "text", text: '{"x":1}' }],
    structuredContent: {
      get x() {
        reads += 1;
        return 1;
      }
    }
  };
  let pollutedProjected: unknown;
  let readsAfterProject = -1;
  let pollutedEncoded: ReturnType<typeof encodeTextMcpRequest>;
  Object.defineProperty(Object.prototype, "value", { value: 1, configurable: true, writable: true });
  try {
    pollutedProjected = projectSingleCopyToolResult(pollutedGetterEnvelope);
    readsAfterProject = reads;
    pollutedEncoded = encodeTextMcpRequest({
      surface,
      query: "Object.prototype.value pollution check",
      events: [{
        kind: "mcp_call",
        generated_by: "model_selected_tool",
        tool: "soul.recall",
        arguments: { query: "Object.prototype.value pollution check" },
        response_state: "received",
        envelope: pollutedGetterEnvelope
      }]
    });
  } finally {
    if (originalProtoValueDesc !== undefined) {
      Object.defineProperty(Object.prototype, "value", originalProtoValueDesc);
    } else {
      delete (Object.prototype as Record<string, unknown>).value;
    }
  }
  expect(pollutedProjected).toBe(pollutedGetterEnvelope);
  expect(readsAfterProject).toBe(0);
  expect(pollutedEncoded.userPrompt).toContain('"content":[{"text":"{\\"x\\":1}","type":"text"}]');

  const originalArrayProto = Object.getPrototypeOf(Array.prototype);
  const mutableStructured = { x: 1, nested: [2] };
  const guardedEnvelope = {
    content: [{ type: "text", text: "distinct evidence" }],
    structuredContent: mutableStructured
  };
  const setMutatingProxy = new Proxy(originalArrayProto ?? Object.prototype, {
    set() {
      mutableStructured.x = 2;
      throw new Error("inherited set trap must not run");
    }
  });
  let guardedProjected: unknown;
  Object.setPrototypeOf(Array.prototype, setMutatingProxy);
  try {
    guardedProjected = projectSingleCopyToolResult(guardedEnvelope);
  } finally {
    Object.setPrototypeOf(Array.prototype, originalArrayProto);
  }
  expect(guardedProjected).toBe(guardedEnvelope);
  expect(mutableStructured.x).toBe(1);

  const sourceEnvelope = {
    content: [{ type: "text", text: '{"items":[{"k":1}],"meta":{"flag":true}}' }],
    structuredContent: { items: [{ k: 1 }], meta: { flag: true } },
    _meta: { trace: [1, 2] }
  };
  const projected = projectSingleCopyToolResult(sourceEnvelope) as typeof sourceEnvelope;
  expect(projected).toEqual({
    structuredContent: { items: [{ k: 1 }], meta: { flag: true } },
    _meta: { trace: [1, 2] }
  });
  sourceEnvelope.structuredContent.items[0]!.k = 999;
  sourceEnvelope.structuredContent.meta.flag = false;
  sourceEnvelope._meta.trace[0] = 999;
  expect(projected.structuredContent.items[0]!.k).toBe(1);
  expect(projected.structuredContent.meta.flag).toBe(true);
  expect(projected._meta.trace[0]).toBe(1);

  const originalProtoSetDesc = Object.getOwnPropertyDescriptor(Object.prototype, "set");
  const duplicateForSetProto = {
    content: [{ type: "text", text: '{"x":1}' }],
    structuredContent: { x: 1 }
  };
  let setProtoProjected: unknown;
  Object.defineProperty(Object.prototype, "set", {
    value: undefined,
    configurable: true,
    writable: true
  });
  try {
    setProtoProjected = projectSingleCopyToolResult(duplicateForSetProto);
  } finally {
    if (originalProtoSetDesc !== undefined) {
      Object.defineProperty(Object.prototype, "set", originalProtoSetDesc);
    } else {
      delete (Object.prototype as Record<string, unknown>).set;
    }
  }
  expect(setProtoProjected).toEqual({ structuredContent: { x: 1 } });

  const originalArrayNeg1Desc = Object.getOwnPropertyDescriptor(Array.prototype, "-1");
  const topLevelStringEnvelope = {
    content: [{ type: "text", text: '"distinct evidence"' }],
    structuredContent: {}
  };
  let neg1Projected: unknown;
  Object.defineProperty(Array.prototype, "-1", {
    value: { kind: "obj", expectingKey: true },
    configurable: true,
    writable: true
  });
  try {
    neg1Projected = projectSingleCopyToolResult(topLevelStringEnvelope);
  } finally {
    if (originalArrayNeg1Desc !== undefined) {
      Object.defineProperty(Array.prototype, "-1", originalArrayNeg1Desc);
    } else {
      delete (Array.prototype as unknown as Record<string, unknown>)["-1"];
    }
  }
  expect(neg1Projected).toBe(topLevelStringEnvelope);
  expect((neg1Projected as typeof topLevelStringEnvelope).content[0]!.text).toBe('"distinct evidence"');
});

it("ignores Array.prototype[Symbol.iterator] mutations and rejects re-prototyped exotic internal-slot objects", () => {
  const originalArrayIterDesc = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  let iteratorGets = 0;
  const mutableStructured = { x: [1] };
  const envelopeWithArray = {
    content: [{ type: "text", text: '{"x":[1]}' }],
    structuredContent: mutableStructured
  };
  let iterProjected: unknown;
  Object.defineProperty(Array.prototype, Symbol.iterator, {
    configurable: true,
    get() {
      iteratorGets += 1;
      mutableStructured.x = [2];
      return originalArrayIterDesc?.value;
    }
  });
  try {
    iterProjected = projectSingleCopyToolResult(envelopeWithArray);
  } finally {
    if (originalArrayIterDesc !== undefined) {
      Object.defineProperty(Array.prototype, Symbol.iterator, originalArrayIterDesc);
    }
  }
  expect(iteratorGets).toBe(0);
  expect(mutableStructured.x).toEqual([1]);
  expect(iterProjected).toEqual({ structuredContent: { x: [1] } });

  const exoticSamples: unknown[] = [
    Object.setPrototypeOf(new Date(12345), Object.prototype),
    Object.setPrototypeOf(new Map(), Object.prototype),
    Object.setPrototypeOf(/re/, Object.prototype),
    Object.setPrototypeOf(new WeakRef({}), Object.prototype),
    Object.setPrototypeOf(new Intl.Collator(), Object.prototype)
  ];
  for (const exotic of exoticSamples) {
    const nestedEnvelope = {
      content: [{ type: "text", text: "{}" }],
      structuredContent: exotic
    };
    expect(projectSingleCopyToolResult(nestedEnvelope)).toBe(nestedEnvelope);
  }

  const exoticEnvelope = Object.setPrototypeOf(new Date(12345), Object.prototype) as unknown as Record<string, unknown>;
  exoticEnvelope.content = [{ type: "text", text: "{}" }];
  exoticEnvelope.structuredContent = {};
  expect(projectSingleCopyToolResult(exoticEnvelope)).toBe(exoticEnvelope);

  const deepCollatorLeaf = Object.assign(Object.setPrototypeOf(new Intl.Collator(), Object.prototype), { a: 1 });
  let deepCollator: unknown = deepCollatorLeaf;
  for (let depth = 0; depth < 8192; depth += 1) deepCollator = [deepCollator];
  const deepCollatorEnvelope = {
    content: [{ type: "text", text: "[".repeat(8192) + '{"a":1}' + "]".repeat(8192) }],
    structuredContent: deepCollator
  };
  expect(projectSingleCopyToolResult(deepCollatorEnvelope)).toBe(deepCollatorEnvelope);

  const deepIterLeaf = Object.assign(Object.setPrototypeOf([][Symbol.iterator](), Object.prototype), { a: 1 });
  let deepIter: unknown = deepIterLeaf;
  for (let depth = 0; depth < 8192; depth += 1) deepIter = [deepIter];
  const deepIterEnvelope = {
    content: [{ type: "text", text: "[".repeat(8192) + '{"a":1}' + "]".repeat(8192) }],
    structuredContent: deepIter
  };
  expect(projectSingleCopyToolResult(deepIterEnvelope)).toBe(deepIterEnvelope);

  let leftBranch: unknown = 1;
  for (let depth = 0; depth < 5000; depth += 1) leftBranch = { next: leftBranch };
  let rightInner: unknown = 1;
  for (let depth = 0; depth < 3000; depth += 1) rightInner = { next: rightInner };
  let rightBranch: unknown = Object.assign(Object.setPrototypeOf([][Symbol.iterator](), Object.prototype), { next: rightInner });
  for (let depth = 0; depth < 2000; depth += 1) rightBranch = { next: rightBranch };
  const twoBranchExoticEnvelope = {
    content: [{ type: "text", text: canonicalJson({ left: leftBranch, right: rightBranch }) }],
    structuredContent: { left: leftBranch, right: rightBranch }
  };
  expect(projectSingleCopyToolResult(twoBranchExoticEnvelope)).toBe(twoBranchExoticEnvelope);

  const WasmModule = (globalThis as unknown as {
    WebAssembly: { Module: new (bytes: Uint8Array) => object };
  }).WebAssembly.Module;
  const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const shallowWasm = Object.assign(
    Object.setPrototypeOf(new WasmModule(wasmBytes), Object.prototype),
    { hidden: Object.assign(Object.setPrototypeOf(new Intl.Collator(), Object.prototype), { a: 1 }) }
  );
  const shallowWasmEnvelope = {
    content: [{ type: "text", text: '{"nested":{"hidden":{"a":1}}}' }],
    structuredContent: { nested: shallowWasm }
  };
  expect(projectSingleCopyToolResult(shallowWasmEnvelope)).toBe(shallowWasmEnvelope);

  let deepLeft: unknown = 1;
  for (let depth = 0; depth < 8192; depth += 1) deepLeft = { next: deepLeft };
  const deepWasmLeaf = Object.assign(
    Object.setPrototypeOf(new WasmModule(wasmBytes), Object.prototype),
    { hidden: Object.assign(Object.setPrototypeOf(new Intl.Collator(), Object.prototype), { a: 1 }) }
  );
  let deepRight: unknown = deepWasmLeaf;
  for (let depth = 0; depth < 4000; depth += 1) deepRight = { next: deepRight };
  const deepWasmEnvelope = {
    content: [{ type: "text", text: canonicalJson({ left: deepLeft, right: deepRight }) }],
    structuredContent: { left: deepLeft, right: deepRight }
  };
  expect(projectSingleCopyToolResult(deepWasmEnvelope)).toBe(deepWasmEnvelope);

  const makeReprototypedBlob = (): Record<string, unknown> => {
    const blob = new Blob(["hi"]) as unknown as Record<PropertyKey, unknown>;
    for (const sym of Object.getOwnPropertySymbols(blob)) {
      delete blob[sym];
    }
    Object.setPrototypeOf(blob, Object.prototype);
    blob.a = 1;
    return blob as Record<string, unknown>;
  };

  const shallowBlob = makeReprototypedBlob();
  const shallowBlobEnvelope = {
    content: [{ type: "text", text: '{"x":{"a":1}}' }],
    structuredContent: { x: shallowBlob }
  };
  expect(projectSingleCopyToolResult(shallowBlobEnvelope)).toBe(shallowBlobEnvelope);

  let deepBlob: unknown = makeReprototypedBlob();
  for (let depth = 0; depth < 8192; depth += 1) deepBlob = [deepBlob];
  const deepBlobEnvelope = {
    content: [{ type: "text", text: "[".repeat(8192) + '{"a":1}' + "]".repeat(8192) }],
    structuredContent: deepBlob
  };
  expect(projectSingleCopyToolResult(deepBlobEnvelope)).toBe(deepBlobEnvelope);
});

it("rejects non-plain metadata and symbol properties without invoking getters or Object.prototype hooks", () => {
  let errGetterCalls = 0;
  const err = new Error("x");
  const errEnvelope: Record<string, unknown> = {
    content: [{ type: "text", text: '{"ok":1}' }],
    structuredContent: { ok: 1 },
    _meta: err,
  };
  Object.defineProperty(err, "message", {
    configurable: true,
    get() {
      errGetterCalls += 1;
      errEnvelope.structuredContent = { mutated: true };
      return "mutated";
    },
  });
  Object.defineProperty(err, "name", {
    configurable: true,
    get() {
      errGetterCalls += 1;
      errEnvelope.structuredContent = { mutated: true };
      return "MutatedError";
    },
  });
  expect(projectSingleCopyToolResult(errEnvelope)).toBe(errEnvelope);
  expect(errGetterCalls).toBe(0);
  expect(errEnvelope.structuredContent).toEqual({ ok: 1 });

  const symEnvelope = {
    content: [{ type: "text", text: '{"ok":1}' }],
    structuredContent: { ok: 1 },
    [Symbol("s")]: 1,
  };
  const nestedSymEnvelope = {
    content: [{ type: "text", text: '{"ok":1}' }],
    structuredContent: { ok: 1, [Symbol("s")]: 1 },
  };
  expect(projectSingleCopyToolResult(symEnvelope)).toBe(symEnvelope);
  expect(projectSingleCopyToolResult(nestedSymEnvelope)).toBe(nestedSymEnvelope);

  const protoKeys = ["get", "set", "toJSON", "aborted", "signal"] as const;
  const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();
  let protoGetterCalls = 0;
  let projectedValid: unknown;
  try {
    for (const key of protoKeys) {
      savedDescriptors.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
      Object.defineProperty(Object.prototype, key, {
        __proto__: null,
        configurable: true,
        get() {
          protoGetterCalls += 1;
          throw new Error(`Object.prototype.${key} must not run`);
        },
      } as unknown as PropertyDescriptor);
    }
    projectedValid = projectSingleCopyToolResult({
      content: [{ type: "text", text: '{"ok":1}' }],
      structuredContent: { ok: 1 },
    });
  } finally {
    for (const key of protoKeys) {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
    for (const key of protoKeys) {
      const orig = savedDescriptors.get(key);
      if (orig !== undefined) {
        Object.defineProperty(Object.prototype, key, {
          __proto__: null,
          ...orig,
        } as unknown as PropertyDescriptor);
      }
    }
  }
  expect(projectedValid).toEqual({ structuredContent: { ok: 1 } });
  expect(protoGetterCalls).toBe(0);
});

it("handles 24-level diamond DAG metadata in O(V+E) without exponential expansion", () => {
  let dag: Record<string, unknown> = { x: 1 };
  for (let i = 0; i < 24; i += 1) {
    dag = { a: dag, b: dag };
  }
  const distinctEnvelope = {
    content: [{ type: "text", text: '{"ok":2}' }],
    structuredContent: { ok: 1 },
    _meta: dag,
  };
  const matchingEnvelope = {
    content: [{ type: "text", text: '{"ok":1}' }],
    structuredContent: { ok: 1 },
    _meta: dag,
  };

  const t0 = performance.now();
  const distinctOut = projectSingleCopyToolResult(distinctEnvelope);
  const distinctMs = performance.now() - t0;
  expect(distinctOut).toBe(distinctEnvelope);
  expect(distinctMs).toBeLessThan(50);

  const t1 = performance.now();
  const matchedOut = projectSingleCopyToolResult(matchingEnvelope) as {
    structuredContent: { ok: number };
    _meta: { a: unknown; b: unknown };
  };
  const matchedMs = performance.now() - t1;
  expect(matchedOut).not.toBe(matchingEnvelope);
  expect(Object.hasOwn(matchedOut, "content")).toBe(false);
  expect(matchedOut.structuredContent).toEqual({ ok: 1 });
  expect(matchedOut._meta).not.toBe(dag);
  expect(matchedOut._meta.a).toBe(matchedOut._meta.b);
  expect(matchedMs).toBeLessThan(50);
});
