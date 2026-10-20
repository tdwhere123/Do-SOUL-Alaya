import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { encodeSourceDisclosure, qualifySourceDisclosure, sourceDisclosure, canonicalJson, indexEntryCacheKey, sourceSemanticQueryIdentity, SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
  SourceSemanticExecutionSchema, SourceSemanticResourceExhausted, SourceSemanticWorkerRequestSchema,
  SourceSemanticWorkerResultSchema, sourceSemanticExecution, unavailableSourceQueryPreparation,
  type SourceSemanticCorrespondence, type SourceSemanticExecution, type SourceSemanticQuery, type SourceSemanticWorkerRequest,
  type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { assembleSourceSemanticLibraryIndex, createAuditedSourceAdmission, encodeSourceSemanticLibraryResponse,
  fieldContractSha256, preparedDeliveryId, sealIssuedContinuation, selectSourceSemanticLibraryPage, sourceGoldRootIdentity,
  sourceSemanticLibrarySourceEntry, sourceSemanticLibraryQueryIdentity, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
  type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { SourceSemanticReadBudget, sourceSemanticReadStores } from "../../../runtime/field/source-semantic-read-stores.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { prepareLibraryDelivery, deliverFrozenLibraryPage } from "../../../runtime/recall-read-worker/source-semantic-library-delivery.js";
import { runSourceSemanticLibraryRecall } from "../../../runtime/recall-read-worker/source-semantic-library-recall.js";
import { sourceSemanticAccessReceiptValue } from "../../../runtime/recall-read-worker/source-semantic-access-receipts.js";
import { SourceSemanticObserver } from "../../../runtime/recall-read-worker/source-semantic-observation.js";
import * as Observation from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import { createRecallRealStorage, REAL_SQLITE_TEST_WORKSPACE_ID as WS }
  from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { deliveredProofFixture, source, query, correspondenceFor, CLOCK, ORIGINAL }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";

import { FirstExposureSession } from "../../../../../bench-runner/src/runs/measurement/first-exposure-session.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../../../bench-runner/src/runs/measurement/source-semantic-library-recall.js";
import { accessQuery, withAccessLibrary } from "./source-semantic-access.test-support.js";

const BUDGET = { schema_version: 1 as const, work_units: 10_000_000, memory_bytes: 200_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
const meter = () => new SourceSemanticReadBudget(BUDGET);
const semantics: SourceSemanticQuery = { ...query(), requested_operation: { reading: "collect tools",
  support: { kind: "query_text", excerpt: "tools" } },
  alternatives: query().alternatives.map(row => ({ ...row, answer_frames: [], evidence_inputs: [{ frames: ["qUse"] }] })) };

function preparedPackages() {
  return ["first", "later"].map(id => {
    const interpretation = { ...source(), source: { ...source().source, source_id: id } };
    const fixture = deliveredProofFixture({ interpretation, semantics,
      correspondence: correspondenceFor(interpretation, semantics), library: true, workspaceId: WS });
    const proof: SourceSemanticLibraryPackage = { entry: fixture.entry, entries: fixture.index.entries,
      explanations: fixture.index.explanations ?? [], proofs: [fixture.proof], preview: "Alice uses X. Bob uses Y.",
      payload_support: "available", access_position: 0, source_disclosure: encodeSourceDisclosure({
        material_kind: "original_body", source_binding: "checked_record", evaluated_as_of: CLOCK,
        validity: { kind: "unknown", reason: "not_recorded" }, temporal_state: "unknown",
        proof_use: { kind: "conditional_support", qualification: "not_world_claim" }
      }) };
    const rawEntry = sourceSemanticLibrarySourceEntry({ workspaceId: WS, root_id: fixture.record.identity,
      source_version: fixture.record.source_version, content_digest: fixture.record.content_digest,
      evidence_object_id: null, hypothesis_id: "library" });
    const raw: SourceSemanticLibraryPackage = { ...proof, entry: rawEntry, entries: [rawEntry], proofs: [], explanations: [],
      payload_support: "envelope_budget", source_disclosure: qualifySourceDisclosure(proof.source_disclosure, "source_only") };
    return { fixture, proof, raw };
  }).sort((a, b) => sourceGoldRootIdentity(a.fixture.target).localeCompare(sourceGoldRootIdentity(b.fixture.target)));
}

type Recall = Extract<SourceSemanticWorkerResult, { kind: "recall" }>;
type Request = Extract<SourceSemanticWorkerRequest, { kind: "recall" }>;

function encodedBytes(result: Recall, request: Request,
  execution: SourceSemanticExecution = SourceSemanticExecutionSchema.parse(result.execution)): number {
  // Derive the boundary from the complete public work envelope, including index accounting.
  return Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse({ ...result, execution, work: {
    native_work: request.budget.work_units, index_work: request.budget.work_units,
    native_accounting: "partial", logical_work: request.budget.work_units,
    native_bytes: request.budget.memory_bytes, logical_memory_bytes: request.budget.memory_bytes,
    rss_bytes: Number.MAX_SAFE_INTEGER
  } })));
}

function publicPage(result: Recall) {
  const encoded = encodeSourceSemanticLibraryResponse(result);
  if (encoded.operation !== "recall" || encoded.delivery_id === undefined || encoded.index === undefined || encoded.results === undefined) {
    throw new Error("public library membership page expected");
  }
  return encoded;
}

function packageRoot(row: SourceSemanticLibraryPackage): string {
  if (row.entry.target.kind !== "source_evidence") throw new Error("source package expected");
  return sourceGoldRootIdentity(row.entry.target);
}

function continuingSingleton(result: Recall, row: SourceSemanticLibraryPackage): Recall {
  const assembled = assembleSourceSemanticLibraryIndex({ query_id: result.index.query_id, snapshot_id: result.index.snapshot_id,
    interpretation_id: result.index.interpretation_id!, as_of: CLOCK, expires_at: "2026-09-18T00:05:00.000Z",
    authorized_scopes: ["project"], source_entries: [row.entry], proof_groups: [row], selected_entries: [row.entry],
    root_order: [packageRoot(row)], truncated: result.discovery.truncated,
    open_residuals: result.discovery.open_residuals, more_roots: true, emitted_offset: 1 });
  const index = { ...assembled.index, result_version: result.index.result_version,
    continuation: sealIssuedContinuation(assembled.index.continuation!) };
  const continued = SourceSemanticWorkerResultSchema.parse({ ...result, index,
    delivery_id: preparedDeliveryId(result.request_identity, index) });
  if (continued.kind !== "recall") throw new Error("continuing singleton expected");
  return continued;
}

it("freezes a fitting proof on a later page without occupying its root with raw fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "library-proof-deferral-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  try {
    const admission = createAuditedSourceAdmission({
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
      eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined },
      sha256: fieldContractSha256
    });
    for (const id of ["first", "later"]) {
      await admission.admit({ workspace_id: WS, source_id: id, source_version: "1",
        content_bytes: "Alice uses X. Bob uses Y.", evidence_object_id: null, recorded_at: CLOCK,
        event_time: null, valid_from: null, valid_to: null, speaker: "user", scope_class: "project", spans: [] }, { workspaceId: WS });
    }
    const runtime = createRecallReadWorkerRuntime(database), packages = preparedPackages();
    for (const row of packages) {
      const stored = sourceSemanticReadStores(database, WS, row.fixture.record.source_id, meter(), ["project"])
        .getCurrentRecord(WS, row.fixture.record.source_id);
      expect(stored?.identity).toBe(row.fixture.record.identity);
      expect(stored?.content_digest).toBe(row.fixture.record.content_digest);
    }
    const candidates = packages.flatMap(row => [row.proof, row.raw]);
    const pool = { sources: packages.map(row => row.fixture.record), descriptors: [], sourcePages: 1, interpretationPages: 0,
      access: { ...sourceSemanticAccessReceiptValue(meter(), "query-conditioned-v1", `sha256:${"ab".repeat(32)}`,
        packages.map(row => ({ source_id: row.fixture.record.source_id, record_id: row.fixture.record.identity,
          read_bytes: 25, body_bytes: 25, complete: true,
          signal: { source_text_score: 0, interpretation_reading_score: 0 } })), [], false, false, []),
        pool_id: `sha256:${"cd".repeat(32)}` } };
    const request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }> = {
      kind: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL, query_semantics: semantics,
      budget: BUDGET, output_byte_limit: 1_000_000
    };
    const base: Parameters<typeof prepareLibraryDelivery>[0] = { query_id: sourceSemanticLibraryQueryIdentity(ORIGINAL),
      snapshot_id: `sha256:${"ef".repeat(32)}`, interpretation_id: "library", as_of: CLOCK,
      expires_at: "2026-09-18T00:05:00.000Z", authorized: ["project"], pool,
      request_identity: fieldContractSha256(canonicalJson({ ...request, continuation: undefined })),
      public_request_identity: `sha256:${"ff".repeat(32)}`,
      query_semantics_status: { status: "admitted", query_semantics_id: sourceSemanticQueryIdentity(semantics, fieldContractSha256) },
      unproved_computations: [], coverage: { discovery: "complete", source_interpretation: "open", query_semantics: "complete",
        semantic_correspondence: "open", conditional_computation: "complete", payload: "complete" },
      discovery: { eligible_source_count: 2, visited_source_pages: 1, visited_source_interpretation_pages: 0,
        visited_source_interpretation_descriptors: 0, candidate_prefix: [], examined_source_interpretation_ids: [],
        unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0, examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
        open_residuals: false, truncated: false } };
    const payload = { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named" as const, scopes: ["project"] }, request };
    const roomy = prepareLibraryDelivery(base, candidates, request, meter());
    expect(roomy.pages.map(page => page.length)).toEqual([2]);
    const full = deliverFrozenLibraryPage(runtime, payload, meter(), request, roomy, 0);
    const outputLimit = Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse(full))) - 1000;
    const bounded = { ...request, output_byte_limit: outputLimit };
    const boundedBase = { ...base, request_identity: fieldContractSha256(canonicalJson({ ...bounded, continuation: undefined })) };
    const plan = prepareLibraryDelivery(boundedBase, candidates, bounded, meter());
    expect(plan.pages.map(page => page.length)).toEqual([1, 1]);
    expect(plan.pages.every(page => page[0]!.proofs.length === 1)).toBe(true);
    const frozen = canonicalJson(plan);
    const first = deliverFrozenLibraryPage(runtime, { ...payload, request: bounded }, meter(), bounded, plan, 0);
    expect(first.slot_qualifiers.map(row => row.evidence_kind)).toEqual(["semantic_proof"]);
    expect(first.index.continuation).not.toBeNull();
    const continuation = first.index.continuation!;
    const session = new FirstExposureSession();
    const initialDelivery = encodeSourceSemanticLibraryResponse(first);
    if (initialDelivery.operation !== "recall" || initialDelivery.delivery_id === undefined
      || initialDelivery.index === undefined || initialDelivery.results === undefined) {
      throw new Error("initial library delivery expected");
    }
    const initialExposure = recordSourceSemanticLibraryFirstExposure(initialDelivery, session);
    expect(initialExposure.initial?.slots).toHaveLength(1);
    const noObservation = vi.spyOn(Observation, "observeSourceSemanticAccess").mockImplementation(() => {
      throw new Error("frozen continuation must not observe sources or recompute membership");
    });
    try {
      const continuedPayload = { ...payload, request: { ...bounded, continuation } };
      const next = runSourceSemanticLibraryRecall(runtime, continuedPayload, ["project"], meter());
      const retry = runSourceSemanticLibraryRecall(runtime, continuedPayload, ["project"], meter());
      if (next.kind !== "recall" || retry.kind !== "recall") throw new Error("library page expected");
      expect(next.index.continuation).toBeNull();
      const continuedDelivery = encodeSourceSemanticLibraryResponse(next);
      if (continuedDelivery.operation !== "recall" || continuedDelivery.delivery_id === undefined
        || continuedDelivery.index === undefined || continuedDelivery.results === undefined) {
        throw new Error("continued library delivery expected");
      }
      const continuedExposure = recordSourceSemanticLibraryFirstExposure(continuedDelivery, session, continuation);
      expect(continuedExposure.initial).toEqual(initialExposure.initial);
      expect(continuedExposure.initial?.slots).toHaveLength(1);
      expect(continuedExposure.initial?.delivery_id).toBe(first.delivery_id);
      expect(next.index).toEqual(retry.index);
      expect(next.delivery_id).toBe(retry.delivery_id);
      expect(next.proofs).toEqual(plan.pages[1]![0]!.proofs);
      expect(next.slot_qualifiers.map(row => row.evidence_kind)).toEqual(["semantic_proof"]);
      expect(next.previews?.[indexEntryCacheKey(next.index.entries[0]!)]).toBe(plan.pages[1]![0]!.preview);
      const roots = [...first.index.entries, ...next.index.entries].map(row => {
        if (row.target.kind !== "source_evidence") throw new Error("source root expected");
        return sourceGoldRootIdentity(row.target);
      });
      expect(new Set(roots).size).toBe(2);
      for (const page of [first, next]) {
        const encoded = encodeSourceSemanticLibraryResponse(page);
        if (encoded.operation !== "recall" || encoded.delivery_id === undefined
          || encoded.index === undefined || encoded.results === undefined) {
          throw new Error("bounded library delivery expected");
        }
        expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThanOrEqual(outputLimit);
        expect(encoded.results.every(row => row.budget_state.within_budget)).toBe(true);
      }
      expect(canonicalJson(plan)).toBe(frozen);
      expect(noObservation).not.toHaveBeenCalled();
    } finally { noObservation.mockRestore(); }

    // A sorts first and its proof fits only the continuation-free envelope.
    // B can go first, so consuming A's raw twin is not a lawful fallback.
    const [a, b] = packages;
    if (a === undefined || b === undefined) throw new Error("two roots expected");
    const singletonResults = packages.map(row => deliverFrozenLibraryPage(runtime, payload, meter(), request,
      prepareLibraryDelivery(base, [row.proof], request, meter()), 0));
    const finalLimit = Math.max(...singletonResults.map(result => encodedBytes(result, request))) + 10;
    packages.forEach((row, index) => {
      expect(encodedBytes(continuingSingleton(singletonResults[index]!, row.proof), request)).toBeGreaterThan(finalLimit);
    });
    const finalRequest = { ...request, output_byte_limit: finalLimit };
    const finalBase = { ...base, request_identity: fieldContractSha256(canonicalJson({ ...finalRequest, continuation: undefined })) };
    const rawFirstPlan = prepareLibraryDelivery(finalBase, [a.raw, b.raw], finalRequest, meter());
    const rawFirst = deliverFrozenLibraryPage(runtime, { ...payload, request: finalRequest }, meter(), finalRequest, rawFirstPlan, 0);
    expect(rawFirst.index.entries).toHaveLength(2);
    expect(encodedBytes(rawFirst, finalRequest)).toBeLessThanOrEqual(finalLimit);
    const finalPlan = prepareLibraryDelivery(finalBase, [a.proof, a.raw, b.raw], finalRequest, meter());
    expect(finalPlan.pages.map(page => page.map(row => row.proofs.length))).toEqual([[0], [1]]);
    expect(finalPlan.pages[0]![0]!.entry).toEqual(b.raw.entry);
    expect(finalPlan.pages[1]![0]!.proofs).toEqual(a.proof.proofs);
    const finalFrozen = canonicalJson(finalPlan);
    const bFirst = deliverFrozenLibraryPage(runtime, { ...payload, request: finalRequest }, meter(), finalRequest, finalPlan, 0);
    const firstExposure = new FirstExposureSession();
    const initial = recordSourceSemanticLibraryFirstExposure(publicPage(bFirst), firstExposure);
    expect(initial.initial?.slots.map(row => row.object_kind)).toEqual(["source_evidence"]);
    const continued = { ...payload, request: { ...finalRequest, continuation: bFirst.index.continuation! } };
    const aLast = runSourceSemanticLibraryRecall(runtime, continued, ["project"], meter());
    const aRetry = runSourceSemanticLibraryRecall(runtime, continued, ["project"], meter());
    if (aLast.kind !== "recall" || aRetry.kind !== "recall") throw new Error("final proof page expected");
    expect(aLast.index.continuation).toBeNull();
    expect(aLast.proofs).toEqual(a.proof.proofs);
    expect(aRetry.index).toEqual(aLast.index);
    const laterExposure = recordSourceSemanticLibraryFirstExposure(publicPage(aLast), firstExposure,
      bFirst.index.continuation!);
    expect(laterExposure.initial).toEqual(initial.initial);
    for (const result of [bFirst, aLast, aRetry]) expect(encodedBytes(result, finalRequest)).toBeLessThanOrEqual(finalLimit);
    expect(canonicalJson(finalPlan)).toBe(finalFrozen);

    // Both proofs need the only final page but cannot share it: one root uses a
    // valid earlier raw page, not a repeated root or a second invented last page.
    const conflicting = prepareLibraryDelivery(finalBase, candidates, finalRequest, meter());
    expect(conflicting.pages.map(page => page.map(row => row.proofs.length))).toEqual([[0], [1]]);
    expect(new Set(conflicting.pages.flat().map(packageRoot)).size).toBe(2);
    const impossibleAll = prepareLibraryDelivery(finalBase, [a.proof, b.proof], finalRequest, meter());
    expect(impossibleAll.pages).toHaveLength(1);
    expect(impossibleAll.pages[0]).toHaveLength(1);
    expect(impossibleAll.coverage.payload).toBe("truncated");
    expect(impossibleAll.discovery.open_residuals).toBe(true);
    const partialPage = deliverFrozenLibraryPage(runtime, { ...payload, request: finalRequest }, meter(), finalRequest, impossibleAll, 0);
    expect(encodedBytes(partialPage, finalRequest)).toBeLessThanOrEqual(finalLimit);

    // With discovery already open, marking an impossible remainder cannot save
    // bytes elsewhere. The final reservation must also pay for truncated payload.
    const completePackages = packages.map(({ proof }) => {
      if (proof.entry.target.kind !== "source_evidence") throw new Error("source proof expected");
      return { ...proof, entry: { ...proof.entry, target: { ...proof.entry.target,
        span: { content_start: 0, content_end: Buffer.byteLength(proof.preview), retained_extent: "body" as const,
          content_complete: true, original_complete: false } } } };
    });
    const openBase = { ...base, discovery: { ...base.discovery, truncated: true, open_residuals: true } };
    const openSingleton = deliverFrozenLibraryPage(runtime, payload, meter(), request,
      prepareLibraryDelivery(openBase, [completePackages[0]!], request, meter()), 0);
    expect(openSingleton.coverage.payload).toBe("complete");
    const partialLimit = encodedBytes({ ...openSingleton, coverage: { ...openSingleton.coverage, payload: "truncated" } }, request);
    const partialRequest = { ...request, output_byte_limit: partialLimit };
    const partialPlan = prepareLibraryDelivery(openBase, completePackages, partialRequest, meter());
    expect(partialPlan.pages.flat()).toHaveLength(1);
    const partial = deliverFrozenLibraryPage(runtime, { ...payload, request: partialRequest }, meter(), partialRequest, partialPlan, 0);
    expect(encodedBytes(partial, partialRequest)).toBeLessThanOrEqual(partialLimit);
    const noFinalEnvelope = prepareLibraryDelivery(openBase, completePackages,
      { ...partialRequest, output_byte_limit: partialLimit - 1 }, meter());
    expect(noFinalEnvelope.pages).toEqual([[]]);

    // A non-fitting variant cannot veto the same root's complete fitting proof.
    const variants = prepareLibraryDelivery(finalBase, [{ ...a.proof, preview: "x".repeat(60_000) }, a.proof, a.raw, b.raw],
      finalRequest, meter());
    expect(variants.pages[1]![0]!.proofs).toEqual(a.proof.proofs);
    expect(variants.pages[1]![0]!.preview).toBe(a.proof.preview);
    const exhausted = new SourceSemanticReadBudget({ work_units: 100, memory_bytes: 200_000_000 });
    expect(() => prepareLibraryDelivery(finalBase, candidates, finalRequest, exhausted)).toThrow(/budget exhausted/u);
    expect(exhausted.spentWork).toBeLessThanOrEqual(100);

    // Spend the real child allowance after an unsuccessful candidate trace.
    // Empty completion must use only the parent's post-absorption remainder.
    const observer = new SourceSemanticObserver(1, { max_events: 512, max_bytes: 262144 });
    const parent = new SourceSemanticReadBudget(BUDGET, observer);
    const selection = parent.child({ work_units: 100_000, memory_bytes: BUDGET.memory_bytes }, "selection");
    const exhaustSelection: typeof selectSourceSemanticLibraryPage = input => {
      expect(input.fits([input.candidates[0]!])).toBe(false);
      selection.charge(selection.work, 0, "remaining selection work");
      return [];
    };
    const fallbackPlan = prepareLibraryDelivery(finalBase, candidates, finalRequest, parent, "field",
      exhaustSelection, sourceSemanticExecution(), selection);
    expect(selection.spentWork).toBe(100_000);
    const accounting = observer.finish("success");
    const debit = (phase: string, reason: string) => accounting.costs.find(row =>
      row.phase === phase && row.reason === reason && row.operation === "debit");
    expect(debit("selection", "access trace selection")).toMatchObject({ count: 1, work: 2 });
    expect(debit("selection", "access trace delivery")?.work).toBeGreaterThan(0);
    expect(debit("request", "access trace selection")).toMatchObject({ count: 1, work: 2 });
    expect(debit("request", "access trace delivery")?.work).toBeGreaterThan(0);
    expect(accounting.costs.find(row => row.operation === "absorb")).toMatchObject({ reason: "selection", count: 1,
      work: selection.spentWork, bytes: selection.spentBytes });
    expect(accounting.totals?.debit_work).toBe(parent.spentWork);
    expect(accounting.totals?.debit_bytes).toBe(parent.spentBytes);
    expect(parent.spentWork).toBe(selection.spentWork + debit("request", "access trace selection")!.work
      + debit("request", "access trace delivery")!.work);
    expect(fallbackPlan.pages).toEqual([[]]);
    expect(fallbackPlan.page_access).toHaveLength(1);
    expect(fallbackPlan.page_access[0]!.trace).toMatchObject({ kind: "library_selection" });
    expect(fallbackPlan.page_access[0]!.source_candidates).toEqual([]);
    expect(fallbackPlan.page_access[0]!.interpretation_candidates).toEqual([]);
    expect(fallbackPlan.coverage.payload).toBe("truncated");
    expect(fallbackPlan.discovery).toMatchObject({ truncated: true, open_residuals: true });
    const fallbackDelivery = deliverFrozenLibraryPage(runtime, { ...payload, request: finalRequest },
      parent, finalRequest, fallbackPlan, 0);
    expect(fallbackDelivery.index.entries).toEqual([]);
    expect(fallbackDelivery.discovery.access).toEqual(fallbackPlan.page_access[0]);
    expect(fallbackDelivery.coverage.payload).toBe("truncated");
    expect(fallbackDelivery.work.logical_work).toBe(parent.spentWork);

    const insufficient = new SourceSemanticReadBudget({ work_units: 100_000, memory_bytes: BUDGET.memory_bytes });
    const unfundedSelection = insufficient.child(insufficient.remaining(), "selection");
    expect(() => prepareLibraryDelivery(finalBase, candidates, finalRequest, insufficient, "field", input => {
      expect(input.fits([input.candidates[0]!])).toBe(false);
      unfundedSelection.charge(unfundedSelection.work, 0, "remaining selection work");
      return [];
    }, sourceSemanticExecution(), unfundedSelection)).toThrow(/budget exhausted/u);
    expect(insufficient.spentWork).toBe(unfundedSelection.spentWork);
    expect(insufficient.work).toBe(0);

    const rawPlan = prepareLibraryDelivery(base, packages.map(row => row.raw), request, meter());
    const rawPage = deliverFrozenLibraryPage(runtime, payload, meter(), request, rawPlan, 0);
    const rawLimit = Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse(rawPage))) + 1000;
    const rawRequest = { ...request, output_byte_limit: rawLimit };
    const fallback = prepareLibraryDelivery(base, candidates, rawRequest, meter());
    expect(fallback.pages.flat().every(row => row.proofs.length === 0)).toBe(true);
    expect(fallback.pages.flat()).toHaveLength(2);
    for (const row of packages) {
      const impossible = prepareLibraryDelivery(base, [row.proof], rawRequest, meter());
      expect(impossible.pages).toEqual([[]]);
      expect(impossible.coverage.payload).toBe("truncated");
    }
  } finally { database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true }); }
});

it("delivers B first and A's final-envelope-only proof over loopback through reopened SQLite worker", async () => {
  const nativeQuery = accessQuery(ORIGINAL, "use");
  await withAccessLibrary([{ id: "a-proof", text: "Alice uses tools.", reading: "use" },
    { id: "b-raw", text: "Bob stays silent." }], async ({ execute, filename, ids }) => {
    const correspondence: SourceSemanticCorrespondence = {
      contract: "source-semantic-correspondence-v3", source_interpretation_id: ids.get("a-proof")![0]!,
      query_semantics_id: sourceSemanticQueryIdentity(nativeQuery, fieldContractSha256),
      producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1",
      contract_version: "source-semantic-correspondence-v3", correspondences: [{ relation: "contextual_equivalence",
        query_endpoint: { kind: "predicate", alternative: 0, frame: "qStatement" },
        source_endpoint: { kind: "frame", frame: "fStatement" },
        query_support: { kind: "query_text", excerpt: "use" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mStatement"] }] }]
    };
    // This loopback transport invokes the actual worker port, not an in-process
    // substitute. The worker reopens the isolated, already-published SQLite file.
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const request = SourceSemanticWorkerRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const result = await execute({ workspace_id: WS, as_of: CLOCK,
          authorized_scopes: { mode: "named", scopes: ["project"] }, request });
        outgoing.setHeader("content-type", "application/json"); outgoing.end(JSON.stringify(result));
      } catch (error) { outgoing.statusCode = 500; outgoing.end(String(error)); }
    });
    await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("loopback port expected");
      const call = async (request: Request): Promise<Recall> => {
        const response = await fetch(`http://127.0.0.1:${address.port}/recall`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
        });
        const body = await response.text();
        expect(response.status, body).toBe(200);
        const result = SourceSemanticWorkerResultSchema.parse(JSON.parse(body));
        if (result.kind !== "recall") throw new Error("worker library page expected");
        return result;
      };
      const roomyRequest: Request = { kind: "recall", accepts_unreviewed_conditional_results: true,
        original_query: ORIGINAL, query_semantics: nativeQuery, semantic_correspondences: [correspondence],
        budget: BUDGET, output_byte_limit: 1_000_000 };
      const roomy = await call(roomyRequest);
      expect(roomy.slot_qualifiers.map(row => row.evidence_kind)).toEqual(["semantic_proof", "source_evidence"]);
      const aEntry = roomy.index.entries[0]!, aProof = roomy.proofs?.[0];
      const access = roomy.discovery.access, disclosed = roomy.source_disclosures[indexEntryCacheKey(aEntry)];
      if (aEntry.target.kind !== "source_evidence" || aProof === undefined || access === undefined || disclosed === undefined) {
        throw new Error("native A proof and source disclosure expected");
      }
      const source_disclosure = qualifySourceDisclosure(disclosed, sourceDisclosure(disclosed).proof_use.kind, false);
      const aPackage: SourceSemanticLibraryPackage = { entry: aEntry, entries: [aEntry],
        explanations: roomy.index.explanations ?? [], proofs: [aProof],
        preview: roomy.previews![indexEntryCacheKey(aEntry)]!, source_disclosure,
        access_position: 0, payload_support: "available" };
      const { database } = await createRecallRealStorage(() => undefined, filename);
      let singleton: Recall;
      try {
        const records = ["a-proof", "b-raw"].map(id => sourceSemanticReadStores(database, WS, id, meter(), ["project"])
          .getCurrentRecord(WS, id));
        if (records.some(row => row === null)) throw new Error("native SQLite source records expected");
        const base: Parameters<typeof prepareLibraryDelivery>[0] = {
          query_id: roomy.index.query_id, snapshot_id: roomy.index.snapshot_id,
          interpretation_id: roomy.index.interpretation_id!, as_of: CLOCK, expires_at: "2026-09-18T00:05:00.000Z",
          authorized: ["project"], request_identity: fieldContractSha256(canonicalJson(roomyRequest)),
          public_request_identity: roomy.request_identity, query_semantics_status: roomy.query_semantics_status,
          pool: { sources: records.filter(row => row !== null), descriptors: [], sourcePages: 1, interpretationPages: 1, access },
          discovery: roomy.discovery, coverage: roomy.coverage, unproved_computations: roomy.unproved_computations ?? []
        };
        const plan = prepareLibraryDelivery(base, [aPackage], roomyRequest, meter());
        singleton = deliverFrozenLibraryPage(createRecallReadWorkerRuntime(database), {
          workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request: roomyRequest
        }, meter(), roomyRequest, plan, 0);
      } finally { database.close(); closeCachedDatabase(filename); }
      const limit = encodedBytes(singleton, roomyRequest) + 10;
      expect(encodedBytes(continuingSingleton(singleton, aPackage), roomyRequest)).toBeGreaterThan(limit);
      const request = { ...roomyRequest, output_byte_limit: limit };
      const first = await call(request);
      expect(first.slot_qualifiers.map(row => row.evidence_kind)).toEqual(["source_evidence"]);
      const bEntry = first.index.entries[0]!;
      if (bEntry.target.kind !== "source_evidence") throw new Error("native B source expected");
      expect(bEntry.target.root_id).not.toBe(aEntry.target.root_id);
      const continuation = first.index.continuation;
      if (continuation === null) throw new Error("frozen final proof continuation expected");
      const session = new FirstExposureSession();
      const initial = recordSourceSemanticLibraryFirstExposure(publicPage(first), session);
      expect(initial.initial?.slots.map(row => row.object_kind)).toEqual(["source_evidence"]);
      const last = await call({ ...request, continuation }), retry = await call({ ...request, continuation });
      expect(last.index.continuation).toBeNull();
      expect(last.index.entries).toHaveLength(1);
      expect(last.index.entries[0]!.target).toEqual(aEntry.target);
      expect(last.slot_qualifiers.map(row => row.evidence_kind)).toEqual(["semantic_proof"]);
      expect(last.proofs?.[0]?.source_interpretation_id).toBe(correspondence.source_interpretation_id);
      expect(last.proofs?.[0]?.binding_results?.length).toBeGreaterThan(0);
      expect(last.proofs?.[0]?.interpretation).toEqual(aProof.interpretation);
      expect(last.previews?.[indexEntryCacheKey(last.index.entries[0]!)]).toBe(aPackage.preview);
      expect(last.work.native_work).toBe(0);
      expect(last.work.native_bytes).toBe(0);
      expect(retry.index).toEqual(last.index);
      expect(retry.proofs).toEqual(last.proofs);
      expect(retry.delivery_id).toBe(last.delivery_id);
      const later = recordSourceSemanticLibraryFirstExposure(publicPage(last), session, continuation);
      expect(later.initial).toEqual(initial.initial);
      expect(later.initial?.delivery_id).toBe(first.delivery_id);
      expect(new Set([bEntry.target.root_id, aEntry.target.root_id]).size).toBe(2);
      for (const page of [first, last, retry]) {
        const encoded = encodeSourceSemanticLibraryResponse(page);
        if (encoded.operation !== "recall" || encoded.results === undefined) throw new Error("shared public encoding expected");
        expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThanOrEqual(limit);
        expect(encoded.results.every(row => row.budget_state.within_budget)).toBe(true);
        expect(page.work.logical_work).toBeLessThanOrEqual(BUDGET.work_units);
        expect(page.work.logical_memory_bytes).toBeLessThanOrEqual(BUDGET.memory_bytes);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    }
  });
}, 60_000);

async function withDeferralLibrary(run: (ctx: {
  runtime: ReturnType<typeof createRecallReadWorkerRuntime>;
  packages: ReturnType<typeof preparedPackages>;
  request: Request;
  base: Parameters<typeof prepareLibraryDelivery>[0];
  payload: { workspace_id: string; as_of: string; authorized_scopes: { mode: "named"; scopes: ["project"] }; request: Request };
}) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), "library-proof-deferral-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  try {
    const admission = createAuditedSourceAdmission({
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
      eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined },
      sha256: fieldContractSha256
    });
    for (const id of ["first", "later"]) {
      await admission.admit({ workspace_id: WS, source_id: id, source_version: "1",
        content_bytes: "Alice uses X. Bob uses Y.", evidence_object_id: null, recorded_at: CLOCK,
        event_time: null, valid_from: null, valid_to: null, speaker: "user", scope_class: "project", spans: [] }, { workspaceId: WS });
    }
    const runtime = createRecallReadWorkerRuntime(database), packages = preparedPackages();
    const request: Request = { kind: "recall", accepts_unreviewed_conditional_results: true,
      original_query: ORIGINAL, query_semantics: semantics, budget: BUDGET, output_byte_limit: 1_000_000 };
    const base: Parameters<typeof prepareLibraryDelivery>[0] = { query_id: sourceSemanticLibraryQueryIdentity(ORIGINAL),
      snapshot_id: `sha256:${"ef".repeat(32)}`, interpretation_id: "library", as_of: CLOCK,
      expires_at: "2026-09-18T00:05:00.000Z", authorized: ["project"],
      pool: { sources: packages.map(row => row.fixture.record), descriptors: [], sourcePages: 1, interpretationPages: 0,
        access: { ...sourceSemanticAccessReceiptValue(meter(), "query-conditioned-v1", `sha256:${"ab".repeat(32)}`,
          packages.map(row => ({ source_id: row.fixture.record.source_id, record_id: row.fixture.record.identity,
            read_bytes: 25, body_bytes: 25, complete: true,
            signal: { source_text_score: 0, interpretation_reading_score: 0 } })), [], false, false, []),
          pool_id: `sha256:${"cd".repeat(32)}` } },
      request_identity: fieldContractSha256(canonicalJson({ ...request, continuation: undefined })),
      public_request_identity: `sha256:${"ff".repeat(32)}`,
      query_semantics_status: { status: "admitted", query_semantics_id: sourceSemanticQueryIdentity(semantics, fieldContractSha256) },
      unproved_computations: [], coverage: { discovery: "complete", source_interpretation: "open", query_semantics: "complete",
        semantic_correspondence: "open", conditional_computation: "complete", payload: "complete" },
      discovery: { eligible_source_count: 2, visited_source_pages: 1, visited_source_interpretation_pages: 0,
        visited_source_interpretation_descriptors: 0, candidate_prefix: [], examined_source_interpretation_ids: [],
        unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0, examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
        open_residuals: false, truncated: false } };
    await run({ runtime, packages, request, base, payload: { workspace_id: WS, as_of: CLOCK,
      authorized_scopes: { mode: "named", scopes: ["project"] }, request } });
  } finally { database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true }); }
}

const NATIVE = sourceSemanticExecution();
const ADMITTED = sourceSemanticExecution(unavailableSourceQueryPreparation("attestation_missing", "not_requested"));

function extraRaw(id: string, preview: string, template: SourceSemanticLibraryPackage): SourceSemanticLibraryPackage {
  const entry = sourceSemanticLibrarySourceEntry({ workspaceId: WS, root_id: id, source_version: "1",
    content_digest: `sha256:${fieldContractSha256(preview)}`, evidence_object_id: null, hypothesis_id: "library" });
  return { ...template, entry, entries: [entry], proofs: [], explanations: [], preview, payload_support: "envelope_budget",
    source_disclosure: qualifySourceDisclosure(template.source_disclosure, "source_only") };
}

function discriminatingByteCap(fits: readonly number[], exceeds: readonly number[]): number {
  const cap = Math.max(...fits);
  if (!Number.isSafeInteger(cap) || exceeds.some(bytes => bytes <= cap)) {
    throw new Error(`no independent discriminating cap: fits ${fits.join(",")} exceeds ${exceeds.join(",")}`);
  }
  return cap;
}

function prepareActive(base: Parameters<typeof prepareLibraryDelivery>[0],
  candidates: readonly SourceSemanticLibraryPackage[], request: Request, readMeter = meter()) {
  expect(ADMITTED).not.toBe(NATIVE);
  return prepareLibraryDelivery(base, candidates, request, readMeter, "field", selectSourceSemanticLibraryPage, ADMITTED);
}

function reservedSingleton(result: Recall, row: SourceSemanticLibraryPackage,
  execution: SourceSemanticExecution, moreRoots: boolean, emittedOffset: number): Recall {
  const assembled = assembleSourceSemanticLibraryIndex({
    query_id: result.index.query_id, snapshot_id: result.index.snapshot_id,
    interpretation_id: result.index.interpretation_id!, as_of: CLOCK, expires_at: "2026-09-18T00:05:00.000Z",
    authorized_scopes: ["project"], source_entries: [row.entry],
    proof_groups: row.proofs.length > 0 ? [row] : [], selected_entries: [row.entry], root_order: [packageRoot(row)],
    truncated: result.discovery.truncated, open_residuals: result.discovery.open_residuals,
    more_roots: moreRoots, emitted_offset: emittedOffset });
  const index = { ...assembled.index, result_version: result.index.result_version,
    continuation: assembled.index.continuation === null ? null : sealIssuedContinuation(assembled.index.continuation) };
  const continued = SourceSemanticWorkerResultSchema.parse({
    ...result, execution, index, delivery_id: preparedDeliveryId(result.request_identity, index) });
  if (continued.kind !== "recall") throw new Error("reserved singleton expected");
  return continued;
}

function finalEnvelope(ctx: Parameters<Parameters<typeof withDeferralLibrary>[0]>[0]) {
  const proofPages = ctx.packages.map(row => deliverFrozenLibraryPage(ctx.runtime, ctx.payload, meter(), ctx.request,
    prepareLibraryDelivery(ctx.base, [row.proof], ctx.request, meter()), 0));
  const rawPages = ctx.packages.map(row => deliverFrozenLibraryPage(ctx.runtime, ctx.payload, meter(), ctx.request,
    prepareLibraryDelivery(ctx.base, [row.raw], ctx.request, meter()), 0));
  const activeRawContinuing = ctx.packages.map((row, index) =>
    encodedBytes(reservedSingleton(rawPages[index]!, row.raw, ADMITTED, true, 0), ctx.request));
  const nativeProofFinal = ctx.packages.map((row, index) =>
    encodedBytes(reservedSingleton(proofPages[index]!, row.proof, NATIVE, false, 1), ctx.request));
  const activeProofComplete = proofPages.map(page => encodedBytes(page, ctx.request, ADMITTED));
  const activeProofContinuing = ctx.packages.map((row, index) =>
    encodedBytes(reservedSingleton(proofPages[index]!, row.proof, ADMITTED, true, 0), ctx.request));
  const finalLimit = discriminatingByteCap([...activeRawContinuing, ...nativeProofFinal],
    [...activeProofComplete, ...activeProofContinuing]);
  const request = { ...ctx.request, output_byte_limit: finalLimit };
  return { request, base: { ...ctx.base, request_identity: fieldContractSha256(canonicalJson({ ...request, continuation: undefined })) },
    finalLimit };
}

it("keeps a fitting raw baseline when no current-execution prefix can hold a deferred final", async () => {
  await withDeferralLibrary(ctx => {
    const [a] = ctx.packages;
    if (a === undefined) throw new Error("proof package expected");
    const rawPage = deliverFrozenLibraryPage(ctx.runtime, ctx.payload, meter(), ctx.request,
      prepareLibraryDelivery(ctx.base, [a.raw], ctx.request, meter()), 0);
    const proofPage = deliverFrozenLibraryPage(ctx.runtime, ctx.payload, meter(), ctx.request,
      prepareLibraryDelivery(ctx.base, [a.proof], ctx.request, meter()), 0);
    const cap = discriminatingByteCap(
      [encodedBytes(rawPage, ctx.request, ADMITTED),
        encodedBytes(reservedSingleton(proofPage, a.proof, NATIVE, false, 1), ctx.request)],
      [encodedBytes(proofPage, ctx.request, ADMITTED)]);
    const request = { ...ctx.request, output_byte_limit: cap };
    const base = { ...ctx.base, request_identity: fieldContractSha256(canonicalJson({ ...request, continuation: undefined })) };
    const plan = prepareActive(base, [a.proof, a.raw], request);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]!.map(row => row.proofs.length)).toEqual([0]);
    expect(plan.pages[0]![0]!.entry).toEqual(a.raw.entry);
    const delivered = deliverFrozenLibraryPage(ctx.runtime, { ...ctx.payload, request }, meter(), request, plan, 0);
    expect(encodedBytes(delivered, request)).toBeLessThanOrEqual(cap);
    expect(delivered.proofs ?? []).toEqual([]);
    expect(delivered.index.continuation).toBeNull();
  });
});

it("gives competing final-only proofs one raw prefix rather than a second last page", async () => {
  await withDeferralLibrary(ctx => {
    const { request, base, finalLimit } = finalEnvelope(ctx);
    const candidates = ctx.packages.flatMap(row => [row.proof, row.raw]);
    const plan = prepareActive(base, candidates, request);
    expect(plan.pages.map(page => page.map(row => row.proofs.length))).toEqual([[0], [1]]);
    expect(new Set(plan.pages.flat().map(packageRoot)).size).toBe(2);
    const first = deliverFrozenLibraryPage(ctx.runtime, { ...ctx.payload, request }, meter(), request, plan, 0);
    expect(first.proofs ?? []).toEqual([]);
    expect(first.index.entries).toHaveLength(1);
    const last = deliverFrozenLibraryPage(ctx.runtime, { ...ctx.payload, request }, meter(), request, plan, first.index.entries.length);
    expect(last.proofs).toHaveLength(1);
    expect(last.index.continuation).toBeNull();
    expect(new Set([...first.index.entries, ...last.index.entries].map(row => {
      if (row.target.kind !== "source_evidence") throw new Error("source root expected");
      return sourceGoldRootIdentity(row.target);
    })).size).toBe(2);
    for (const page of [first, last]) expect(encodedBytes(page, request)).toBeLessThanOrEqual(finalLimit);
  });
});

it("preserves an already reserved baseline and charged work when a deferred final proposal exhausts", async () => {
  await withDeferralLibrary(ctx => {
    const [a] = ctx.packages;
    if (a === undefined) throw new Error("proof package expected");
    const { request, base } = finalEnvelope(ctx);
    const candidates = [a.proof, a.raw];
    class FailDeferredProposal extends SourceSemanticReadBudget {
      attempts = 0;
      override charge(work: number, bytes: number, phase = "preparation"): void {
        if (phase === "deferred final candidate references") {
          this.attempts += 1;
          throw new SourceSemanticResourceExhausted(phase);
        }
        super.charge(work, bytes, phase);
      }
    }
    const failed = new FailDeferredProposal(BUDGET);
    const plan = prepareActive(base, candidates, request, failed);
    expect(failed.attempts).toBeGreaterThan(0);
    expect(failed.spentWork).toBeGreaterThan(0);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]!.length).toBeGreaterThan(0);
    expect(plan.pages[0]!.every(row => row.proofs.length === 0)).toBe(true);
    const delivered = deliverFrozenLibraryPage(ctx.runtime, { ...ctx.payload, request }, meter(), request, plan, 0);
    expect(encodedBytes(delivered, request)).toBeLessThanOrEqual(request.output_byte_limit);
    expect(delivered.proofs ?? []).toEqual([]);
  });
});

it("does not replace a fitting baseline with a deferred candidate that drops roots or proofs", async () => {
  await withDeferralLibrary(ctx => {
    const [a, b] = ctx.packages;
    if (a === undefined || b === undefined) throw new Error("two roots expected");
    const { request, base } = finalEnvelope(ctx);
    const third = extraRaw("third-root", "Carol stays quiet.", b.raw);
    const rawPlan = prepareActive(base, [a.raw, b.raw, third], request);
    const deferredPlan = prepareActive(base, [a.proof, a.raw, b.proof, b.raw, third], request);
    expect(new Set(deferredPlan.pages.flat().map(packageRoot)).size)
      .toBeGreaterThanOrEqual(new Set(rawPlan.pages.flat().map(packageRoot)).size);
    expect(deferredPlan.pages.flat().filter(row => row.proofs.length > 0).length)
      .toBeGreaterThanOrEqual(rawPlan.pages.flat().filter(row => row.proofs.length > 0).length);
    expect(deferredPlan.pages.flat().length).toBeGreaterThan(0);
    const first = deliverFrozenLibraryPage(ctx.runtime, { ...ctx.payload, request }, meter(), request, deferredPlan, 0);
    expect(encodedBytes(first, request)).toBeLessThanOrEqual(request.output_byte_limit);
    expect(first.index.entries.length).toBeGreaterThan(0);
  });
});
