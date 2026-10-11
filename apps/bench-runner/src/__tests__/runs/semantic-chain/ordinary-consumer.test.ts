import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cpSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import * as revisionOwner from "../../../runs/extraction/authority/inspection.js";
import { chainIdentity } from "../../../runs/semantic-chain/contract.js";
import { admitOrdinaryRecallObservation, inspectOrdinaryRecallObservation } from "../../../runs/semantic-chain/consumer/ordinary-recall.js";
import { OrdinaryRecallContextSchema, OrdinaryRecallEnvelopeSchema, OrdinaryRecallObservationSchema,
  OrdinaryRecallPreparationSchema, OrdinaryRecallRequestRecordSchema,
  OrdinaryRecallWireRecordSchema } from "../../../runs/semantic-chain/consumer/ordinary-recall-contract.js";
import { FirstExposurePageSchema } from "../../../runs/measurement/first-exposure-session.js";
import { admitConsumerPreparation, prepareOrdinaryRecallConsumer } from "../../../runs/semantic-chain/consumer/input.js";
import { pinSemanticChainConsumerAuthority } from "../../../runs/semantic-chain/consumer/authority.js";
import { executeSemanticChainConsumer } from "../../../runs/semantic-chain/consumer/execute.js";
import { consumerResultPath } from "../../../runs/semantic-chain/consumer/persist.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { nativeConsumerFixture, CONSUMER_CONFIG, QUESTION, HIDDEN_GOLD, HIDDEN_SOURCE } from "./consumer.test-support.js";
import { captureFailedCallFixture, captureOrdinaryFixture, readJson, writeJson } from "./ordinary-consumer.test-support.js";

let base: Awaited<ReturnType<typeof nativeConsumerFixture>>;
const captures = {} as Record<"complete" | "prefix" | "prefix_error" | "error", Awaited<ReturnType<typeof captureOrdinaryFixture>>>;
let hits = 0, ledgerPath = "", reserved = "";
const bodies: { messages: { role: string; content: string }[] }[] = [];
const answer = { answer: "Project Aster is mentioned; this answer retains delivered qualifications.",
  task_completion: "partial", remaining_conditions: ["Source meaning has not been independently assessed."] };
const server = createServer((request, response) => {
  hits += 1; reserved = readFileSync(ledgerPath, "utf8");
  let body = ""; request.setEncoding("utf8"); request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    bodies.push(JSON.parse(body)); response.setHeader("connection", "close"); response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
  });
});
const nativeFetch = globalThis.fetch;

beforeAll(async () => {
  base = await nativeConsumerFixture(`Project Aster was mentioned. ${"Other project context. ".repeat(160)}${HIDDEN_SOURCE}`);
  for (const mode of ["complete", "prefix", "prefix_error", "error"] as const) captures[mode] = await captureOrdinaryFixture(base, mode);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "true");
  globalThis.fetch = ((url, init) => {
    const selected = new URL(String(url)); expect(selected.origin).toBe("https://api.stepfun.com");
    return nativeFetch(new URL(selected.pathname, origin), init);
  }) as typeof fetch;
}, 120000);

afterAll(async () => {
  globalThis.fetch = nativeFetch; vi.unstubAllEnvs(); vi.restoreAllMocks();
  server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  if (base !== undefined) rmSync(base.root, { recursive: true, force: true });
});

function prepare(observationRoot: string, name: string, arms: ("native_delivery" | "question_only")[] = ["native_delivery"]) {
  const preparationRoot = join(base.root, name);
  const preparation = prepareOrdinaryRecallConsumer({ observationRoot, consumerConfig: {
    model: CONSUMER_CONFIG.model, provider_url: CONSUMER_CONFIG.providerUrl, request_profile: CONSUMER_CONFIG.requestProfile,
    max_output_tokens: 128, arms } }, preparationRoot);
  const authority = pinSemanticChainConsumerAuthority({ preparationRoot, inputUsdPerMillion: 0.14,
    outputUsdPerMillion: 0.42, spendCeilingUsd: 1 });
  const root = authority.execution_scope.execution_root_path;
  return { preparation, authority, root, key: authority.keys[0]!,
    ledgerPath: join(root, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`) };
}

it.each(["complete", "prefix", "prefix_error"] as const)("passes the exact ordered %s public envelopes through the consumer HTTP boundary", async mode => {
  const capture = captures[mode], observation = admitOrdinaryRecallObservation(capture.root);
  expect(observation.state).toBe(mode === "complete" ? "complete" : "partial");
  expect(observation.evidence.calls.map(call => call.envelope)).toEqual(Array.from({ length: capture.observation.calls },
    (_, index) => readJson(join(capture.execution, `${String(index + 1).padStart(2, "0")}-public-envelope.json`))));
  const run = prepare(capture.root, `consume-${mode}`, ["native_delivery", "question_only"]);
  ledgerPath = run.ledgerPath; const before = hits;
  const result = await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" });
  expect(result).toMatchObject({ new_attempts: 2, fidelity: "unassessed", rows: [{ status: "complete_response" }, { status: "complete_response" }] });
  expect(hits - before).toBe(2);
  const delivered = JSON.parse(bodies.at(-2)!.messages.find(message => message.role === "user")!.content);
  expect(delivered).toEqual({ original_query: QUESTION, query_as_of: capture.config.first_request.source_observed_at, evidence: observation.evidence });
  expect(JSON.stringify(delivered)).not.toContain(HIDDEN_GOLD);
  expect(JSON.stringify(delivered)).not.toContain("snapshot_sha256");
  expect(JSON.stringify(delivered)).not.toContain("trusted_context");
  expect(JSON.stringify(delivered).includes(HIDDEN_SOURCE)).toBe(mode === "complete");
  expect(JSON.parse(bodies.at(-1)!.messages.find(message => message.role === "user")!.content).evidence).toBeNull();
  if (mode === "prefix_error") expect(delivered.evidence.calls.at(-1)).toMatchObject({ response_state: "public_error" });
  const replayed = await executeSemanticChainConsumer({ authority: run.authority, mode: "execute" });
  expect(replayed.new_attempts).toBe(0); expect(hits - before).toBe(2);
});

it("keeps producer provenance while binding preparation and execution to the current verifier", async () => {
  const capture = captures.prefix, producer = capture.config.implementation_revision;
  const verifier = "b".repeat(40), next = "c".repeat(40);
  const revision = vi.spyOn(revisionOwner, "readCurrentExtractionAuthorityRevision").mockReturnValue(verifier);
  try {
    const run = prepare(capture.root, "historical-producer");
    expect(run.preparation.observation_binding).toMatchObject({ producer_revision: producer,
      producer_candidate: capture.config.candidate, protocol_package_version: capture.config.protocol_package_version, verification_revision: verifier });
    ledgerPath = run.ledgerPath;
    await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" });
    const before = hits;
    revision.mockReturnValue(next);
    await expect(executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" })).rejects.toThrow();
    expect(hits).toBe(before); expect(readJson(join(capture.root, "config.json")).implementation_revision).toBe(producer);
  } finally { revision.mockRestore(); }
});

it("recovers retained consumer bytes without another dispatch after interrupted result publication", async () => {
  const run = prepare(captures.prefix.root, "ordinary-recovery"); ledgerPath = run.ledgerPath;
  await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" });
  const raw = readProviderRawAttempt(run.root, run.key, 1), before = hits;
  unlinkSync(consumerResultPath(run.root, run.key)); writeFileSync(run.ledgerPath, reserved);
  const recovered = await executeSemanticChainConsumer({ authority: run.authority, mode: "recover" });
  expect(recovered).toMatchObject({ new_attempts: 0, rows: [{ status: "complete_response" }], ledger: { attempts: 1 } });
  expect(readProviderRawAttempt(run.root, run.key, 1)).toEqual(raw); expect(hits).toBe(before);
});

it("reports a terminal public error but refuses consumer authority without source exposure", () => {
  expect(inspectOrdinaryRecallObservation(captures.error.root)).toMatchObject({ state: "failed", successfulExposures: 0 });
  expect(() => prepare(captures.error.root, "zero-exposure")).toThrow(/successful public source exposure/u);
});

it("keeps an unfinished reserved episode unknown and refuses authority", () => {
  const root = join(base.root, "unknown-capture"); cpSync(captures.prefix.root, root, { recursive: true });
  unlinkSync(join(root, "execution/process-result.json"));
  expect(inspectOrdinaryRecallObservation(root)).toMatchObject({ state: "unknown", closed: false });
  expect(() => prepare(root, "unknown-consumer")).toThrow(/closed/u);
});

it.each([
  { name: "first call after handler entry", capture: "prefix", retainedContext: true, rpcError: false },
  { name: "first call before handler entry", capture: "prefix", retainedContext: false, rpcError: false },
  { name: "first RPC error after handler entry", capture: "prefix", retainedContext: true, rpcError: true },
  { name: "first RPC error before handler entry", capture: "prefix", retainedContext: false, rpcError: true },
  { name: "later call after handler entry", capture: "prefix_error", retainedContext: true, rpcError: false },
  { name: "later RPC error before handler entry", capture: "prefix_error", retainedContext: false, rpcError: true }
] as const)("preserves the producer summary when the $name never returns", ({ name, capture, ...options }) => {
  const run = captureFailedCallFixture(captures[capture], join(base.root, `failed-call-${name}`), options), before = hits;
  const inspected = inspectOrdinaryRecallObservation(run.root), last = inspected.evidence.calls.at(-1)!;
  expect(inspected).toMatchObject({ state: "failed", closed: false, successfulExposures: capture === "prefix" ? 0 : 1 });
  expect(last).toMatchObject({ envelope: null, response_state: options.rpcError ? "transport_error" : "unknown" });
  expect(inspected.evidence.calls[0]!.envelope).toEqual(capture === "prefix" ? null
    : readJson(join(captures.prefix_error.execution, "01-public-envelope.json")));
  expect(() => prepare(run.root, `consumer-failed-call-${name}`)).toThrow(/closed/u);
  expect(readJson(join(run.execution, "observation-final-state.json"))).toEqual(run.observation);
  expect(hits).toBe(before);
});

it.each(["workspaceId", "runId"] as const)("checks retained %s even when the principal summary was never populated", key => {
  const run = captureFailedCallFixture(captures.prefix, join(base.root, `failed-call-${key}`), { retainedContext: true, rpcError: false });
  const path = join(run.execution, "01-trusted-contexts.json"), contexts = readJson(path); contexts[0][key] = "other"; writeJson(path, contexts);
  expect(() => inspectOrdinaryRecallObservation(run.root)).toThrow(/workspace or run/u);
});

it("rejects a recorded principal that conflicts with returned public-call context", () => {
  const run = captureFailedCallFixture(captures.prefix_error, join(base.root, "failed-call-conflicting-summary"), { retainedContext: true, rpcError: false });
  writeJson(join(run.execution, "observation-final-state.json"), { ...run.observation,
    trusted_principal: { ...OrdinaryRecallContextSchema.parse(run.observation.trusted_principal), sessionId: "other" } });
  expect(() => inspectOrdinaryRecallObservation(run.root)).toThrow(/trusted principal/u);
});

it("rejects a failed call context that changes the previously returned principal", () => {
  const run = captureFailedCallFixture(captures.prefix_error, join(base.root, "failed-call-conflicting-context"), { retainedContext: true, rpcError: false });
  const path = join(run.execution, "02-trusted-contexts.json"), contexts = readJson(path);
  contexts[0].sessionId = "other"; writeJson(path, contexts);
  expect(() => inspectOrdinaryRecallObservation(run.root)).toThrow(/principal changed/u);
});

it("rejects multiple retained handler contexts for an unreturned call", () => {
  const run = captureFailedCallFixture(captures.prefix, join(base.root, "failed-call-duplicate-context"), { retainedContext: true, rpcError: false });
  const path = join(run.execution, "01-trusted-contexts.json"), contexts = readJson(path);
  writeJson(path, [...contexts, ...contexts]);
  expect(() => inspectOrdinaryRecallObservation(run.root)).toThrow(/unique trusted context/u);
});

it.each([
  { name: "nonzero exit", capture: "prefix", state: "failed", close: { code: 1, signal: null }, forced: false },
  { name: "forced termination", capture: "complete", state: "unknown", close: { code: null, signal: "SIGTERM" }, forced: true },
  { name: "signal interruption", capture: "prefix", state: "unknown", close: { code: null, signal: "SIGINT" }, forced: false }
] as const)("inspects $name with retained shutdown evidence without authorizing its public prefix", ({ name, capture: mode, state, close, forced }) => {
  const capture = captures[mode], root = join(base.root, `process-${name}`), before = hits;
  cpSync(capture.root, root, { recursive: true });
  const processResult = { status: "failed_or_interrupted", close, forced, child_error: null,
    process_in_flight: false, no_retry: true };
  const shutdown = { ...readJson(join(root, "execution/shutdown.json")),
    failure: { name: "Error", message: "fixture observation failure" } };
  writeJson(join(root, "execution/process-result.json"), processResult);
  writeJson(join(root, "execution/shutdown.json"), shutdown);
  const inspected = inspectOrdinaryRecallObservation(root);
  expect(inspected).toMatchObject({ state, closed: false, successfulExposures: capture.observation.calls });
  expect(inspected.evidence.calls.map(call => call.envelope)).toEqual(Array.from({ length: capture.observation.calls },
    (_, index) => readJson(join(capture.execution, `${String(index + 1).padStart(2, "0")}-public-envelope.json`))));
  expect(() => prepare(root, `consumer-${name}`)).toThrow(/closed/u);
  expect(readJson(join(root, "execution/process-result.json"))).toEqual(processResult);
  expect(readJson(join(root, "execution/shutdown.json"))).toEqual(shutdown);
  expect(hits).toBe(before);
});

it("inspects a producer failure before daemon startup with its retained shutdown record", () => {
  const root = join(base.root, "daemon-start-failed"), capture = captures.prefix;
  cpSync(capture.root, root, { recursive: true });
  const execution = join(root, "execution"); rmSync(execution, { recursive: true }); mkdirSync(execution);
  writeJson(join(execution, "reservation.json"), readJson(join(capture.execution, "reservation.json")));
  writeJson(join(execution, "process-result.json"), { status: "failed_or_interrupted", close: { code: 1, signal: null },
    forced: false, child_error: null, process_in_flight: false, no_retry: true });
  writeJson(join(execution, "shutdown.json"), { ...readJson(join(capture.execution, "shutdown.json")),
    daemon_started: false, failure: { name: "Error", message: "fixture daemon startup failure" } });
  expect(inspectOrdinaryRecallObservation(root)).toMatchObject({ state: "failed", closed: false, successfulExposures: 0 });
  expect(() => prepare(root, "daemon-start-consumer")).toThrow(/closed/u);
});

it.each([
  { status: "closed", close: { code: 1, signal: null } },
  { status: "failed_or_interrupted", close: { code: 0, signal: null } }
])("rejects a process status that contradicts its exit record: $status", ({ status, close }) => {
  const root = join(base.root, `contradictory-process-${status}`); cpSync(captures.prefix.root, root, { recursive: true });
  writeJson(join(root, "execution/process-result.json"), { status, close,
    forced: false, child_error: null, process_in_flight: false, no_retry: true });
  expect(() => inspectOrdinaryRecallObservation(root)).toThrow();
});

it.each([
  ["envelope", "execution/01-public-envelope.json", (value: unknown) => {
    const parsed = OrdinaryRecallEnvelopeSchema.parse(value); parsed.content[0]!.text += " "; return parsed;
  }],
  ["context", "execution/01-trusted-contexts.json", (value: unknown) => {
    const parsed = z.array(OrdinaryRecallContextSchema).parse(value); parsed[0]!.workspaceId = "other"; return parsed;
  }],
  ["first-exposure", "execution/01-first-exposure.json", (value: unknown) => {
    const parsed = FirstExposurePageSchema.parse(value); return { ...parsed, initial: { ...parsed.initial!, session_id: "replaced" } };
  }],
  ["producer", "preparation.json", (value: unknown) => ({ ...OrdinaryRecallPreparationSchema.parse(value), candidate: "d".repeat(40) })],
  ["request", "execution/02-request.json", (value: unknown) => {
    const parsed = OrdinaryRecallRequestRecordSchema.parse(value), continuation = parsed.arguments.payload_continuation!;
    return { ...parsed, arguments: { ...parsed.arguments, payload_continuation: { ...continuation, start_offset: (continuation.start_offset ?? 0) + 1 } } };
  }],
  ["summary", "execution/observation-final-state.json", (value: unknown) => ({ ...OrdinaryRecallObservationSchema.parse(value), source_complete: false })]
] as const)("refuses changed %s witnesses before provider dispatch", async (name, path, change) => {
  const root = join(base.root, `changed-${name}`); cpSync(captures.complete.root, root, { recursive: true });
  const run = prepare(root, `prepared-${name}`), value = readJson(join(root, path)), before = hits;
  writeJson(join(root, path), change(value));
  await expect(executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" })).rejects.toThrow();
  expect(hits).toBe(before);
});

it("refuses unsupported producer contracts even if the local configuration binding is recomputed", () => {
  const root = join(base.root, "unsupported-producer"); cpSync(captures.prefix.root, root, { recursive: true });
  const config = readJson(join(root, "config.json")); config.protocol_package_version = "16.0.0";
  writeJson(join(root, "config.json"), config);
  for (const path of ["preparation.json", "execution/reservation.json"]) {
    const value = readJson(join(root, path)); value.config_identity = chainIdentity(config); writeJson(join(root, path), value);
  }
  expect(() => prepare(root, "unsupported-consumer")).toThrow();
});

it("rejects a replacement public source preview even when its retained MCP reply agrees", () => {
  const root = join(base.root, "replaced-public-preview"); cpSync(captures.prefix.root, root, { recursive: true });
  const path = join(root, "execution/01-public-envelope.json"), envelope = OrdinaryRecallEnvelopeSchema.parse(readJson(path));
  const original = z.object({ ok: z.literal(true), output: SoulMemorySearchResponseSchema }).passthrough()
    .parse(JSON.parse(String(envelope.content[0]!.text)));
  const payload = { ...original, output: { ...original.output, results: original.output.results.map((row, index) =>
    index === 0 ? { ...row, content_preview: `!${row.content_preview.slice(1)}` } : row) } };
  envelope.content[0]!.text = JSON.stringify(payload); envelope.structuredContent = payload; writeJson(path, envelope);
  const wirePath = join(root, "execution/public-mcp-messages.jsonl");
  const wire = readFileSync(wirePath, "utf8").trimEnd().split("\n").map(line => OrdinaryRecallWireRecordSchema.parse(JSON.parse(line)));
  wire[1]!.message.result = envelope; writeFileSync(wirePath, `${wire.map(row => JSON.stringify(row)).join("\n")}\n`);
  expect(() => prepare(root, "replaced-preview-consumer")).toThrow(/source|preview/u);
});

it("rejects output overlap and later witness removal without touching the source archive", () => {
  const capture = captures.prefix;
  expect(() => prepareOrdinaryRecallConsumer({ observationRoot: capture.root, consumerConfig: {
    model: CONSUMER_CONFIG.model, provider_url: CONSUMER_CONFIG.providerUrl, request_profile: CONSUMER_CONFIG.requestProfile,
    max_output_tokens: 128, arms: ["native_delivery"] } }, join(capture.root, "consumer"))).toThrow(/separate/u);
  const root = join(base.root, "removed-witness"); cpSync(capture.root, root, { recursive: true });
  const run = prepare(root, "witness-consumer"); unlinkSync(join(root, "execution/01-first-exposure.json"));
  expect(() => admitConsumerPreparation(run.preparation.output_root)).toThrow();
});
