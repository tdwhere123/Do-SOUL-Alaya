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
import { TEXT_MCP_ACTION_SCHEMA_NAME, encodeTextMcpRequest } from "../../../runs/recall-measurement/text-mcp-consumer/codec.js";
import { consumeTextMcpProviderSession } from "../../../runs/recall-measurement/text-mcp-consumer/session-execute.js";
import {
  PAIRED_MCP_SLICE_ARMS, PAIRED_MCP_SLICE_REQUEST_PROFILE, pairedMcpSliceArmProfile,
  pairedMcpSliceManifest, pairedMcpSliceQuestionIds, pairedMcpSliceStratumCounts,
  quotePairedMcpSliceBudget, verifyPairedMcpSliceDataset
} from "../../../runs/recall-measurement/text-mcp-consumer/paired-mcp-slice.js";
import { estimatedSemanticProviderUpperUsd } from "../../../runs/provider-request/request-binding.js";
import { STEP_OPENAPI_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { mapOrdinaryRecallScope } from "../../../runs/recall-measurement/ordinary/ordinary-entry-contract.js";
import { ordinaryIndexedSnapshot, simulateIndexedQueryPreparation } from "./ordinary-indexed-snapshot.test-support.js";
import { issueTextMcpProviderSession, sessionProviderConfig } from "../../support/text-mcp-provider-session-fixture.js";

const NAMES = [
  "Aster", "Birch", "Cedar", "Dock", "Elm", "Fir", "Gum", "Hickory",
  "Ivy", "Juniper", "Kapok", "Larch", "Maple", "Oak", "Pine", "Quince"
] as const;
const QUESTION_DATE = "2023/09/13 (Wed) 00:00";
const DATASET = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../data/longmemeval/longmemeval_s.json");

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
  base = await ordinaryIndexedSnapshot(NAMES.map(name =>
    `Project ${name} was mentioned. ${`${name} context continues here. `.repeat(80)}${name} closing line.`));
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

it("isolates three MCP arms over loopback HTTP and live SQLite MCP", async () => {
  const mapped = mapOrdinaryRecallScope(base.config.authorized_scopes);
  if (mapped.status !== "mapped") throw new Error(mapped.reason);
  const query = { query_key: base.queries[0]!.query_key, original_query: base.queries[0]!.original_query };
  const defaults = {
    result_kind_view: "source_only" as const, source_observed_at: base.config.interpretation_clock
  };
  const coordinates = {
    question_time: { intervals: [{ start: "2023-09-01", end: "2023-09-13" }] },
    evidence_conditions: [{ statement: query.original_query, speaker: "user" as const, anchors: ["project"] }]
  };
  const recallBase = {
    query: query.original_query, scope_class: mapped.scope_class, dimension: null, domain_tags: null, max_results: 5
  };

  const agent = await runArm("agent-q", {
    caller_capability_profile: "caller_coordinates" as const, question_date: QUESTION_DATE,
    recall_dispatch_defaults: defaults
  }, body => nextAgentAction(body, recallBase, coordinates));
  expect(agent.failure).toBeNull();
  expect(agent.turns[0]?.key).toMatch(/^[a-f0-9]{64}$/u);
  const surface = agent.live_surface!;
  const dated = encodeTextMcpRequest({
    surface, query: query.original_query, events: [], caller_capability_profile: "caller_coordinates",
    question_date: QUESTION_DATE
  });
  const noGraph = encodeTextMcpRequest({
    surface, query: query.original_query, events: [], caller_capability_profile: "caller_coordinates",
    question_date: QUESTION_DATE
  });
  const conditional = encodeTextMcpRequest({
    surface, query: query.original_query, events: [], caller_capability_profile: "caller_coordinates",
    question_date: QUESTION_DATE
  });
  const plainPrompt = encodeTextMcpRequest({
    surface, query: query.original_query, events: [], caller_capability_profile: "plain_query",
    question_date: QUESTION_DATE
  });
  expect(noGraph.systemPrompt).toBe(conditional.systemPrompt);
  expect(noGraph.userPrompt).toBe(conditional.userPrompt);
  expect(noGraph.systemPrompt).toContain("query_coordinates");
  expect(plainPrompt.systemPrompt).not.toContain("query_coordinates");
  expect(plainPrompt.systemPrompt).not.toBe(noGraph.systemPrompt);
  expect(dated.userPrompt.startsWith(`Current date: ${QUESTION_DATE}\nCALLER_QUERY:`)).toBe(true);

  const recall = agent.events.find(event => event.kind === "mcp_call" && isRecall(event));
  if (recall === undefined) throw new Error("agent arm did not dispatch soul.recall");
  expect(recall).toBeDefined();
  const args = recall.arguments as Record<string, unknown>;
  expect(args.query_coordinates).toEqual(coordinates);
  expect(JSON.stringify(args)).not.toMatch(/original_query_digest|sha256/iu);
  expect(args.result_kind_view).toBe("source_only");
  expect(args.source_observed_at).toBe(base.config.interpretation_clock);
  expect(recall.raw_arguments).toMatchObject({ query: query.original_query });
  expect((recall.raw_arguments as Record<string, unknown>).result_kind_view).toBeUndefined();

  const continued = agent.events.filter(event => event.kind === "mcp_call" && hasPayloadContinuation(event));
  expect(continued.length).toBeGreaterThan(0);
  const opened = agent.events.filter(event => event.kind === "mcp_call" && event.tool === "soul.open_pointer");
  expect(opened.length).toBeGreaterThan(0);
  expect(opened[0]).toMatchObject({ arguments: { source_target: expect.any(Object) } });
  const firstOut = mcpOutput(recall.envelope);
  expect(cutTarget(firstOut)?.span?.content_complete).toBe(false);
  const continuedOut = mcpOutput(continued[0]!.envelope);
  const continuedSpan = cutTarget(continuedOut)?.span ?? spanOf(continuedOut);
  expect(continuedSpan?.content_complete).toBe(true);

  const plain = await runArm("plain-query", {
    caller_capability_profile: "plain_query" as const, question_date: QUESTION_DATE,
    recall_dispatch_defaults: defaults
  }, () => JSON.stringify({
    action: "read", tool: "soul.recall", arguments: { ...recallBase, query_coordinates: coordinates }
  }));
  expect(plain.turns[0]?.key).not.toBe(agent.turns[0]?.key);
  expect(plain.turns[0]?.request_digest).not.toBe(agent.turns[0]?.request_digest);
  expect(plain.events.some(event => event.kind === "host_policy_refusal")).toBe(true);
  expect(plain.events.filter(event => event.kind === "mcp_call")).toEqual([]);
}, 240000);

function runArm(
  name: string,
  extra: Record<string, unknown>,
  action: (body: string) => string
) {
  currentAction = action;
  const home = join(base.root, name);
  mkdirSync(home, { recursive: true });
  const fixture = issueTextMcpProviderSession({
    home, config: base.config,
    query: { query_key: base.queries[0]!.query_key, original_query: base.queries[0]!.original_query },
    maxModelTurns: 4, maxToolCalls: 3, wallMs: 120_000, spendCeilingUsd: 2
  });
  const consumer = {
    config: base.config, root: fixture.consumerRoot,
    query: { query_key: base.queries[0]!.query_key, original_query: base.queries[0]!.original_query },
    host_issued_initial_recall: false,
    ceilings: {
      max_model_turns: 4, max_tool_calls: 3, max_input_bytes: 1_500_000, max_output_bytes: 64_000, wall_ms: 120_000
    },
    ...extra
  };
  const selected = { ...sessionProviderConfig(), apiKey: "loopback-only" };
  return consumeTextMcpProviderSession({ grantPin: fixture.pin, mode: "execute", consumer }, {
    loadConfig: (): CompileSeedExtractionConfig => selected,
    createExtractor: config => createSemanticProviderHttpExtractor(config, TEXT_MCP_ACTION_SCHEMA_NAME, fetchImpl)
  });
}

let currentAction: (body: string) => string = () => JSON.stringify({ action: "answer", text: "default" });
function nextModelAction(body: string): string {
  return currentAction(body);
}

const nativeFetch = globalThis.fetch;
const fetchImpl: typeof fetch = (url, init) => {
  const selected = new URL(String(url));
  expect(selected.href).toBe(`${STEP_OPENAPI_QUOTE_BASIS.selected_provider_url}/chat/completions`);
  return fetchLoopbackProvider(nativeFetch, new URL(selected.pathname, origin), init);
};

function nextAgentAction(
  body: string, recallBase: Record<string, unknown>, coordinates: Record<string, unknown>
): string {
  const user = requestUser(body);
  const envelopes = envelopesFrom(user);
  if (envelopes.length === 0) {
    return JSON.stringify({
      action: "read", tool: "soul.recall", arguments: { ...recallBase, query_coordinates: coordinates }
    });
  }
  const first = mcpOutput(envelopes[0]);
  const cut = cutTarget(first);
  if (cut !== undefined && !user.includes("payload_expansion")) {
    const index = asRecord(first?.index);
    return JSON.stringify({
      action: "read", tool: "soul.recall",
      arguments: {
        ...recallBase, query_coordinates: coordinates,
        ...(index?.continuation === undefined ? {} : { continuation: index.continuation }),
        payload_continuation: {
          schema_version: 1, purpose: "payload_expansion", target: cut.target, start_offset: cut.span.content_end
        }
      }
    });
  }
  const member = firstMember(first);
  if (member?.source_target !== undefined && !user.includes("tool=soul.open_pointer")) {
    return JSON.stringify({
      action: "read", tool: "soul.open_pointer", arguments: { source_target: member.source_target }
    });
  }
  return JSON.stringify({ action: "answer", text: "Aster" });
}

function requestUser(body: string): string {
  const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] };
  return parsed.messages?.find(message => message.role === "user")?.content ?? "";
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

function firstMember(output: Record<string, unknown> | undefined) {
  const lines = asArray(output?.member_index).map(asRecord).filter((line): line is Record<string, unknown> => line !== undefined);
  return lines.find(line => line.in_pool === false && line.source_target !== undefined)
    ?? lines.find(line => line.source_target !== undefined);
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
