import { afterAll, beforeAll, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sourceDisclosure, SourceDisclosureSchema, SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import * as revisionOwner from "../../../runs/extraction/authority/inspection.js";
import { chainIdentity } from "../../../runs/semantic-chain/contract.js";
import { admitOrdinaryRecallObservation, inspectOrdinaryRecallObservation } from "../../../runs/semantic-chain/consumer/ordinary-recall.js";
import { OrdinaryRecallContextSchema, OrdinaryRecallEnvelopeSchema, OrdinaryRecallObservationSchema,
  OrdinaryRecallPreparationSchema, OrdinaryRecallRequestRecordSchema,
  OrdinaryRecallWireRecordSchema } from "../../../runs/semantic-chain/consumer/ordinary-recall-contract.js";
import { FirstExposurePageSchema } from "../../../runs/measurement/first-exposure-session.js";
import { admitConsumerPreparation, CONSUMER_SYSTEM_PROMPT, consumerResponseJsonSchema, prepareOrdinaryRecallConsumer,
  TASK_CONSUMER_SCHEMA_NAME } from "../../../runs/semantic-chain/consumer/input.js";
import { pinSemanticChainConsumerAuthority } from "../../../runs/semantic-chain/consumer/authority.js";
import { executeSemanticChainConsumer } from "../../../runs/semantic-chain/consumer/execute.js";
import { consumerResultPath } from "../../../runs/semantic-chain/consumer/persist.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { semanticProviderRequestCacheKey } from "../../../runs/provider-request/request-binding.js";
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
  isolation.restore(); expect(isolation.violations).toEqual([]);
});

function prepareInput(observationRoot: string, name: string,
  arms: ("native_delivery" | "question_only")[] = ["native_delivery"], evidenceView?: string) {
  const preparationRoot = join(base.root, name);
  return prepareOrdinaryRecallConsumer({ observationRoot, consumerConfig: {
    model: CONSUMER_CONFIG.model, provider_url: CONSUMER_CONFIG.providerUrl, request_profile: CONSUMER_CONFIG.requestProfile,
    max_output_tokens: 128, arms, ...(evidenceView === undefined ? {} : { evidence_view: evidenceView }) } }, preparationRoot);
}

function prepare(observationRoot: string, name: string,
  arms: ("native_delivery" | "question_only")[] = ["native_delivery"], evidenceView?: string) {
  const preparation = prepareInput(observationRoot, name, arms, evidenceView), preparationRoot = preparation.output_root;
  const authority = pinSemanticChainConsumerAuthority({ preparationRoot, inputUsdPerMillion: 0.14,
    outputUsdPerMillion: 0.42, spendCeilingUsd: 1 });
  const root = authority.execution_scope.execution_root_path;
  return { preparation, authority, root, key: authority.keys[0]!,
    ledgerPath: join(root, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`) };
}

function captureWithProtocolVersion(name: string, protocolVersion: string, mode: keyof typeof captures = "prefix") {
  const root = join(base.root, name); cpSync(captures[mode].root, root, { recursive: true });
  const config = readJson(join(root, "config.json")); config.protocol_package_version = protocolVersion;
  writeJson(join(root, "config.json"), config);
  for (const path of ["preparation.json", "execution/reservation.json"]) {
    const value = readJson(join(root, path)); value.config_identity = chainIdentity(config); writeJson(join(root, path), value);
  }
  if (protocolVersion !== "19.0.0") {
    // Historical producers emitted named objects; pre-18 records also predate representation metadata.
    for (let ordinal = 1; ordinal <= captures[mode].observation.calls; ordinal += 1) {
      rewriteCapturedEnvelope(root, ordinal, envelope => {
        const block = envelope.content.find(value => value.type === "text")!;
        const payload = JSON.parse(String(block.text));
        if (payload.ok !== true) return envelope;
        for (const row of payload.output.results) {
          row.source_disclosure = sourceDisclosure(SourceDisclosureSchema.parse(row.source_disclosure));
          if (["14.1.0", "15.0.0", "16.0.0", "17.0.0"].includes(protocolVersion)) row.source_disclosure.material_kind = "original_body";
        }
        return { ...envelope, structuredContent: payload,
          content: envelope.content.map(value => value === block ? { ...block, text: JSON.stringify(payload) } : value) };
      });
    }
  }
  return { root, config };
}

function rewriteCapturedEnvelope(root: string, ordinal: number,
  rewrite: (value: z.infer<typeof OrdinaryRecallEnvelopeSchema>) => z.infer<typeof OrdinaryRecallEnvelopeSchema>) {
  const path = join(root, "execution", `${String(ordinal).padStart(2, "0")}-public-envelope.json`);
  const envelope = rewrite(OrdinaryRecallEnvelopeSchema.parse(readJson(path))); writeJson(path, envelope);
  const wirePath = join(root, "execution/public-mcp-messages.jsonl");
  const wire = readFileSync(wirePath, "utf8").trimEnd().split("\n").map(line => OrdinaryRecallWireRecordSchema.parse(JSON.parse(line)));
  const reply = wire.filter(row => row.direction === "server_to_client" && row.message.result !== undefined)[ordinal - 1];
  expect(reply).toBeDefined(); reply!.message.result = envelope;
  writeFileSync(wirePath, `${wire.map(row => JSON.stringify(row)).join("\n")}\n`);
  return envelope;
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
  expect(capture.config.protocol_package_version).toBe("19.0.0");
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

it.each(["14.1.0", "15.0.0", "16.0.0", "17.0.0", "18.0.0", "18.1.0"])("admits a %s archive with the current reader without rewriting producer provenance", protocolVersion => {
  const { root, config } = captureWithProtocolVersion(`historical-${protocolVersion}`, protocolVersion);
  const original = readFileSync(join(root, "config.json"), "utf8");
  const originalEnvelope = readFileSync(join(root, "execution", "01-public-envelope.json"), "utf8");
  const observation = admitOrdinaryRecallObservation(root);
  const binding = { protocol_package_version: protocolVersion, reader_protocol_package_version: "19.0.0",
    producer_candidate: config.candidate, producer_revision: config.implementation_revision };
  expect(observation.binding).toMatchObject(binding);
  expect(observation.state).toBe("partial");
  const run = prepare(root, `historical-consumer-${protocolVersion}`);
  expect(run.preparation.observation_binding).toMatchObject(binding);
  expect(admitConsumerPreparation(run.preparation.output_root).preparation).toEqual(run.preparation);
  expect(readFileSync(join(root, "config.json"), "utf8")).toBe(original);
  expect(readFileSync(join(root, "execution", "01-public-envelope.json"), "utf8")).toBe(originalEnvelope);
});

it.each(["18.0.0", "18.1.0", "19.0.0"])("refuses legacy original-body qualification relabeled as a %s capture", protocolVersion => {
  const { root, config } = captureWithProtocolVersion(`original-overclaim-${protocolVersion}`, "17.0.0");
  config.protocol_package_version = protocolVersion;
  writeJson(join(root, "config.json"), config);
  for (const path of ["preparation.json", "execution/reservation.json"]) {
    const value = readJson(join(root, path)); value.config_identity = chainIdentity(config); writeJson(join(root, path), value);
  }
  if (protocolVersion !== "19.0.0") {
    expect(() => admitOrdinaryRecallObservation(root)).toThrow("public source qualifications differ from sealed metadata");
    return;
  }
  try {
    admitOrdinaryRecallObservation(root);
    expect.unreachable("current 19.0.0 wire admitted a named-object source_disclosure");
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    expect(error.issues).toEqual([{ expected: "tuple", code: "invalid_type",
      path: ["results", 0, "source_disclosure"], message: "Invalid input: expected tuple, received object" }]);
  }
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
  expect(() => prepareInput(captures.error.root, "reference-zero-exposure", ["native_delivery"], "exact_reference_deduplication"))
    .toThrow(/successful public source exposure/u);
});

it("keeps an unfinished reserved episode unknown and refuses authority", () => {
  const root = join(base.root, "unknown-capture"); cpSync(captures.prefix.root, root, { recursive: true });
  unlinkSync(join(root, "execution/process-result.json"));
  expect(inspectOrdinaryRecallObservation(root)).toMatchObject({ state: "unknown", closed: false });
  expect(() => prepare(root, "unknown-consumer")).toThrow(/closed/u);
  expect(() => prepareInput(root, "reference-unknown-consumer", ["native_delivery"], "exact_reference_deduplication")).toThrow(/closed/u);
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

it.each(["15.0.1", "18.2.0", "20.0.0"])("refuses unsupported producer version %s even with a recomputed configuration binding", protocolVersion => {
  const { root } = captureWithProtocolVersion(`unsupported-producer-${protocolVersion}`, protocolVersion);
  expect(() => prepare(root, `unsupported-consumer-${protocolVersion}`)).toThrow();
});

it("rejects a replacement public source preview even when its retained MCP reply agrees", () => {
  const root = join(base.root, "replaced-public-preview"); cpSync(captures.prefix.root, root, { recursive: true });
  rewriteCapturedEnvelope(root, 1, envelope => {
    const original = z.object({ ok: z.literal(true), output: SoulMemorySearchResponseSchema }).passthrough()
      .parse(JSON.parse(String(envelope.content[0]!.text)));
    const payload = { ...original, output: { ...original.output, results: original.output.results.map((row, index) =>
      index === 0 ? { ...row, content_preview: `!${row.content_preview.slice(1)}` } : row) } };
    envelope.content[0]!.text = JSON.stringify(payload); envelope.structuredContent = payload; return envelope;
  });
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

it("keeps default ordinary consumer prompt bytes and request keys unchanged", () => {
  const capture = captures.complete, observation = admitOrdinaryRecallObservation(capture.root);
  const preparation = prepareInput(capture.root, "default-view", ["native_delivery", "question_only"]);
  const { lines } = admitConsumerPreparation(preparation.output_root);
  expect(preparation.consumer_config).not.toHaveProperty("evidence_view");
  for (const line of lines) {
    const userPrompt = JSON.stringify({ original_query: QUESTION, query_as_of: capture.config.first_request.source_observed_at,
      evidence: line.arm === "native_delivery" ? observation.evidence : null });
    expect(line.userPrompt).toBe(userPrompt);
    expect(line.key).toBe(semanticProviderRequestCacheKey({ identityPrefix: "task-consumer-request-v1",
      model: CONSUMER_CONFIG.model, requestProfile: CONSUMER_CONFIG.requestProfile, providerUrl: CONSUMER_CONFIG.providerUrl,
      systemPrompt: CONSUMER_SYSTEM_PROMPT, userPrompt, schema: consumerResponseJsonSchema(),
      maxOutputTokens: 128, schemaName: TASK_CONSUMER_SCHEMA_NAME }));
  }
  const explicit = prepareInput(capture.root, "explicit-original-view", ["native_delivery", "question_only"], "original_public_envelopes");
  expect(admitConsumerPreparation(explicit.output_root).lines).toEqual(lines);
});

it("removes only verified mirrors from a complete Protocol 15 archive while preserving every independent field", () => {
  const { root, config } = captureWithProtocolVersion("mirrored-historical-complete", "15.0.0", "complete");
  const expectedEnvelopes = Array.from({ length: captures.complete.observation.calls }, (_, index) => {
    const ordinal = index + 1;
    const before = { type: "resource_link", uri: `fixture:qualification:${ordinal}`, name: "Independent qualification",
      text: "This non-text block field is independent", annotations: { audience: ["user"] } };
    const after = { type: "image", data: "AA==", mimeType: "image/png", _meta: { sequence: ordinal } };
    const metadata = { type: "text", annotations: { audience: ["assistant"], priority: 0.5 }, _meta: { note: "Résumé 🙂", ordinal } };
    const envelope = rewriteCapturedEnvelope(root, ordinal, value => {
      const text = value.content[0]!.text;
      expect(typeof text).toBe("string");
      const payload = JSON.parse(String(text));
      return { ...value, _meta: { public_call: ordinal }, content: [before,
        { ...metadata, text: JSON.stringify(Object.fromEntries(Object.entries(payload).reverse()), null, 2) }, after] };
    });
    return { ...envelope, content: [before, metadata, after] };
  });
  const paths = ["config.json", "execution/public-mcp-messages.jsonl", ...expectedEnvelopes.map((_, index) =>
    `execution/${String(index + 1).padStart(2, "0")}-public-envelope.json`)];
  const originals = paths.map(path => readFileSync(join(root, path), "utf8"));
  const observation = admitOrdinaryRecallObservation(root);
  expect(observation.state).toBe("complete");
  const original = prepareInput(root, "original-mixed-view", ["native_delivery", "question_only"]);
  const derived = prepareInput(root, "derived-mixed-view", ["native_delivery", "question_only"], "verified_mirror_removal");
  const originalLines = admitConsumerPreparation(original.output_root).lines;
  const admitted = admitConsumerPreparation(derived.output_root), line = admitted.lines[0]!;
  expect(admitted.preparation).toEqual(derived);
  expect(derived.consumer_config).toMatchObject({ evidence_view: "verified_mirror_removal" });
  expect(derived.observation_binding).toEqual(original.observation_binding);
  expect(derived.observation_binding).toMatchObject({ observation_identity: observation.binding.observation_identity,
    protocol_package_version: "15.0.0", reader_protocol_package_version: "19.0.0", producer_candidate: config.candidate });
  expect(line.userPrompt).toBe(JSON.stringify({ original_query: QUESTION, query_as_of: config.first_request.source_observed_at,
    evidence: { ...observation.evidence, calls: observation.evidence.calls.map((call, index) =>
      ({ ...call, envelope: expectedEnvelopes[index] })) } }));
  expect(line).toMatchObject({ arm: "native_delivery", systemPrompt: originalLines[0]!.systemPrompt,
    responseJsonSchema: originalLines[0]!.responseJsonSchema, transportProvenance: originalLines[0]!.transportProvenance });
  expect(line.key).not.toBe(originalLines[0]!.key);
  expect(line.requestDigest).not.toBe(originalLines[0]!.requestDigest);
  expect(line.inputByteUpper).toBeLessThan(originalLines[0]!.inputByteUpper);
  expect(admitted.lines[1]).toEqual(originalLines[1]);
  expect(derived.request_timeout).toEqual(original.request_timeout);
  expect(paths.map(path => readFileSync(join(root, path), "utf8"))).toEqual(originals);
});

it("preserves the only text payload when structuredContent is absent", () => {
  const root = join(base.root, "text-only-capture"); cpSync(captures.prefix.root, root, { recursive: true });
  rewriteCapturedEnvelope(root, 1, ({ structuredContent: _absent, ...envelope }) => envelope);
  const original = prepareInput(root, "text-only-original"), derived = prepareInput(root, "text-only-derived",
    ["native_delivery"], "verified_mirror_removal");
  expect(admitConsumerPreparation(derived.output_root).lines).toEqual(admitConsumerPreparation(original.output_root).lines);
});

it.each([
  { name: "non-equivalent", change: (value: z.infer<typeof OrdinaryRecallEnvelopeSchema>) =>
    ({ ...value, structuredContent: { ok: true, output: null } }), message: /representations differ/u },
  { name: "malformed", change: (value: z.infer<typeof OrdinaryRecallEnvelopeSchema>) =>
    ({ ...value, content: [{ type: "text", text: "{malformed" }] }), message: /JSON|property name/u },
  { name: "non-string", change: (value: z.infer<typeof OrdinaryRecallEnvelopeSchema>) =>
    ({ ...value, content: [{ type: "text", text: { invalid: true } }] }), message: /exact text payload/u },
  { name: "mixed-text", change: (value: z.infer<typeof OrdinaryRecallEnvelopeSchema>) =>
    ({ ...value, content: [...value.content, { type: "text", text: "Independent warning" }] }), message: /exact text payload/u },
  { name: "missing-text", change: (value: z.infer<typeof OrdinaryRecallEnvelopeSchema>) =>
    ({ ...value, content: [{ type: "resource_link", uri: "fixture:independent", name: "Independent" }] }), message: /exact text payload/u }
])("refuses a $name envelope before projecting the requested view", ({ name, change, message }) => {
  const root = join(base.root, `invalid-mirror-${name}`); cpSync(captures.prefix.root, root, { recursive: true });
  rewriteCapturedEnvelope(root, 1, change);
  const output = `invalid-mirror-consumer-${name}`;
  expect(() => prepareInput(root, output, ["native_delivery"], "verified_mirror_removal")).toThrow(message);
  expect(existsSync(join(base.root, output, "preparation.json"))).toBe(false);
  expect(() => prepareInput(root, `${output}-references`, ["native_delivery"], "exact_reference_deduplication")).toThrow(message);
  expect(existsSync(join(base.root, `${output}-references`, "preparation.json"))).toBe(false);
});

it.each(["view", "request", "archive"] as const)("refuses changed %s after derived preparation", changed => {
  const root = join(base.root, `view-tamper-${changed}`); cpSync(captures.prefix.root, root, { recursive: true });
  const preparation = prepareInput(root, `view-tamper-consumer-${changed}`, ["native_delivery"], "verified_mirror_removal");
  if (changed === "archive") rewriteCapturedEnvelope(root, 1, envelope => ({ ...envelope, _meta: { new: "unbound metadata" } }));
  else {
    const value = readJson(join(preparation.output_root, "preparation.json"));
    if (changed === "view") delete value.payload.consumer_config.evidence_view;
    else value.payload.requests[0].key = "0".repeat(64);
    value.identity = chainIdentity(value.payload);
    writeJson(join(preparation.output_root, "preparation.json"), value);
  }
  expect(() => admitConsumerPreparation(preparation.output_root)).toThrow(/no longer binds/u);
});

it("sends the derived prefix and terminal error once and rejects later view substitution", async () => {
  const run = prepare(captures.prefix_error.root, "derived-consumer-http", ["native_delivery"], "verified_mirror_removal");
  const { lines } = admitConsumerPreparation(run.preparation.output_root);
  ledgerPath = run.ledgerPath; const before = hits;
  const result = await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" });
  expect(result).toMatchObject({ new_attempts: 1, rows: [{ status: "complete_response" }] });
  expect(hits - before).toBe(1);
  expect(bodies.at(-1)!.messages.find(message => message.role === "user")!.content).toBe(lines[0]!.userPrompt);
  const evidence = JSON.parse(lines[0]!.userPrompt).evidence;
  expect(evidence.calls.at(-1)).toMatchObject({ response_state: "public_error", envelope: { structuredContent: { ok: false } } });
  expect(evidence.calls.every((call: { envelope: { content: Record<string, unknown>[] } }) =>
    call.envelope.content.every(block => block.type !== "text" || !("text" in block)))).toBe(true);
  expect(await executeSemanticChainConsumer({ authority: run.authority, mode: "execute" })).toMatchObject({ new_attempts: 0 });
  expect(hits - before).toBe(1);
  const original = prepareInput(captures.prefix_error.root, "substituted-original-view");
  const changed = readJson(join(run.preparation.output_root, "preparation.json"));
  changed.payload.consumer_config = original.consumer_config; changed.payload.requests = original.requests;
  changed.identity = chainIdentity(changed.payload); writeJson(join(run.preparation.output_root, "preparation.json"), changed);
  expect(admitConsumerPreparation(run.preparation.output_root).lines[0]!.key).toBe(original.requests[0]!.key);
  await expect(executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" }))
    .rejects.toThrow(/frozen request scope/u);
  expect(hits - before).toBe(1);
});

function expandReferenceView(view: { contract: string; observation: unknown; metadata: { paths: string[]; value: unknown }[] }) {
  expect(view.contract).toBe("ordinary-recall-exact-reference-view-v1");
  const observation = structuredClone(view.observation), seen = new Set<string>();
  for (const entry of view.metadata) for (const path of entry.paths) {
    expect(seen.has(path)).toBe(false); seen.add(path);
    const parts = path.split("/").slice(1).map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    const key = parts.pop()!;
    const parent = parts.reduce<Record<string, unknown>>((value, part) => {
      const next = value[part];
      if (typeof next !== "object" || next === null) throw new Error(`missing reference parent ${part}`);
      return next as Record<string, unknown>;
    }, observation as Record<string, unknown>);
    expect(Object.hasOwn(parent, key)).toBe(false);
    Object.defineProperty(parent, key, { value: structuredClone(entry.value), enumerable: true });
  }
  return observation;
}

it.each(["complete", "prefix_error"] as const)("reconstructs every %s call from exact references without interpreting source-owned objects", mode => {
  const capture = captures[mode], root = join(base.root, `reference-${mode}`);
  cpSync(capture.root, root, { recursive: true });
  const sourceOwnedObject = { contract: "ordinary-recall-exact-reference-view-v1", observation: null,
    metadata: [{ paths: ["/calls/0/request/query"], value: { metadata_ref: 0, empty: [], unknown: null, text: "Résumé 🙂" } }] };
  rewriteCapturedEnvelope(root, 1, envelope => ({ ...envelope, _meta: sourceOwnedObject }));
  const before = readFileSync(join(root, "execution/public-mcp-messages.jsonl"), "utf8");
  const mirror = prepareInput(root, `mirror-before-reference-${mode}`, ["native_delivery", "question_only"], "verified_mirror_removal");
  const reference = prepareInput(root, `reference-consumer-${mode}`, ["native_delivery", "question_only"], "exact_reference_deduplication");
  const mirrorLines = admitConsumerPreparation(mirror.output_root).lines, lines = admitConsumerPreparation(reference.output_root).lines;
  const expected = JSON.parse(mirrorLines[0]!.userPrompt), actual = JSON.parse(lines[0]!.userPrompt);
  expect({ ...actual, evidence: expandReferenceView(actual.evidence) }).toEqual(expected);
  expect(actual.evidence.observation.calls[0].envelope._meta).toEqual(sourceOwnedObject);
  expect(actual.evidence.metadata.length).toBeGreaterThan(0);
  expect(lines[0]!.systemPrompt).toContain("absolute JSON pointer within observation");
  expect(lines[0]!.inputByteUpper).toBeLessThan(mirrorLines[0]!.inputByteUpper);
  expect(lines[0]!.key).not.toBe(mirrorLines[0]!.key);
  expect(lines[0]!.requestDigest).not.toBe(mirrorLines[0]!.requestDigest);
  expect(lines[1]).toEqual(mirrorLines[1]);
  expect(reference.observation_binding).toEqual(mirror.observation_binding);
  expect(readFileSync(join(root, "execution/public-mcp-messages.jsonl"), "utf8")).toBe(before);
});

it("sends exact metadata references through the consumer HTTP boundary and rejects a later view change", async () => {
  const run = prepare(captures.prefix_error.root, "reference-consumer-http", ["native_delivery"], "exact_reference_deduplication");
  const { lines } = admitConsumerPreparation(run.preparation.output_root);
  const mirror = prepareInput(captures.prefix_error.root, "reference-http-mirror", ["native_delivery"], "verified_mirror_removal");
  const expected = JSON.parse(admitConsumerPreparation(mirror.output_root).lines[0]!.userPrompt).evidence;
  ledgerPath = run.ledgerPath; const before = hits;
  const result = await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" });
  expect(result).toMatchObject({ new_attempts: 1, rows: [{ status: "complete_response" }] });
  expect(hits - before).toBe(1);
  const body = bodies.at(-1)!;
  expect(body.messages.find(message => message.role === "system")!.content).toBe(lines[0]!.systemPrompt);
  expect(body.messages.find(message => message.role === "user")!.content).toBe(lines[0]!.userPrompt);
  const expanded = expandReferenceView(JSON.parse(body.messages.find(message => message.role === "user")!.content).evidence);
  expect(expanded).toEqual(expected);
  expect(expanded).toMatchObject({ state: "partial", calls: [{ response_state: "success" }, { response_state: "public_error" }] });
  expect(await executeSemanticChainConsumer({ authority: run.authority, mode: "execute" })).toMatchObject({ new_attempts: 0 });
  const changed = readJson(join(run.preparation.output_root, "preparation.json"));
  changed.payload.consumer_config.evidence_view = "verified_mirror_removal"; changed.payload.requests = mirror.requests;
  changed.identity = chainIdentity(changed.payload); writeJson(join(run.preparation.output_root, "preparation.json"), changed);
  await expect(executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" }))
    .rejects.toThrow(/frozen request scope/u);
  expect(hits - before).toBe(1);
});
