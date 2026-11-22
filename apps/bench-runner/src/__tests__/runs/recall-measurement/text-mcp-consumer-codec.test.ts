import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });

import { Ajv2020 } from "ajv/dist/2020.js";
import { ALAYA_MCP_SERVER_INSTRUCTIONS } from "@do-soul/alaya/mcp-server";
import { SOUL_RECALL_CALLER_GUIDANCE, soulToolDefs } from "@do-soul/alaya-engine-gateway";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { projectLiveSurfaceForCaller } from "../../../runs/recall-measurement/text-mcp-consumer/caller-capability-profile.js";
import {
  TEXT_MCP_ACTION_PROTOCOL, TEXT_MCP_ALLOWED_READ_TOOLS, TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION,
  TEXT_MCP_CONSUMER_REMOTE_BLOCKED_MESSAGE, TextMcpConsumerInputSchema
} from "../../../runs/recall-measurement/text-mcp-consumer/contract.js";
import {
  bindTextMcpGatewayBody, decodeTextMcpAction, encodeTextMcpRequest,
  textMcpUtf8Bytes, TEXT_MCP_ACTION_RESPONSE_JSON_SCHEMA, TEXT_MCP_ACTION_SCHEMA_NAME
} from "../../../runs/recall-measurement/text-mcp-consumer/codec.js";
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

function encodeMcpCall(query: string, envelope: unknown) {
  return encodeTextMcpRequest({
    surface,
    query,
    events: [{
      kind: "mcp_call",
      generated_by: "model_selected_tool",
      tool: "soul.recall",
      arguments: { query },
      response_state: "received",
      envelope
    }]
  });
}

function deepNest(leaf: unknown, depth: number, alternate = false): unknown {
  let value = leaf;
  for (let i = 0; i < depth; i += 1) {
    value = alternate && i % 2 === 1 ? { k: value } : [value];
  }
  return value;
}

function withArrayProto<T>(proto: object, fn: () => T): T {
  const original = Object.getPrototypeOf(Array.prototype);
  Object.setPrototypeOf(Array.prototype, proto);
  try { return fn(); } finally { Object.setPrototypeOf(Array.prototype, original); }
}

function withProtoProp<T>(target: object, key: PropertyKey, descriptor: PropertyDescriptor, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, descriptor);
  try {
    return fn();
  } finally {
    if (original !== undefined) Object.defineProperty(target, key, original);
    else delete (target as Record<PropertyKey, unknown>)[key];
  }
}

function makeReprototypedBlob(): Record<string, unknown> {
  const blob = new Blob(["hi"]) as unknown as Record<PropertyKey, unknown>;
  for (const sym of Object.getOwnPropertySymbols(blob)) delete blob[sym];
  Object.setPrototypeOf(blob, Object.prototype);
  blob.a = 1;
  return blob as Record<string, unknown>;
}

function makeWasmLeaf() {
  const WasmModule = (globalThis as unknown as {
    WebAssembly: { Module: new (bytes: Uint8Array) => object };
  }).WebAssembly.Module;
  const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  return Object.assign(
    Object.setPrototypeOf(new WasmModule(wasmBytes), Object.prototype),
    { hidden: Object.assign(Object.setPrototypeOf(new Intl.Collator(), Object.prototype), { a: 1 }) }
  );
}

it.each([
  ['{"action":"read","tool":"soul.recall","arguments":{"query":"Q"}}', { kind: "read", tool: "soul.recall", arguments: { query: "Q" } }],
  ['{"action":"read","tool":"soul.open_pointer","arguments":{"id":"p"}}', { kind: "read", tool: "soul.open_pointer", arguments: { id: "p" } }],
  ['{"action":"answer","text":"done"}', { kind: "answer", text: "done" }],
  ['{"action":"read","tool":"soul.capture_host_session","arguments":{}}', {
    kind: "host_policy_refusal", tool: "soul.capture_host_session", reason: "tool not on the diagnostic read allowlist"
  }],
  ['{"action":"read","tool":"garden.claim_task","arguments":{}}', {
    kind: "host_policy_refusal", tool: "garden.claim_task", reason: "tool not on the diagnostic read allowlist"
  }],
  ["not-json", { kind: "invalid_action", reason: "unparseable_text" }],
  ['{"action":"read","tool":"soul.recall","arguments":[]}', { kind: "invalid_action", reason: "invalid_read" }]
] as const)("decodes action %s independently", (raw, expected) => {
  expect(decodeTextMcpAction(raw)).toEqual(expected);
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
  for (const query of [
    { query_key: "a".repeat(64), original_query: "Q", gold: "no" },
    { query_key: "a".repeat(64), original_query: "Q", interpretation_proposal: { gold: true } }
  ]) {
    expect(TextMcpConsumerInputSchema.safeParse({
      config: {}, root: "/tmp/text-mcp", query, host_issued_initial_recall: false, model_kind: "scripted", ceilings
    }).success).toBe(false);
  }
  await expect(executeTextMcpConsumer({
    config: {}, root: "/tmp/text-mcp", query: { query_key: "a".repeat(64), original_query: "Q" },
    host_issued_initial_recall: false, model_kind: "remote", ceilings
  })).rejects.toMatchObject({ code: "UNAVAILABLE", message: TEXT_MCP_CONSUMER_REMOTE_BLOCKED_MESSAGE });
  await expect(executeTextMcpConsumer({
    config: {}, root: "/tmp/text-mcp", query: { query_key: "a".repeat(64), original_query: "Q" },
    host_issued_initial_recall: false, model_kind: "scripted", ceilings
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
  const validate = new Ajv2020({ strict: false }).compile(transmitted!);
  for (const valid of [
    { action: "read", tool: "soul.recall", arguments: { query: "Q" } },
    { action: "read", tool: "soul.open_pointer", arguments: { id: "p" } },
    { action: "answer", text: "done" }
  ]) expect(validate(valid)).toBe(true);
  for (const invalid of [
    { action: "read", tool: "soul.recall", arguments: { query: "Q" }, extra: true },
    { action: "answer" },
    { action: "write", tool: "soul.recall", arguments: {} },
    {}
  ]) expect(validate(invalid)).toBe(false);
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
  for (const absent of ["query_coordinates", "interpretation_proposal", "evidence_conditions", "question_time", "definitions above are unmodified"]) {
    expect(plain.systemPrompt).not.toContain(absent);
  }
  expect(plain.systemPrompt).toContain("For conversation passages");
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
    inputSchema: { type: "object", properties: { query: { type: "string" }, query_coordinates: { type: "object" } }, required: ["query"] }
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
  const hostSurface = { ...surface, instructions: "Keep instructions.", tools: [recallTool, interpretationTool, openPointerTool] };

  const callerCoordinates = projectLiveSurfaceForCaller(hostSurface, "caller_coordinates");
  expect(callerCoordinates.tools.map((tool) => (tool as { name: string }).name)).toEqual(["soul.recall", "soul.open_pointer"]);
  expect((callerCoordinates.tools[0] as { inputSchema: { properties: Record<string, unknown> } }).inputSchema.properties)
    .toHaveProperty("query_coordinates");
  expect(callerCoordinates.tools[1]).toEqual(openPointerTool);

  const plainQuery = projectLiveSurfaceForCaller(hostSurface, "plain_query");
  expect(plainQuery.tools.map((tool) => (tool as { name: string }).name)).toEqual(["soul.recall", "soul.open_pointer"]);
  expect((plainQuery.tools[0] as { inputSchema: { properties: Record<string, unknown> } }).inputSchema.properties)
    .not.toHaveProperty("query_coordinates");
  expect(plainQuery.tools[1]).toEqual(openPointerTool);

  const consumerSurface = { ...surface, instructions: "Keep instructions.", tools: [recallTool, openPointerTool] };
  expect(projectLiveSurfaceForCaller(consumerSurface, "caller_coordinates")).toBe(consumerSurface);
  expect(projectLiveSurfaceForCaller(consumerSurface, undefined)).toBe(consumerSurface);

  expect(encodeTextMcpRequest({
    surface: hostSurface, query: "Which project?", events: [], caller_capability_profile: "caller_coordinates"
  }).systemPrompt).toContain("(host-only soul.interpretation omitted)");
  expect(encodeTextMcpRequest({
    surface: consumerSurface, query: "Which project?", events: [], caller_capability_profile: "caller_coordinates"
  }).systemPrompt).toContain("Published server instructions and tool definitions above are unmodified;");
});

it("projects duplicate CallToolResult text envelopes to a single structuredContent copy without mutating the audit envelope", () => {
  const payload = { ok: true, tool_name: "soul.recall", output: { results: [{ id: "r1", text: "Aster" }] } };
  const envelope = { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, _meta: { trace: "t-1" } };
  const snapshot = structuredClone(envelope);
  const projected = projectSingleCopyToolResult(envelope);
  expect(projected).toEqual({ structuredContent: payload, _meta: { trace: "t-1" } });
  expect(projected).not.toHaveProperty("content");
  expect(envelope).toEqual(snapshot);

  const encoded = encodeTextMcpRequest({
    surface, query: "Which project was mentioned?",
    events: [{ kind: "mcp_call", origin: "model_selected", tool: "soul.recall", arguments: { query: "Which project was mentioned?" }, response_state: "received", envelope }]
  });
  expect(encoded.userPrompt).toContain(`mcp_envelope:\n${canonicalJson(projected)}`);
  expect(encoded.userPrompt).not.toContain(canonicalJson(envelope));
  expect(envelope).toEqual(snapshot);
});

it.each([
  ["reordered keys/whitespace", { content: [{ type: "text", text: '{\n  "a": { "c": [1, 2], "d": 4 },\n  "z": 2\n}' }], structuredContent: { z: 2, a: { d: 4, c: [1, 2] } } }, { structuredContent: { z: 2, a: { d: 4, c: [1, 2] } } }],
  ["duplicate error envelope", { isError: true, content: [{ type: "text", text: '{"ok":false,"error":{"code":"VALIDATION","message":"bad input"}}' }], structuredContent: { ok: false, error: { code: "VALIDATION", message: "bad input" } }, _meta: { requestId: "req-1" } }, { isError: true, structuredContent: { ok: false, error: { code: "VALIDATION", message: "bad input" } }, _meta: { requestId: "req-1" } }],
  ["quoted bigInt + scientific", { content: [{ type: "text", text: '{\n  "n": "9007199254740993",\n  "v": 1e+21\n}' }], structuredContent: { v: 1e+21, n: "9007199254740993" } }, { structuredContent: { v: 1e+21, n: "9007199254740993" } }],
  ["distinct sibling keys", { content: [{ type: "text", text: '{\n  "b": { "x": 2 },\n  "a": { "x": 1 }\n}' }], structuredContent: { a: { x: 1 }, b: { x: 2 } } }, { structuredContent: { a: { x: 1 }, b: { x: 2 } } }]
] as const)("collapses canonical duplicate envelope (%s)", (_label, envelope, expected) => {
  expect(projectSingleCopyToolResult(envelope)).toEqual(expected);
});

const errorPayload = { ok: false, error: { code: "VALIDATION", message: "bad input" } };

it.each([
  ["array order mismatch", { content: [{ type: "text", text: '{"a":{"c":[2,1],"d":4},"z":2}' }], structuredContent: { z: 2, a: { d: 4, c: [1, 2] } } }],
  ["primitive type mismatch", { content: [{ type: "text", text: '{"z":"2","a":{"d":4,"c":[1,2]}}' }], structuredContent: { z: 2, a: { d: 4, c: [1, 2] } } }],
  ["distinct diagnostic error text", { isError: true, content: [{ type: "text", text: "Distinct diagnostic text for operator" }], structuredContent: errorPayload }],
  ["distinct json text", { content: [{ type: "text", text: JSON.stringify({ ...errorPayload, extraNote: "keep" }) }], structuredContent: errorPayload }],
  ["multi-block content", { content: [{ type: "text", text: JSON.stringify(errorPayload) }, { type: "text", text: "second block" }], structuredContent: errorPayload }],
  ["non-text block", { content: [{ type: "image", data: "abc", mimeType: "image/png" }], structuredContent: errorPayload }],
  ["annotated text block", { content: [{ type: "text", text: JSON.stringify(errorPayload), annotations: { audience: ["assistant"] } }], structuredContent: errorPayload }],
  ["missing structuredContent", { content: [{ type: "text", text: JSON.stringify(errorPayload) }] }],
  ["Date value", { content: [{ type: "text", text: '{"x":"2026-01-01T00:00:00.000Z"}' }], structuredContent: { x: new Date("2026-01-01T00:00:00.000Z") } }],
  ["NaN value", { content: [{ type: "text", text: '{"n":null}' }], structuredContent: { n: Number.NaN } }],
  ["Infinity value", { content: [{ type: "text", text: '{"n":null}' }], structuredContent: { n: Number.POSITIVE_INFINITY } }],
  ["1e400 overflow", { content: [{ type: "text", text: '{"n":1e400}' }], structuredContent: { n: Number.POSITIVE_INFINITY } }],
  ["rounded int", { content: [{ type: "text", text: '{"n":9007199254740993}' }], structuredContent: { n: 9007199254740992 } }],
  ["1e-400 underflow", { content: [{ type: "text", text: '{"n":1e-400}' }], structuredContent: { n: 0 } }],
  ["top duplicate JSON key", { content: [{ type: "text", text: '{"n":1,"n":2}' }], structuredContent: { n: 2 } }],
  ["nested duplicate JSON key", { content: [{ type: "text", text: '{"a":{"x":1,"x":1}}' }], structuredContent: { a: { x: 1 } } }],
  ["escaped duplicate JSON key", { content: [{ type: "text", text: '{"a":1,"\\u0061":2}' }], structuredContent: { a: 2 } }],
  ["re-prototyped boolean", { content: [{ type: "text", text: '{"v":true}' }], structuredContent: { v: Object.setPrototypeOf(Object(true), Object.prototype) } }],
  ["re-prototyped number", { content: [{ type: "text", text: '{"v":1}' }], structuredContent: { v: Object.setPrototypeOf(Object(1), Object.prototype) } }],
  ["re-prototyped string", { content: [{ type: "text", text: '{"v":"s"}' }], structuredContent: { v: Object.setPrototypeOf(Object("s"), Object.prototype) } }]
] as const)("preserves envelope verbatim (%s)", (_label, envelope) => {
  expect(projectSingleCopyToolResult(envelope)).toBe(envelope);
});

it("never invokes toJSON or getters on structured values, envelopes, or blocks, and preserves non-plain shapes", () => {
  let calls = 0;
  const toJsonObj = { a: 1, toJSON() { calls += 1; return { a: 1 }; } };
  const getterObj: Record<string, unknown> = {};
  Object.defineProperty(getterObj, "a", { enumerable: true, get() { calls += 1; return 1; } });

  const hiddenKeyObj: Record<string, unknown> = { shown: 2 };
  Object.defineProperty(hiddenKeyObj, "hidden", { value: 1, enumerable: false });

  const customProtoArr = [1];
  Object.setPrototypeOf(customProtoArr, { toJSON() { calls += 1; return [2]; } });

  const nonEnumStructured: Record<string, unknown> = { content: [{ type: "text", text: '{"x":1}' }] };
  Object.defineProperty(nonEnumStructured, "structuredContent", { value: { x: 1 }, enumerable: false });

  const getterStructured: Record<string, unknown> = { content: [{ type: "text", text: '{"x":1}' }] };
  Object.defineProperty(getterStructured, "structuredContent", { enumerable: true, get() { calls += 1; return { x: 1 }; } });

  const getterContent: Record<string, unknown> = { structuredContent: { x: 1 } };
  Object.defineProperty(getterContent, "content", { enumerable: true, get() { calls += 1; return [{ type: "text", text: '{"x":1}' }]; } });

  const getterSlotArr: unknown[] = [];
  Object.defineProperty(getterSlotArr, 0, { enumerable: true, get() { calls += 1; return { type: "text", text: '{"x":1}' }; } });

  const getterBlock: Record<string, unknown> = { type: "text" };
  Object.defineProperty(getterBlock, "text", { enumerable: true, get() { calls += 1; return '{"x":1}'; } });

  class CustomArray extends Array<unknown> {}
  const extraNonEnumEnvelope: Record<string, unknown> = { content: [{ type: "text", text: '{"x":1}' }], structuredContent: { x: 1 } };
  Object.defineProperty(extraNonEnumEnvelope, "meta", { value: 1, enumerable: false });
  const extraNonEnumBlock: Record<string, unknown> = { type: "text", text: '{"x":1}' };
  Object.defineProperty(extraNonEnumBlock, "meta", { value: 1, enumerable: false });

  for (const envelope of [
    { content: [{ type: "text", text: '{"a":1}' }], structuredContent: toJsonObj },
    { content: [{ type: "text", text: '{"a":1}' }], structuredContent: getterObj },
    { content: [{ type: "text", text: '{"hidden":1}' }], structuredContent: hiddenKeyObj },
    { content: [{ type: "text", text: "[2]" }], structuredContent: customProtoArr },
    nonEnumStructured,
    getterStructured,
    getterContent,
    { content: getterSlotArr, structuredContent: { x: 1 } },
    { content: [getterBlock], structuredContent: { x: 1 } },
    { content: CustomArray.of({ type: "text", text: '{"x":1}' }), structuredContent: { x: 1 } },
    extraNonEnumEnvelope,
    { content: [extraNonEnumBlock], structuredContent: { x: 1 } }
  ]) {
    expect(projectSingleCopyToolResult(envelope)).toBe(envelope);
  }
  expect(calls).toBe(0);
  expect(encodeMcpCall("Non-enumerable structuredContent", nonEnumStructured).userPrompt)
    .toContain('{"content":[{"text":"{\\"x\\":1}","type":"text"}]}');
});

it("handles deeply nested JSON text and structuredContent envelopes without stack overflow", () => {
  for (const text of ["[".repeat(4096) + "1e-400" + "]".repeat(4096), "[".repeat(4096) + "1" + "]".repeat(4096)]) {
    const envelope = { content: [{ type: "text", text }], structuredContent: { n: 0 } };
    const encoded = encodeTextMcpRequest({
      surface, query: "Deep JSON check",
      events: [{ kind: "host_setup", generated_by: "host_controlled_setup", tool: "soul.recall",
        arguments: { query: "Deep JSON check" }, response_state: "received", envelope }]
    });
    expect(encoded.userPrompt).toContain(canonicalJson(envelope));
  }
  const deepStructured = deepNest(1, 8192);
  const deepStructuredEnvelope = { content: [{ type: "text", text: '{"n":0}' }], structuredContent: deepStructured };
  expect(projectSingleCopyToolResult(deepStructuredEnvelope)).toBe(deepStructuredEnvelope);

  for (const depth of [4096, 8192]) {
    const deepValue = deepNest(1, depth, true);
    const matchingEnvelope = { content: [{ type: "text", text: canonicalJson(deepValue) }], structuredContent: deepValue, isError: false };
    const collapsed = encodeMcpCall("Deep structured single-copy check", matchingEnvelope);
    expect(collapsed.userPrompt).toContain(canonicalJson({ structuredContent: deepValue, isError: false }));
    expect(collapsed.userPrompt).not.toContain('"content"');

    const nonMatchingEnvelope = { content: [{ type: "text", text: '{"other":true}' }], structuredContent: deepValue, isError: false };
    expect(encodeMcpCall("Deep structured mismatch check", nonMatchingEnvelope).userPrompt).toContain(canonicalJson(nonMatchingEnvelope));
  }
});

it("refuses Proxy values (including throwing traps, forged toJSON, revoked Proxies, and mutating _meta) without throwing", () => {
  const divergentEnvelope = {
    content: new Proxy([{ type: "text", text: '{"x":1}' }], {
      get(target, key, receiver) { return key === "0" ? { type: "text", text: "distinct evidence" } : Reflect.get(target, key, receiver); }
    }),
    structuredContent: { x: 1 }
  };
  expect(projectSingleCopyToolResult(divergentEnvelope)).toBe(divergentEnvelope);
  expect(encodeMcpCall("Proxy content trap check", divergentEnvelope).userPrompt).toContain("distinct evidence");

  const throwingEnvelopeProxy = new Proxy(
    { content: [{ type: "text", text: '{"x":1}' }], structuredContent: { x: 1 } },
    { getPrototypeOf() { throw new Error("getPrototypeOf trap must not run"); } }
  );
  const throwingContentEnvelope = {
    content: new Proxy([{ type: "text", text: '{"x":1}' }], {
      getPrototypeOf() { throw new Error("getPrototypeOf trap must not run on content"); }
    }),
    structuredContent: { x: 1 }
  };
  for (const [label, envelope] of [
    ["Throwing getPrototypeOf envelope proxy", throwingEnvelopeProxy],
    ["Throwing getPrototypeOf content proxy", throwingContentEnvelope]
  ] as const) {
    expect(projectSingleCopyToolResult(envelope)).toBe(envelope);
    expect(() => encodeMcpCall(label, envelope)).not.toThrow();
  }

  const forgedEnvelope = {
    content: [{ type: "text", text: '{"x":1}' }],
    structuredContent: new Proxy({ x: 2 }, {
      get(target, key, receiver) { return key === "toJSON" ? () => ({ x: 1 }) : Reflect.get(target, key, receiver); }
    })
  };
  expect(projectSingleCopyToolResult(forgedEnvelope)).toBe(forgedEnvelope);
  expect(encodeMcpCall("Forged toJSON proxy check", forgedEnvelope).userPrompt)
    .toContain('"content":[{"text":"{\\"x\\":1}","type":"text"}]');

  const revokedObj = Proxy.revocable({}, {});
  revokedObj.revoke();
  expect(projectSingleCopyToolResult(revokedObj.proxy)).toBe(revokedObj.proxy);
  const revokedContent = Proxy.revocable([{ type: "text", text: '{"x":1}' }], {});
  revokedContent.revoke();
  const revokedContentEnvelope = { content: revokedContent.proxy, structuredContent: { x: 1 } };
  expect(projectSingleCopyToolResult(revokedContentEnvelope)).toBe(revokedContentEnvelope);

  const structuredPayload = { x: 1 };
  const mutatingMetaEnvelope = {
    _meta: new Proxy({ tag: "m" }, {
      get(target, key, receiver) { structuredPayload.x = 2; return Reflect.get(target, key, receiver); }
    }),
    content: [{ type: "text", text: '{"x":1}' }],
    structuredContent: structuredPayload
  };
  expect(projectSingleCopyToolResult(mutatingMetaEnvelope)).toBe(mutatingMetaEnvelope);
  expect(structuredPayload.x).toBe(1);
  expect(encodeMcpCall("Mutating sibling _meta proxy", mutatingMetaEnvelope).userPrompt).toContain('{\\"x\\":1}');
});

it("blocks prototype pollution, Array.prototype traps, and deep-clones projected values", () => {
  const originalArrayProto = Object.getPrototypeOf(Array.prototype);
  const inheritedProxyEnvelope = { content: [{ type: "text", text: '{"x":[2]}' }], structuredContent: { x: [1] } };
  const inheritedOut = withArrayProto(new Proxy(originalArrayProto ?? Object.prototype, {
    get(target, key, receiver) { return key === "toJSON" ? () => [2] : Reflect.get(target, key, receiver); }
  }), () => ({
    projected: projectSingleCopyToolResult(inheritedProxyEnvelope),
    encoded: encodeMcpCall("Inherited Array.prototype proxy", inheritedProxyEnvelope)
  }));
  expect(inheritedOut.projected).toBe(inheritedProxyEnvelope);
  expect(inheritedOut.encoded.userPrompt).toContain('{\\"x\\":[2]}');

  const mutableStructured = { x: 1, nested: [2] };
  const guardedEnvelope = { content: [{ type: "text", text: "distinct evidence" }], structuredContent: mutableStructured };
  const guardedProjected = withArrayProto(new Proxy(originalArrayProto ?? Object.prototype, {
    set() { mutableStructured.x = 2; throw new Error("inherited set trap must not run"); }
  }), () => projectSingleCopyToolResult(guardedEnvelope));
  expect(guardedProjected).toBe(guardedEnvelope);
  expect(mutableStructured.x).toBe(1);

  let reads = 0;
  const pollutedGetterEnvelope = {
    content: [{ type: "text", text: '{"x":1}' }],
    structuredContent: { get x() { reads += 1; return 1; } }
  };
  const pollutedOut = withProtoProp(Object.prototype, "value", { value: 1, configurable: true, writable: true }, () => ({
    projected: projectSingleCopyToolResult(pollutedGetterEnvelope),
    readsAfterProject: reads,
    encoded: encodeMcpCall("Object.prototype.value pollution check", pollutedGetterEnvelope)
  }));
  expect(pollutedOut.projected).toBe(pollutedGetterEnvelope);
  expect(pollutedOut.readsAfterProject).toBe(0);
  expect(pollutedOut.encoded.userPrompt).toContain('"content":[{"text":"{\\"x\\":1}","type":"text"}]');

  const sourceEnvelope = {
    content: [{ type: "text", text: '{"items":[{"k":1}],"meta":{"flag":true}}' }],
    structuredContent: { items: [{ k: 1 }], meta: { flag: true } },
    _meta: { trace: [1, 2] }
  };
  const projected = projectSingleCopyToolResult(sourceEnvelope) as typeof sourceEnvelope;
  expect(projected).toEqual({ structuredContent: { items: [{ k: 1 }], meta: { flag: true } }, _meta: { trace: [1, 2] } });
  sourceEnvelope.structuredContent.items[0]!.k = 999;
  sourceEnvelope.structuredContent.meta.flag = false;
  sourceEnvelope._meta.trace[0] = 999;
  expect(projected.structuredContent.items[0]!.k).toBe(1);
  expect(projected.structuredContent.meta.flag).toBe(true);
  expect(projected._meta.trace[0]).toBe(1);

  const setProtoProjected = withProtoProp(Object.prototype, "set", { value: undefined, configurable: true, writable: true }, () =>
    projectSingleCopyToolResult({ content: [{ type: "text", text: '{"x":1}' }], structuredContent: { x: 1 } })
  );
  expect(setProtoProjected).toEqual({ structuredContent: { x: 1 } });

  const topLevelStringEnvelope = { content: [{ type: "text", text: '"distinct evidence"' }], structuredContent: {} };
  const neg1Out = withProtoProp(Array.prototype, "-1", { value: { kind: "obj", expectingKey: true }, configurable: true, writable: true }, () =>
    projectSingleCopyToolResult(topLevelStringEnvelope)
  ) as typeof topLevelStringEnvelope;
  expect(neg1Out).toBe(topLevelStringEnvelope);
  expect(neg1Out.content[0]!.text).toBe('"distinct evidence"');
});

it("ignores Array.prototype[Symbol.iterator] mutations and rejects re-prototyped exotic internal-slot objects", () => {
  let iteratorGets = 0;
  const mutableStructured = { x: [1] };
  const originalIterDesc = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const iterProjected = withProtoProp(Array.prototype, Symbol.iterator, {
    configurable: true,
    get() { iteratorGets += 1; mutableStructured.x = [2]; return originalIterDesc?.value; }
  }, () => projectSingleCopyToolResult({ content: [{ type: "text", text: '{"x":[1]}' }], structuredContent: mutableStructured }));
  expect(iterProjected).toEqual({ structuredContent: { x: [1] } });
  expect(iteratorGets).toBe(0);
  expect(mutableStructured.x).toEqual([1]);

  for (const exotic of [
    Object.setPrototypeOf(new Date(12345), Object.prototype),
    Object.setPrototypeOf(new Map(), Object.prototype),
    Object.setPrototypeOf(/re/, Object.prototype),
    Object.setPrototypeOf(new WeakRef({}), Object.prototype),
    Object.setPrototypeOf(new Intl.Collator(), Object.prototype)
  ]) {
    const env = { content: [{ type: "text", text: "{}" }], structuredContent: exotic };
    expect(projectSingleCopyToolResult(env)).toBe(env);
  }

  const exoticEnvelope = Object.setPrototypeOf(new Date(12345), Object.prototype) as unknown as Record<string, unknown>;
  exoticEnvelope.content = [{ type: "text", text: "{}" }];
  exoticEnvelope.structuredContent = {};
  expect(projectSingleCopyToolResult(exoticEnvelope)).toBe(exoticEnvelope);

  const deepCollatorLeaf = Object.assign(Object.setPrototypeOf(new Intl.Collator(), Object.prototype), { a: 1 });
  const deepIterLeaf = Object.assign(Object.setPrototypeOf([][Symbol.iterator](), Object.prototype), { a: 1 });
  for (const leaf of [deepCollatorLeaf, deepIterLeaf, makeReprototypedBlob()]) {
    const env = { content: [{ type: "text", text: "[".repeat(8192) + '{"a":1}' + "]".repeat(8192) }], structuredContent: deepNest(leaf, 8192) };
    expect(projectSingleCopyToolResult(env)).toBe(env);
  }

  let leftBranch: unknown = 1;
  for (let d = 0; d < 5000; d += 1) leftBranch = { next: leftBranch };
  let rightInner: unknown = 1;
  for (let d = 0; d < 3000; d += 1) rightInner = { next: rightInner };
  let rightBranch: unknown = Object.assign(Object.setPrototypeOf([][Symbol.iterator](), Object.prototype), { next: rightInner });
  for (let d = 0; d < 2000; d += 1) rightBranch = { next: rightBranch };
  const twoBranchExoticEnvelope = {
    content: [{ type: "text", text: canonicalJson({ left: leftBranch, right: rightBranch }) }],
    structuredContent: { left: leftBranch, right: rightBranch }
  };
  expect(projectSingleCopyToolResult(twoBranchExoticEnvelope)).toBe(twoBranchExoticEnvelope);

  const shallowWasmEnvelope = { content: [{ type: "text", text: '{"nested":{"hidden":{"a":1}}}' }], structuredContent: { nested: makeWasmLeaf() } };
  expect(projectSingleCopyToolResult(shallowWasmEnvelope)).toBe(shallowWasmEnvelope);

  let deepLeft: unknown = 1;
  for (let d = 0; d < 8192; d += 1) deepLeft = { next: deepLeft };
  let deepRight: unknown = makeWasmLeaf();
  for (let d = 0; d < 4000; d += 1) deepRight = { next: deepRight };
  const deepWasmEnvelope = {
    content: [{ type: "text", text: canonicalJson({ left: deepLeft, right: deepRight }) }],
    structuredContent: { left: deepLeft, right: deepRight }
  };
  expect(projectSingleCopyToolResult(deepWasmEnvelope)).toBe(deepWasmEnvelope);

  const shallowBlobEnvelope = { content: [{ type: "text", text: '{"x":{"a":1}}' }], structuredContent: { x: makeReprototypedBlob() } };
  expect(projectSingleCopyToolResult(shallowBlobEnvelope)).toBe(shallowBlobEnvelope);
});

it("rejects non-plain metadata and symbol properties without invoking getters or Object.prototype hooks", () => {
  let errGetterCalls = 0;
  const err = new Error("x");
  const errEnvelope: Record<string, unknown> = { content: [{ type: "text", text: '{"ok":1}' }], structuredContent: { ok: 1 }, _meta: err };
  for (const [prop, value] of [["message", "mutated"], ["name", "MutatedError"]] as const) {
    Object.defineProperty(err, prop, {
      configurable: true,
      get() { errGetterCalls += 1; errEnvelope.structuredContent = { mutated: true }; return value; }
    });
  }
  expect(projectSingleCopyToolResult(errEnvelope)).toBe(errEnvelope);
  expect(errGetterCalls).toBe(0);
  expect(errEnvelope.structuredContent).toEqual({ ok: 1 });

  const symEnvelope = { content: [{ type: "text", text: '{"ok":1}' }], structuredContent: { ok: 1 }, [Symbol("s")]: 1 };
  const nestedSymEnvelope = { content: [{ type: "text", text: '{"ok":1}' }], structuredContent: { ok: 1, [Symbol("s")]: 1 } };
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
        get() { protoGetterCalls += 1; throw new Error(`Object.prototype.${key} must not run`); }
      } as unknown as PropertyDescriptor);
    }
    projectedValid = projectSingleCopyToolResult({ content: [{ type: "text", text: '{"ok":1}' }], structuredContent: { ok: 1 } });
  } finally {
    for (const key of protoKeys) delete (Object.prototype as Record<string, unknown>)[key];
    for (const key of protoKeys) {
      const orig = savedDescriptors.get(key);
      if (orig !== undefined) Object.defineProperty(Object.prototype, key, { __proto__: null, ...orig } as unknown as PropertyDescriptor);
    }
  }
  expect(projectedValid).toEqual({ structuredContent: { ok: 1 } });
  expect(protoGetterCalls).toBe(0);
});

it("handles 24-level diamond DAG metadata in O(V+E) without exponential expansion", () => {
  let dag: Record<string, unknown> = { x: 1 };
  for (let i = 0; i < 24; i += 1) dag = { a: dag, b: dag };
  const distinctEnvelope = { content: [{ type: "text", text: '{"ok":2}' }], structuredContent: { ok: 1 }, _meta: dag };
  const matchingEnvelope = { content: [{ type: "text", text: '{"ok":1}' }], structuredContent: { ok: 1 }, _meta: dag };

  const t0 = performance.now();
  const distinctOut = projectSingleCopyToolResult(distinctEnvelope);
  const distinctMs = performance.now() - t0;
  expect(Object.is(distinctOut, distinctEnvelope)).toBe(true);
  expect(distinctMs).toBeLessThan(50);

  const t1 = performance.now();
  const matchedOut = projectSingleCopyToolResult(matchingEnvelope) as {
    structuredContent: { ok: number };
    _meta: { a: unknown; b: unknown };
  };
  const matchedMs = performance.now() - t1;
  expect(Object.is(matchedOut, matchingEnvelope)).toBe(false);
  expect(Object.hasOwn(matchedOut, "content")).toBe(false);
  expect(matchedOut.structuredContent).toEqual({ ok: 1 });
  expect(Object.is(matchedOut._meta, dag)).toBe(false);
  expect(Object.is(matchedOut._meta.a, matchedOut._meta.b)).toBe(true);
  expect(matchedMs).toBeLessThan(50);
});
