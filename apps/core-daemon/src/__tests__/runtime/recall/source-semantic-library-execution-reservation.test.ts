import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { qualifySourceDisclosure, sourceDisclosure, canonicalJson, indexEntryCacheKey, sourceSemanticAccessPhases, sourceSemanticExecution,
  SourceSemanticExecutionSchema, SourceSemanticWorkerResultSchema, type SourceSemanticAccessReceipt,
  type SourceSemanticExecution, type SourceSemanticWorkerResult, type SoulInterpretationResponse
} from "@do-soul/alaya-protocol";
import * as Core from "@do-soul/alaya-core";
import { assembleSourceSemanticLibraryIndex, encodeSourceSemanticLibraryResponse, preparedDeliveryId,
  sealIssuedContinuation, sourceGoldRootIdentity } from "@do-soul/alaya-core";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import * as Observation from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { assertBuiltWorker, builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { BUDGET, CLOCK, ORIGINAL, RAW_BODY, RESERVED_WORK, assembledSourcePage, discriminatingByteCap,
  executionLibrary, payload, publicReservationBytes, type ExecutionLibrary, type RecallRequest } from "./source-semantic-library-execution-fixture.js";

type Recall = Extract<SourceSemanticWorkerResult, { kind: "recall" }>;
type PublicRecall = Extract<SoulInterpretationResponse, { operation: "recall" }>;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const NATIVE = "native_reasoning_only" as const;

function publicRecall(result: Recall): PublicRecall {
  const encoded = encodeSourceSemanticLibraryResponse(result);
  if (encoded.operation !== "recall" || encoded.results === undefined) throw new Error("public recall membership expected");
  return encoded;
}
function recall(result: SourceSemanticWorkerResult): Recall {
  if (result.kind !== "recall") throw new Error("native recall expected");
  return result;
}
function accessProvenance(access: SourceSemanticAccessReceipt) {
  const phases = sourceSemanticAccessPhases(access);
  return { preparation: phases.preparation, acquisition: phases.acquisition, pool: access.pool_id };
}
function activeExecution(fixture: ExecutionLibrary, result: Recall,
  preparation = fixture.prepared.receipt): SourceSemanticExecution {
  const acquisition = sourceSemanticAccessPhases(result.discovery.access!).acquisition;
  expect(acquisition).toMatchObject({ status: "executed", accounting: "complete", result: { completion: "complete" } });
  return sourceSemanticExecution(preparation, acquisition);
}

/** Oracle for the mandatory public envelope: explicit current phases and maximum work,
 * excluding optional source time. Neither the production reservation nor workOf is used.
 */
function expectedReservation(result: Recall, execution: SourceSemanticExecution): PublicRecall {
  const source_disclosures = Object.fromEntries(Object.entries(result.source_disclosures).map(([key, value]) => {
    return [key, qualifySourceDisclosure(value, sourceDisclosure(value).proof_use.kind, false)];
  }));
  return publicRecall({ ...result, execution, source_disclosures, work: RESERVED_WORK });
}
type QuotedAdmission = Readonly<{
  memberKeys: readonly string[]; more: boolean; payload: string;
  quote: Readonly<{ bytes: number; withinBudget: boolean }>;
}>;
function quoteMatches(quote: QuotedAdmission, admitted: Pick<QuotedAdmission, "memberKeys" | "more" | "payload">): boolean {
  return quote.more === admitted.more && quote.payload === admitted.payload
    && quote.memberKeys.length === admitted.memberKeys.length
    && quote.memberKeys.every((key, index) => key === admitted.memberKeys[index]);
}
function admissionHolds(quote: QuotedAdmission, reservedBytes: number): boolean {
  return quote.quote.bytes === reservedBytes && quote.quote.withinBudget;
}
function admittedQuote(quotes: readonly QuotedAdmission[], result: Recall): QuotedAdmission {
  const admitted = { memberKeys: result.index.entries.map(row => indexEntryCacheKey(row)),
    more: result.index.continuation !== null, payload: result.coverage.payload };
  const matched = quotes.filter(row => quoteMatches(row, admitted));
  if (matched.length === 0) throw new Error("no Core quote bound to admitted membership and frame");
  return matched[matched.length - 1]!;
}
function captureReservations() {
  const reservations = new Map<string, PublicRecall>(), quotes: QuotedAdmission[] = [];
  const create = Core.createSourceSemanticLibraryEncoding;
  const memberKey = new WeakMap<object, string>();
  const record = (members: readonly object[], more: boolean, payload: string,
    quote: { bytes: number; withinBudget: boolean }) => {
    quotes.push({ memberKeys: members.map(row => memberKey.get(row)!), more, payload,
      quote: { bytes: quote.bytes, withinBudget: quote.withinBudget } });
  };
  vi.spyOn(Core, "createSourceSemanticLibraryEncoding").mockImplementation(meter => {
    const session = create(meter);
    return { ...session, prepareRaw: (...args) => {
      const raw = session.prepareRaw(...args);
      if (raw === null) return null;
      const result = args[0];
      for (const [index, member] of raw.members.entries()) {
        memberKey.set(member, indexEntryCacheKey(result.index.entries[index]!));
      }
      record(raw.members, result.index.continuation !== null, result.coverage.payload, raw.initial);
      return { initial: raw.initial, members: raw.members, member: input => {
        const member = raw.member(input);
        if (member !== null) memberKey.set(member, indexEntryCacheKey(input.entry));
        return member;
      }, quote: (frame, members) => {
        const quote = raw.quote(frame, members);
        record(members, frame.index.continuation !== null && frame.index.continuation !== undefined,
          frame.payload, quote);
        return quote;
      } };
    } };
  });
  const retain = SourceSemanticReadBudget.prototype.retain;
  vi.spyOn(SourceSemanticReadBudget.prototype, "retain").mockImplementation(function (this: SourceSemanticReadBudget, value, phase) {
    retain.call(this, value, phase);
    if (phase !== "candidate delivery encoding") return;
    const encoded = value as SoulInterpretationResponse;
    if (encoded.operation === "recall" && encoded.delivery_id !== undefined) reservations.set(encoded.delivery_id, encoded);
  });
  return { encodings: reservations, quotes };
}
function assertBounded(result: Recall, request: RecallRequest, execution: SourceSemanticExecution,
  reservations?: ReturnType<typeof captureReservations>) {
  expect(result.request_budget).toEqual(BUDGET);
  expect(result.execution).toEqual(execution);
  const encoded = publicRecall(result), expected = expectedReservation(result, execution);
  expect(encoded.execution).toEqual(execution);
  expect(bytes(expected)).toBeLessThanOrEqual(request.output_byte_limit);
  expect(bytes(encoded)).toBeLessThanOrEqual(request.output_byte_limit);
  expect(encoded.results!.every(row => row.budget_state.within_budget)).toBe(true);
  expect(result.work.logical_work).toBeLessThanOrEqual(BUDGET.work_units);
  expect(result.work.logical_memory_bytes).toBeLessThanOrEqual(BUDGET.memory_bytes);
  if (reservations !== undefined) {
    const reserved = reservations.encodings.get(result.delivery_id);
    if (reserved === undefined) {
      // Raw incremental admission does not materialize a complete candidate page.
      // Observe the real Core quotation and compare its extent with this independent
      // complete public-encoder oracle; proof paths must still materialize.
      expect(result.proofs?.length ?? 0).toBe(0);
      expect(admissionHolds(admittedQuote(reservations.quotes, result), bytes(expected))).toBe(true);
      return;
    }
    if (expected.index?.continuation !== null && expected.index?.continuation !== undefined) {
      expect(reserved!.index!.continuation).toMatchObject({ continuation_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        capability: expect.stringMatching(/^[0-9a-f]{64}$/u) });
      // Capabilities are freshly sealed for each sizing attempt and actual delivery;
      // their byte extents are fixed, while every other continuation binding is exact.
      expect({ ...reserved, index: { ...reserved!.index, continuation: { ...reserved!.index!.continuation,
        continuation_id: expected.index.continuation.continuation_id,
        capability: expected.index.continuation.capability } } }).toEqual(expected);
    } else expect(reserved).toEqual(expected);
    expect(bytes(reserved)).toBe(bytes(expected));
    expect(reserved!.work).toEqual(RESERVED_WORK);
  }
}
function assertProof(result: Recall, fixture: ExecutionLibrary) {
  expect(result.proofs).toHaveLength(1);
  expect(result.proofs![0]).toMatchObject({ source_record: fixture.proof.record,
    outcome: { status: "interpreted" }, world_claim: "unknown", semantic_status: "unreviewed",
    binding_results: fixture.proof.proof.binding_results });
  expect(result.slot_qualifiers.map(row => row.evidence_kind)).toContain("semantic_proof");
  const sourceResult = publicRecall(result).results!.find(row => row.target.kind === "source_evidence"
    && row.target.root_id === fixture.proof.record.identity);
  expect(sourceResult).toMatchObject({ content_preview: "Alice uses tools.", source_channels: ["conditional_field"] });
}
function sourceRun(fixture: ExecutionLibrary, request: RecallRequest, prepared = true) {
  return recall(runSourceSemanticWorker(fixture.runtime, { ...payload(request),
    ...(prepared ? { prepared_query: fixture.prepared } : {}) }));
}

/** Independently assemble one source's continuing page to choose a discriminating cap.
 * This is a byte oracle only; it is never supplied as a worker/solver result.
 */
function continuingSingletonOracle(full: Recall, rootId: string): Recall {
  const entry = full.index.entries.find(row => row.target.kind === "source_evidence" && row.target.root_id === rootId)!;
  if (entry.target.kind !== "source_evidence") throw new Error("source target expected");
  const position = full.index.entries.indexOf(entry), key = indexEntryCacheKey(entry), access = full.discovery.access!;
  const interpretations = access.interpretation_candidates.filter(row =>
    full.discovery.examined_source_interpretation_ids.includes(row.interpretation_id));
  const records = new Set([rootId, ...interpretations.map(row => row.record_id)]);
  const source_candidates = access.source_candidates.filter(row => records.has(row.record_id));
  const assembled = assembleSourceSemanticLibraryIndex({ query_id: full.index.query_id,
    snapshot_id: full.index.snapshot_id, interpretation_id: full.index.interpretation_id!, as_of: CLOCK,
    source_entries: [entry], selected_entries: [entry], root_order: [sourceGoldRootIdentity(entry.target)],
    proof_groups: [{ entries: [entry], explanations: full.index.explanations }], truncated: false,
    open_residuals: false, more_roots: true, emitted_offset: 0,
    expires_at: "2026-09-18T00:05:00.000Z", authorized_scopes: ["project"] });
  const index = { ...assembled.index, continuation: sealIssuedContinuation(assembled.index.continuation!) };
  return recall(SourceSemanticWorkerResultSchema.parse({ ...full, execution: NATIVE, index, total_count: 1,
    delivery_id: preparedDeliveryId(full.request_identity, index),
    slot_qualifiers: full.slot_qualifiers.filter(row => row.index === position).map(row => ({ ...row, index: 0 })),
    previews: { [key]: full.previews![key]! }, source_disclosures: { [key]: full.source_disclosures[key]! },
    discovery: { ...full.discovery, access: { ...access, source_candidates, interpretation_candidates: interpretations,
      trace: { kind: "library_selection", omitted_source_count: access.observed_source_count - source_candidates.length,
        omitted_interpretation_count: access.observed_interpretation_count - interpretations.length } } } }));
}

it("reserves the active initial page with actual parent preparation and acquisition, not the empty selection meter", async () => {
  const fixture = await executionLibrary();
  try {
    const roomy = sourceRun(fixture, fixture.request);
    assertProof(roomy, fixture);
    const expectedExecution = activeExecution(fixture, roomy);
    // Space for the conservative payload-state bound, not for another execution phase.
    const request = { ...fixture.request, output_byte_limit: bytes(expectedReservation(roomy, expectedExecution)) + 32 };
    const reservations = captureReservations(), result = sourceRun(fixture, request);
    assertProof(result, fixture);
    assertBounded(result, request, activeExecution(fixture, result), reservations);
    expect(sourceSemanticAccessPhases(result.discovery.access!).preparation).toEqual(fixture.prepared.receipt);
    expect(result.work.index_work).toBeGreaterThan(0);
    expect(result.work.native_accounting).toBe("partial");
    expect(fixture.embed).toHaveBeenCalledTimes(1);
    expect(result.work.logical_work).toBeGreaterThan(0);
  } finally { fixture.cleanup(); }
});

it("keeps frozen query-pool phase provenance while reserving and delivering only current native execution", async () => {
  const fixture = await executionLibrary();
  try {
    const prepared = runSourceSemanticWorker(fixture.runtime, { ...payload({ kind: "prepare_query",
      original_query: ORIGINAL, query_semantics: fixture.semantics, budget: BUDGET }), prepared_query: fixture.prepared });
    if (prepared.kind !== "prepare_query" || prepared.query_handle === undefined) throw new Error("query lease expected");
    const leased = { ...fixture.request, query_handle: prepared.query_handle };
    const roomy = sourceRun(fixture, leased, false);
    assertProof(roomy, fixture);
    const request = { ...leased, output_byte_limit: bytes(expectedReservation(roomy, NATIVE)) + 32 };
    const historical = sourceSemanticExecution(sourceSemanticAccessPhases(prepared.access!).preparation,
      sourceSemanticAccessPhases(prepared.access!).acquisition);
    // A proof that fits current execution would not fit if frozen activity were replayed.
    expect(bytes(expectedReservation(roomy, historical))).toBeGreaterThan(request.output_byte_limit);
    const reservations = captureReservations();
    const noObservation = vi.spyOn(Observation, "observeSourceSemanticAccess").mockImplementation(() => {
      throw new Error("query lease must reuse its frozen observation");
    });
    const result = sourceRun(fixture, request, false);
    assertProof(result, fixture);
    assertBounded(result, request, NATIVE, reservations);
    expect(result.discovery.access!.pool_id).toBe(prepared.access!.pool_id);
    expect(accessProvenance(result.discovery.access!)).toEqual(accessProvenance(prepared.access!));
    expect(sourceSemanticAccessPhases(result.discovery.access!).preparation.status).toBe("ready");
    expect(sourceSemanticAccessPhases(result.discovery.access!).acquisition.status).toBe("executed");
    expect(result.work.index_work).toBe(0);
    expect(result.work.native_accounting).toBe("complete");
    expect(noObservation).not.toHaveBeenCalled();
    expect(fixture.embed).toHaveBeenCalledTimes(1);
  } finally { fixture.cleanup(); }
});

async function openBuiltWorker(fixture: ExecutionLibrary) {
  assertBuiltWorker();
  const guard = `--import=${new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href}`;
  process.execArgv.push(guard);
  let client: ReturnType<typeof createRecallReadWorkerClient>;
  try { client = createRecallReadWorkerClient({ databaseFilename: fixture.filename, workerUrl: builtWorkerUrl,
    workerCount: 1, prepareSourceQuery: fixture.prepare })!; }
  finally { process.execArgv.splice(process.execArgv.lastIndexOf(guard), 1); }
  try { await client.ready(); return client; }
  catch (error) { await client.close(); throw error; }
}

async function continuationScenario(nativeWorker: boolean) {
  const fixture = await executionLibrary(true);
  let client: ReturnType<typeof createRecallReadWorkerClient> | undefined;
  try {
    const preparationRequest = { kind: "prepare_query" as const,
      original_query: ORIGINAL, query_semantics: fixture.semantics, budget: BUDGET };
    const preparation = runSourceSemanticWorker(fixture.runtime, { ...payload(preparationRequest), prepared_query: fixture.prepared });
    if (preparation.kind !== "prepare_query" || preparation.query_handle === undefined) throw new Error("query lease expected");
    const roomy = sourceRun(fixture, { ...fixture.request, query_handle: preparation.query_handle }, false);
    assertProof(roomy, fixture);
    expect(roomy.index.entries).toHaveLength(2);
    const oracle = continuingSingletonOracle(roomy, fixture.proof.record.identity);
    const request = { ...fixture.request, query_handle: preparation.query_handle,
      output_byte_limit: bytes(expectedReservation(oracle, NATIVE)) + 32 };
    const provenanceExecution = activeExecution(fixture, roomy);
    expect(bytes(expectedReservation(oracle, provenanceExecution))).toBeGreaterThan(request.output_byte_limit);
    const reservations = nativeWorker ? undefined : captureReservations();
    let execute: (request: RecallRequest) => Promise<Recall>;
    if (nativeWorker) {
      client = await openBuiltWorker(fixture);
      const prepared = await client.sourceSemanticsPort!.execute(payload(preparationRequest));
      if (prepared.kind !== "prepare_query" || prepared.query_handle === undefined) throw new Error("worker query lease expected");
      request.query_handle = prepared.query_handle;
      execute = async next => recall(await client!.sourceSemanticsPort!.execute(payload(next)));
    } else execute = async next => sourceRun(fixture, next, false);
    const first = await execute(request);
    assertBounded(first, request, NATIVE, reservations);
    // Frozen preparation/acquisition are provenance: replaying them would reject this proof.
    assertProof(first, fixture);
    expect(first.index.entries).toHaveLength(1);
    expect(bytes(expectedReservation(first, provenanceExecution))).toBeGreaterThan(request.output_byte_limit);
    expect(first.index.continuation).toMatchObject({ cursor: "offset-1" });
    const provenance = canonicalJson(accessProvenance(first.discovery.access!));
    const beforeEmbedding = fixture.embed.mock.calls.length;
    const noObservation = nativeWorker ? undefined : vi.spyOn(Observation, "observeSourceSemanticAccess").mockImplementation(() => {
      throw new Error("frozen continuation must not observe or recompute");
    });
    const continuedRequest = { ...request, continuation: first.index.continuation! };
    const next = await execute(continuedRequest), retry = await execute(continuedRequest);
    for (const page of [next, retry]) {
      assertBounded(page, request, NATIVE, reservations);
      expect(page.proofs ?? []).toEqual([]);
      expect(publicRecall(page).results!.map(row => row.content_preview)).toEqual([RAW_BODY]);
      expect(page.index.entries).toHaveLength(1);
      expect(page.index.continuation).toBeNull();
      expect(page.coverage.payload).toBe("complete");
      expect(page.discovery.truncated).toBe(false);
      expect(canonicalJson(accessProvenance(page.discovery.access!))).toBe(provenance);
      expect(page.work.index_work).toBe(0);
      expect(page.work.native_accounting).toBe("complete");
      expect(page.work.logical_work).toBeGreaterThan(0);
    }
    expect(next.index).toEqual(retry.index);
    expect(next.proofs).toEqual(retry.proofs);
    expect(next.delivery_id).toBe(retry.delivery_id);
    expect(fixture.embed).toHaveBeenCalledTimes(beforeEmbedding);
    expect(fixture.prepare).toHaveBeenCalledTimes(nativeWorker ? 2 : 1);
    if (noObservation !== undefined) expect(noObservation).not.toHaveBeenCalled();
  } finally { await client?.close(); fixture.cleanup(); }
}

it("reserves the proof-bearing frozen initial page and native-only continuation under the same cap without replaying pool phases", async () => {
  await continuationScenario(false);
});

it("delivers the real built-worker continuation and retry with native-only current execution under the original cap", async () => {
  await continuationScenario(true);
}, 60_000);

it("does not replay the active built-worker initial phases on its native-only continuation or retry", async () => {
  const fixture = await executionLibrary(true);
  let client: Awaited<ReturnType<typeof openBuiltWorker>> | undefined;
  try {
    // Without supplied query meaning, genuine sources remain available but no proof is invented.
    const rawRequest = { ...fixture.request, query_semantics: undefined, semantic_correspondences: [] };
    const roomy = sourceRun(fixture, rawRequest);
    expect(roomy.proofs ?? []).toEqual([]);
    const oracle = continuingSingletonOracle(roomy, fixture.proof.record.identity);
    const request = { ...rawRequest, output_byte_limit: bytes(expectedReservation(oracle, activeExecution(fixture, roomy))) + 32 };
    client = await openBuiltWorker(fixture);
    const execute = async (next: RecallRequest) => recall(await client!.sourceSemanticsPort!.execute(payload(next)));
    const first = await execute(request);
    const parentPreparation = await fixture.prepare.mock.results.at(-1)!.value;
    const expectedExecution = activeExecution(fixture, first, parentPreparation.receipt);
    assertBounded(first, request, expectedExecution);
    expect(first.execution).not.toBe(NATIVE);
    expect(first.proofs ?? []).toEqual([]);
    expect(publicRecall(first).results!.map(row => row.content_preview)).toEqual(["Alice uses tools."]);
    expect(first.index.continuation).toMatchObject({ cursor: "offset-1" });
    expect(first.work.index_work).toBeGreaterThan(0);
    expect(first.work.native_accounting).toBe("partial");
    expect(sourceSemanticAccessPhases(first.discovery.access!).preparation).toEqual(parentPreparation.receipt);
    const before = fixture.embed.mock.calls.length;
    const continued = { ...request, continuation: first.index.continuation! };
    const next = await execute(continued), retry = await execute(continued);
    for (const page of [next, retry]) {
      assertBounded(page, request, NATIVE);
      expect(page.index.continuation).toBeNull();
      expect(page.proofs ?? []).toEqual([]);
      expect(publicRecall(page).results!.map(row => row.content_preview)).toEqual([RAW_BODY]);
      expect(page.discovery.access!.pool_id).toBe(first.discovery.access!.pool_id);
      expect(sourceSemanticAccessPhases(page.discovery.access!).preparation).toEqual(parentPreparation.receipt);
      expect(sourceSemanticAccessPhases(page.discovery.access!).acquisition)
        .toEqual(sourceSemanticAccessPhases(first.discovery.access!).acquisition);
      expect(page.work.index_work).toBe(0);
      expect(page.work.native_accounting).toBe("complete");
      expect(page.work.logical_work).toBeGreaterThan(0);
    }
    expect(next.index).toEqual(retry.index);
    expect(next.delivery_id).toBe(retry.delivery_id);
    expect(fixture.embed).toHaveBeenCalledTimes(before);
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
  } finally { await client?.close(); fixture.cleanup(); }
}, 60_000);

function sourceRoot(result: Recall, proof: boolean, proofId: string): string {
  const entry = result.index.entries.find(row => row.target.kind === "source_evidence"
    && (row.target.root_id === proofId) === proof);
  if (entry === undefined || entry.target.kind !== "source_evidence") throw new Error("source root expected");
  return entry.target.root_id;
}

async function deferredFinalScenario(nativeWorker: boolean) {
  const fixture = await executionLibrary(true);
  let client: ReturnType<typeof createRecallReadWorkerClient> | undefined;
  try {
    const roomy = sourceRun(fixture, fixture.request);
    assertProof(roomy, fixture);
    expect(roomy.index.entries).toHaveLength(2);
    const proofId = fixture.proof.record.identity;
    const rawId = sourceRoot(roomy, false, proofId);
    const active = activeExecution(fixture, roomy);
    expect(active).not.toBe(NATIVE);
    const aActiveComplete = publicReservationBytes(assembledSourcePage(roomy, [proofId],
      { execution: active, moreRoots: false, emittedOffset: 0, proofs: true }), active);
    const aActiveContinuing = publicReservationBytes(assembledSourcePage(roomy, [proofId],
      { execution: active, moreRoots: true, emittedOffset: 0, proofs: true }), active);
    const bPrefix = publicReservationBytes(assembledSourcePage(roomy, [rawId],
      { execution: active, moreRoots: true, emittedOffset: 0, proofs: false }), active);
    const aNativeFinal = publicReservationBytes(assembledSourcePage(roomy, [proofId],
      { execution: NATIVE, moreRoots: false, emittedOffset: 1, proofs: true }), NATIVE);
    const cap = discriminatingByteCap([bPrefix, aNativeFinal], [aActiveComplete, aActiveContinuing]);
    const request = { ...fixture.request, output_byte_limit: cap };
    const reservations = nativeWorker ? undefined : captureReservations();
    let execute: (next: RecallRequest) => Promise<Recall>;
    if (nativeWorker) {
      client = await openBuiltWorker(fixture);
      execute = async next => recall(await client!.sourceSemanticsPort!.execute(payload(next)));
    } else {
      // The in-process fixture must not replay an initial preparation receipt on a continuation.
      execute = async next => sourceRun(fixture, next, next.continuation === undefined);
    }
    const first = await execute(request);
    expect(first.execution).not.toBe(NATIVE);
    assertBounded(first, request, nativeWorker ? SourceSemanticExecutionSchema.parse(first.execution)
      : activeExecution(fixture, first), reservations);
    expect(first.proofs ?? []).toEqual([]);
    expect(first.index.entries).toHaveLength(1);
    expect(first.slot_qualifiers.map(row => row.evidence_kind)).toEqual(["source_evidence"]);
    expect(publicRecall(first).results!.map(row => row.content_preview)).toEqual([RAW_BODY]);
    expect(first.index.entries[0]!.target).toMatchObject({ kind: "source_evidence", root_id: rawId });
    expect(first.index.continuation).toMatchObject({ cursor: "offset-1" });
    expect(first.work.index_work).toBeGreaterThan(0);
    expect(first.work.native_accounting).toBe("partial");
    const provenance = canonicalJson(accessProvenance(first.discovery.access!));
    const beforeEmbedding = fixture.embed.mock.calls.length;
    const noObservation = nativeWorker ? undefined : vi.spyOn(Observation, "observeSourceSemanticAccess").mockImplementation(() => {
      throw new Error("frozen continuation must not observe or recompute");
    });
    const continuedRequest = { ...request, continuation: first.index.continuation! };
    const next = await execute(continuedRequest), retry = await execute(continuedRequest);
    for (const page of [next, retry]) {
      assertBounded(page, request, NATIVE, reservations);
      assertProof(page, fixture);
      expect(page.index.entries).toHaveLength(1);
      expect(page.index.entries[0]!.target).toMatchObject({ kind: "source_evidence", root_id: proofId });
      expect(page.index.continuation).toBeNull();
      expect(canonicalJson(accessProvenance(page.discovery.access!))).toBe(provenance);
      expect(page.work.index_work).toBe(0);
      expect(page.work.native_accounting).toBe("complete");
      expect(page.work.logical_work).toBeGreaterThan(0);
    }
    expect(next.index).toEqual(retry.index);
    expect(next.proofs).toEqual(retry.proofs);
    expect(next.delivery_id).toBe(retry.delivery_id);
    expect(fixture.embed).toHaveBeenCalledTimes(beforeEmbedding);
    if (noObservation !== undefined) expect(noObservation).not.toHaveBeenCalled();
  } finally { await client?.close(); fixture.cleanup(); }
}

it("delivers a current-execution raw prefix then the native final A proof that cannot fit active offset 0", async () => {
  await deferredFinalScenario(false);
});

it("delivers the built-worker B prefix and native A proof under the independently priced active cap", async () => {
  await deferredFinalScenario(true);
}, 60_000);

it("keeps a fitting raw baseline when active proof only fits a native final without a prefix", async () => {
  const fixture = await executionLibrary();
  try {
    const roomy = sourceRun(fixture, fixture.request);
    assertProof(roomy, fixture);
    expect(roomy.index.entries).toHaveLength(1);
    const proofId = fixture.proof.record.identity;
    const active = activeExecution(fixture, roomy);
    const aActive = publicReservationBytes(assembledSourcePage(roomy, [proofId],
      { execution: active, moreRoots: false, emittedOffset: 0, proofs: true }), active);
    const aNativeFinal = publicReservationBytes(assembledSourcePage(roomy, [proofId],
      { execution: NATIVE, moreRoots: false, emittedOffset: 1, proofs: true }), NATIVE);
    const cap = discriminatingByteCap([aNativeFinal], [aActive]);
    const request = { ...fixture.request, output_byte_limit: cap };
    const reservations = captureReservations();
    const result = sourceRun(fixture, request);
    expect(result.execution).not.toBe(NATIVE);
    assertBounded(result, request, activeExecution(fixture, result), reservations);
    expect(result.proofs ?? []).toEqual([]);
    expect(result.slot_qualifiers.map(row => row.evidence_kind)).toEqual(["source_evidence"]);
    expect(result.index.entries).toHaveLength(1);
    expect(result.index.continuation).toBeNull();
    expect(result.index.entries[0]!.target).toMatchObject({ kind: "source_evidence", root_id: proofId });
    expect(publicRecall(result).results!.map(row => row.content_preview)).toEqual(["Alice uses tools."]);
    expect(sourceSemanticAccessPhases(result.discovery.access!).preparation).toEqual(fixture.prepared.receipt);
  } finally { fixture.cleanup(); }
});

it("does not treat equal reserved length as admission when membership, frame, or token admission differs", () => {
  const admitted: QuotedAdmission = { memberKeys: ["root-a"], more: false, payload: "complete",
    quote: { bytes: 4096, withinBudget: true } };
  expect(quoteMatches({ ...admitted, memberKeys: ["root-b"] }, admitted)).toBe(false);
  expect(quoteMatches({ ...admitted, more: true }, admitted)).toBe(false);
  expect(admissionHolds({ ...admitted, quote: { bytes: 4096, withinBudget: false } }, 4096)).toBe(false);
  expect(admissionHolds({ ...admitted, quote: { bytes: 4095, withinBudget: true } }, 4096)).toBe(false);
  expect(quoteMatches(admitted, admitted)).toBe(true);
  expect(admissionHolds(admitted, 4096)).toBe(true);
});
