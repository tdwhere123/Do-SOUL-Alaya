import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary({ ownedTemporaryFixtures: true });
});
process.env.NODE_ENV = "test";
process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL = "true";

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { fetchLoopbackProvider } from "../../support/loopback-provider-fetch.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { TEXT_MCP_ACTION_SCHEMA_NAME } from "../../../runs/recall-measurement/text-mcp-consumer/codec.js";
import { consumeTextMcpProviderSession } from "../../../runs/recall-measurement/text-mcp-consumer/session-execute.js";
import {
  PAIRED_MCP_SLICE_ARMS, PAIRED_MCP_SLICE_REQUEST_PROFILE, pairedMcpSliceArmProfile,
  pairedMcpSliceManifest, pairedMcpSliceQuestionIds, pairedMcpSliceStratumCounts, pairedMcpSliceSessionGrantFields,
  aggregatePairedMcpSliceSessions, buildPairedMcpSliceConsumerInput, quotePairedMcpSliceBudget,
  verifyPairedMcpSliceDataset, type PairedMcpSliceArm
} from "../../../runs/recall-measurement/text-mcp-consumer/paired-mcp-slice.js";
import { estimatedSemanticProviderUpperUsd } from "../../../runs/provider-request/request-binding.js";
import { STEP_OPENAPI_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { mapOrdinaryRecallScope } from "../../../runs/recall-measurement/ordinary/ordinary-entry-contract.js";
import { ordinaryIndexedSnapshot, simulateIndexedQueryPreparation } from "./ordinary-indexed-snapshot.test-support.js";
import { issueTextMcpProviderSession, sessionProviderConfig } from "../../support/text-mcp-provider-session-fixture.js";
import { withHistoricalGraph } from "./paired-mcp-graph.test-support.js";
import { attemptInputByteUpperBound } from "../../../runs/extraction/authority/receipt-limits.js";

const NAMES = [
  "Aster", "Birch", "Cedar", "Dock", "Elm", "Fir", "Gum", "Hickory",
  "Ivy", "Juniper", "Kapok", "Larch", "Maple", "Oak", "Pine", "Quince"
] as const;
const QUESTION_DATE = "2023/09/13 (Wed) 00:00";
const DATASET = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../data/longmemeval/longmemeval_s.json");
const NEIGHBOR_BODY = "The archive's third vault locks at midnight.";

let base: Awaited<ReturnType<typeof ordinaryIndexedSnapshot>>;
let preparation: ReturnType<typeof simulateIndexedQueryPreparation>;
let origin = "";
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const answer = nextModelAction(body);
  const packet = {
    choices: [{ delta: { content: answer }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
  };
  res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  res.end(`data: ${JSON.stringify(packet)}\n\ndata: [DONE]\n\n`);
});

beforeAll(async () => {
  preparation = simulateIndexedQueryPreparation();
  const sources = NAMES.map(name =>
    `Project ${name} was mentioned. ${`${name} context continues here. `.repeat(80)}${name} closing line.`);
  base = await ordinaryIndexedSnapshot(sources);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
}, 180000);

afterAll(() => {
  preparation?.mockRestore();
  server.closeAllConnections();
  server.close();
  if (base !== undefined) rmSync(base.root, { recursive: true, force: true });
  isolation.restore();
  expect(isolation.violations).toEqual([]);
});

afterEach(() => {
  if (vi.isMockFunction(performance.now)) vi.mocked(performance.now).mockRestore();
});

it("freezes the 30-item paired slice and quotes a finite OpenAPI grant inside its ceiling", () => {
  const manifest = pairedMcpSliceManifest();
  const counts = pairedMcpSliceStratumCounts();
  expect(manifest).toHaveLength(30);
  expect(pairedMcpSliceQuestionIds()).toHaveLength(30);
  expect(new Set(pairedMcpSliceQuestionIds()).size).toBe(30);
  expect(counts).toEqual({
    qc_incomplete: 8, qc_blocked: 5, qc_invalid: 1, formed_outside_pool_preference: 1,
    multi_session: 5, temporal_reasoning: 5, cut_single_session_assistant: 5
  });
  expect(PAIRED_MCP_SLICE_ARMS).toHaveLength(3);
  expect(pairedMcpSliceArmProfile("plain_query")).toBe("plain_query");
  expect(pairedMcpSliceArmProfile("agent_q_no_graph")).toBe("caller_coordinates");
  expect(pairedMcpSliceArmProfile("agent_q_conditional_field")).toBe("caller_coordinates");
  const budget = quotePairedMcpSliceBudget();
  expect(budget.paid_execution).toBe(false);
  expect(budget.request_profile).toBe(PAIRED_MCP_SLICE_REQUEST_PROFILE);
  expect(budget.quote_basis.contract).toBe(STEP_OPENAPI_QUOTE_BASIS.contract);
  expect(budget.quote_basis.selected_provider_url).toBe(STEP_OPENAPI_QUOTE_BASIS.selected_provider_url);
  expect(Number.isFinite(budget.estimated_upper.per_session_usd)).toBe(true);
  expect(budget.estimated_upper.per_session_usd).toBeGreaterThan(0);
  expect(budget.estimated_upper.cohort_90_usd).toBe(budget.estimated_upper.per_session_usd * 90);
  expect(budget.estimated_upper.per_session_usd).toBeLessThanOrEqual(budget.limits.spend_ceiling_usd);
  expect(estimatedSemanticProviderUpperUsd(budget.limits, budget.quote_basis.input_usd_equivalent_per_million,
    budget.quote_basis.output_usd_equivalent_per_million)).toBe(budget.estimated_upper.per_session_usd);
  expect(Number.isFinite(budget.expected.typical.cohort_90_cny)).toBe(true);
  if (existsSync(DATASET)) {
    const checked = verifyPairedMcpSliceDataset(JSON.parse(readFileSync(DATASET, "utf8")) as { question_id: string }[]);
    expect(checked.missing).toEqual([]);
    expect(checked.question_ids).toHaveLength(30);
  }
});

it("pairs only unique observations from the frozen slice and preserves ungraded arms", () => {
  const row = { question_id: pairedMcpSliceQuestionIds()[0]!, arm: "plain_query" as const,
    correct: true, terminal: "answered", coordinate_admitted: false, payload_continuation_count: 0,
    open_pointer_count: 0, input_tokens: 1, output_tokens: 1, wall_ms: 1 };
  const aggregate = aggregatePairedMcpSliceSessions([row,
    { ...row, arm: "agent_q_no_graph", correct: false },
    { ...row, arm: "agent_q_conditional_field", correct: null, terminal: "unknown" }
  ]);
  expect(aggregate.signs.plain_query_vs_agent_q_no_graph).toEqual({ wins: 1, losses: 0, ties: 0, compared: 1 });
  expect(aggregate.signs.plain_query_vs_agent_q_conditional_field.compared).toBe(0);
  expect(aggregate.by_arm.agent_q_conditional_field.terminals).toEqual({ unknown: 1 });
  expect(() => aggregatePairedMcpSliceSessions([row, row])).toThrow(/one observation/);
  expect(() => aggregatePairedMcpSliceSessions([{ ...row, question_id: "outside-slice" }])).toThrow(/frozen item/);
});

it("isolates three MCP arms over loopback HTTP and live SQLite MCP", async () => {
  const mapped = mapOrdinaryRecallScope(base.config.authorized_scopes);
  if (mapped.status !== "mapped") throw new Error(mapped.reason);
  const query = base.queries[0]!.original_query;
  const coordinates = {
    question_time: { intervals: [{ start: "2023-09-01", end: "2023-09-13" }] },
    evidence_conditions: [{ statement: query, speaker: "user" as const, anchors: ["project"] }]
  };
  const recall = { query, scope_class: mapped.scope_class, dimension: null, domain_tags: null, max_results: 5 };
  const agentRecall = { ...recall, query_coordinates: coordinates };
  const graph = await withHistoricalGraph(base.config, base.root, "Project Aster was mentioned.", NEIGHBOR_BODY);
  const plain = await runArm("plain_query", graph.control, body => nextAgentAction(body, recall));
  const control = await runArm("agent_q_no_graph", graph.control, body => nextAgentAction(body, agentRecall));
  const treated = await runArm("agent_q_conditional_field", graph.graph,
    body => nextAgentAction(body, agentRecall, graph.neighborRoot));

  expect(plain.result.turns[0]?.key).not.toBe(control.result.turns[0]?.key);
  expect(plain.result.turns[0]?.request_digest).not.toBe(control.result.turns[0]?.request_digest);
  expect(treated.result.turns[0]?.request_digest).toBe(control.result.turns[0]?.request_digest);
  expect(requestSystem(plain.wire[0]!)).not.toContain("query_coordinates");
  expect(requestSystem(control.wire[0]!)).toContain("query_coordinates");
  for (const arm of [plain, control, treated]) assertDatedRecall(arm, query);
  expect(control.recall.arguments).toMatchObject({ query_coordinates: coordinates });
  expect(treated.recall.arguments).toEqual(control.recall.arguments);
  expect(plain.recall.arguments).not.toHaveProperty("query_coordinates");

  expect(treated.first.results).toEqual(control.first.results);
  const ranked = asArray(treated.first.results).map(asRecord);
  expect(ranked.length).toBeGreaterThan(0);
  expect(ranked.every(row => typeof row?.content_preview === "string" && row.content_preview.length > 0)).toBe(true);
  expect(asRecord(asRecord(treated.first.index)?.completeness)?.interpretation_coverage).toBe("open");
  expect(memberFor(control.first, graph.neighborRoot)).toBeUndefined();
  const neighbor = memberFor(treated.first, graph.neighborRoot);
  expect(neighbor).toMatchObject({ root_id: graph.neighborRoot, in_pool: false, source_target: expect.any(Object) });
  const opened = treated.calls.find(event => event.tool === "soul.open_pointer");
  expect(opened?.arguments).toEqual({ source_target: neighbor?.source_target });
  expect(mcpOutput(opened?.envelope)).toMatchObject({
    object_kind: "source_evidence", content: { content: expect.stringContaining(NEIGHBOR_BODY) }
  });
  expect(treated.wire).toHaveLength(4);
}, 240000);

async function runArm(
  arm: PairedMcpSliceArm,
  config: typeof base.config,
  action: (body: string) => string
) {
  currentAction = action;
  currentWire = [];
  const home = join(base.root, arm);
  mkdirSync(home, { recursive: true });
  const query = { query_key: base.queries[0]!.query_key, original_query: base.queries[0]!.original_query };
  const scenario = { arm, question_date: QUESTION_DATE, interpretation_clock: config.interpretation_clock };
  const grant = pairedMcpSliceSessionGrantFields(scenario);
  const fixture = issueTextMcpProviderSession({
    home, config, query, limits: grant.limits,
    prompt: { caller_capability_profile: grant.caller_capability_profile, question_date: grant.question_date,
      recall_dispatch_defaults: grant.recall_dispatch_defaults }
  });
  const consumer = buildPairedMcpSliceConsumerInput({ ...scenario, config, query, root: fixture.consumerRoot });
  const selected = { ...sessionProviderConfig(), apiKey: "loopback-only" };
  const result = await consumeTextMcpProviderSession({ grantPin: fixture.pin, mode: "execute", consumer }, {
    loadConfig: (): CompileSeedExtractionConfig => selected,
    createExtractor: config => createSemanticProviderHttpExtractor(config, TEXT_MCP_ACTION_SCHEMA_NAME, fetchImpl)
  });
  expect(result.failure).toBeNull();
  const calls = result.events.filter(event => event.kind === "mcp_call");
  const recall = calls.find(isRecall), first = mcpOutput(recall?.envelope);
  if (recall === undefined || first === undefined) throw new Error(`${arm} did not deliver its first recall`);
  expect(currentWire.every(body => attemptInputByteUpperBound(body) <= grant.limits.maximum_input_tokens_per_attempt)).toBe(true);
  return { result, calls, recall, first, wire: currentWire };
}

function assertDatedRecall(arm: Awaited<ReturnType<typeof runArm>>, query: string) {
  expect(arm.wire).toHaveLength(arm.result.turns.length);
  expect(arm.wire.length).toBeGreaterThanOrEqual(3);
  expect(arm.wire.every(body => requestUser(body).startsWith(`Current date: ${QUESTION_DATE}\nCALLER_QUERY:`))).toBe(true);
  expect(arm.recall.arguments).toMatchObject({ query, result_kind_view: "source_only", source_observed_at: base.config.interpretation_clock });
  expect(arm.recall.raw_arguments).toMatchObject({ query });
  expect(arm.recall.raw_arguments).not.toHaveProperty("result_kind_view");
  expect(arm.recall.raw_arguments).not.toHaveProperty("source_observed_at");
  const cut = cutTarget(arm.first);
  expect(cut?.span.content_complete).toBe(false);
  const continued = arm.calls.find(hasPayloadContinuation);
  expect(continued?.arguments).toMatchObject({
    payload_continuation: { purpose: "payload_expansion", start_offset: cut?.span.content_end }
  });
  expect(spanOf(mcpOutput(continued?.envelope))?.content_complete).toBe(true);
}

let currentAction: (body: string) => string = () => JSON.stringify({ action: "answer", text: "default" });
let currentWire: string[] = [];
function nextModelAction(body: string): string {
  currentWire.push(body);
  return currentAction(body);
}

const nativeFetch = globalThis.fetch;
const fetchImpl: typeof fetch = (url, init) => {
  const selected = new URL(String(url));
  expect(selected.href).toBe(`${STEP_OPENAPI_QUOTE_BASIS.selected_provider_url}/chat/completions`);
  return fetchLoopbackProvider(nativeFetch, new URL(selected.pathname, origin), init);
};

function nextAgentAction(
  body: string, recallBase: Record<string, unknown>, neighborRoot?: string
): string {
  const user = requestUser(body);
  const envelopes = envelopesFrom(user);
  if (envelopes.length === 0) {
    return JSON.stringify({
      action: "read", tool: "soul.recall", arguments: recallBase
    });
  }
  const first = mcpOutput(envelopes[0]);
  const cut = cutTarget(first);
  if (cut !== undefined && !user.includes("payload_expansion")) {
    const index = asRecord(first?.index);
    return JSON.stringify({
      action: "read", tool: "soul.recall",
      arguments: {
        ...recallBase,
        ...(index?.continuation === undefined ? {} : { continuation: index.continuation }),
        payload_continuation: {
          schema_version: 1, purpose: "payload_expansion", target: cut.target, start_offset: cut.span.content_end
        }
      }
    });
  }
  const member = neighborRoot === undefined ? undefined : memberFor(first, neighborRoot);
  if (member?.source_target !== undefined && !user.includes("tool=soul.open_pointer")) {
    return JSON.stringify({
      action: "read", tool: "soul.open_pointer", arguments: { source_target: member.source_target }
    });
  }
  return JSON.stringify({ action: "answer", text: "Aster" });
}

function requestUser(body: string): string {
  return requestMessage(body, "user");
}

function requestSystem(body: string): string { return requestMessage(body, "system"); }
function requestMessage(body: string, role: string): string {
  const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] };
  return parsed.messages?.find(message => message.role === role)?.content ?? "";
}
function envelopesFrom(userPrompt: string): unknown[] {
  const envelopes: unknown[] = [];
  const marker = "mcp_envelope:";
  let from = 0;
  while (from < userPrompt.length) {
    const at = userPrompt.indexOf(marker, from);
    if (at < 0) break;
    const lineStart = userPrompt.indexOf("{", at);
    if (lineStart < 0) break;
    const lineEnd = userPrompt.indexOf("\n", lineStart);
    const raw = userPrompt.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
    try { envelopes.push(JSON.parse(raw)); } catch { break; }
    from = lineStart + raw.length;
  }
  return envelopes;
}

function mcpOutput(envelope: unknown): Record<string, unknown> | undefined {
  const structured = asRecord(asRecord(envelope)?.structuredContent);
  if (structured?.ok === true && isPlainObject(structured.output)) return structured.output;
  return undefined;
}

function cutTarget(output: Record<string, unknown> | undefined) {
  const entries = asArray(asRecord(output?.index)?.entries);
  for (const entry of entries) {
    const target = asRecord(asRecord(entry)?.target);
    const span = asRecord(target?.span);
    if (target?.kind === "source_evidence" && span?.content_complete === false &&
      typeof span.content_end === "number") {
      return { target, span: span as { content_end: number; content_complete: boolean } };
    }
  }
  return undefined;
}

function spanOf(output: Record<string, unknown> | undefined) {
  const cut = cutTarget(output);
  if (cut !== undefined) return cut.span;
  const entries = asArray(asRecord(output?.index)?.entries);
  for (const entry of entries) {
    const span = asRecord(asRecord(asRecord(entry)?.target)?.span);
    if (typeof span?.content_complete === "boolean") return span as { content_complete: boolean };
  }
  return undefined;
}

function memberFor(output: Record<string, unknown> | undefined, root: string) {
  const lines = asArray(output?.member_index).map(asRecord).filter((line): line is Record<string, unknown> => line !== undefined);
  return lines.find(line => line.root_id === root);
}

function isRecall(event: Record<string, unknown>): boolean {
  return event.tool === "soul.recall" && !hasPayloadContinuation(event);
}

function hasPayloadContinuation(event: Record<string, unknown>): boolean {
  return isPlainObject(event.arguments) && event.arguments.payload_continuation !== undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
