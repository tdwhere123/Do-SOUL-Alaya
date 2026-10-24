import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import(
    "../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import {
  SourceSemanticResourceLedger, indexEntryCacheKey, sourceGoldRootIdentity, sourceRecallTarget,
  type InformationIndex, type SourceEvidenceTarget
} from "@do-soul/alaya-protocol";
import { prepareIndexedRecallProjection } from "@do-soul/alaya-storage";
import {
  captureIndexPreviews, captureIndexSourceMetadata, runConditionalFieldRecallWithReceipt, snapshotIdFromPin,
  type ConditionalFieldRecallRequest, type ObserverReaders
} from "@do-soul/alaya-core";
import { encodeIndexResults, encodeRecallPageResponse, frameEncodedIndex,
  type ConditionalFieldExecutionReceipt } from "@do-soul/alaya-core";
import { deliveryBudgetOf, fitProjectedRecallPage } from "../../../../../../packages/core/src/recall/runtime/recall-page-fit.js";
import { CoreError } from "@do-soul/alaya-core";
import { nativeNavigationProjection } from "../../../../../../packages/core/src/recall/runtime/native-navigation-projection.js";
import type { FieldEngineState } from "../../../../../../packages/core/src/recall/conditional-field/engine/field-engine.js";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import { CLOCK, QUERY_BUDGET, WS, withIndexedSources, type IndexFixture } from
  "./source-semantic-index-acquisition.test-support.js";

const HARBOR = "Harbor opening was delayed by the storm.";
const BERTH = "Harbor berth assignments were published late.";
const UNRELATED = "Cobalt paints dry overnight.";

it("delivers a generation-pinned membership page and replays its issued retry identity", async () => {
  await withIndexedSources([
    { id: "harbor", text: HARBOR, vector: [1, 0, 0] },
    { id: "berth", text: BERTH, vector: [0, 1, 0] },
    { id: "unrelated", text: UNRELATED, vector: [0, 0, 1] }
  ], async fixture => {
    const { request, prepared } = await fieldRequest(fixture, { page_budget: 2 });
    const first = runConditionalFieldRecallWithReceipt(request, { issue: "defer" });
    expect(first.index.result_version).toBe("ordinary-native-field.v1");
    expect(first.index.entries.some(entry => entry.target.kind === "source_evidence")).toBe(true);
    expect(first.index.entries.filter(entry => entry.target.kind === "source_evidence")
      .every(entry => entry.navigation?.contract === "native-query-navigation.v1")).toBe(true);
    // Preparation is the caller-paid vector work; it is reported, not re-debited as native visits.
    expect(first.execution_receipt.query_preparation).toMatchObject({ status: "ready", submitted_inputs: 1,
      external_api_attempts: 0 });
    // Logical work, native reads and retained bytes stay in their own columns: the
    // page ordering/fit is work, the source reads are visits/bytes, never the reverse.
    const phases = actualOf(first.execution_receipt).phases;
    expect(phases.observe.budget_work).toBeGreaterThan(0);
    expect(phases.index.budget_work).toBeGreaterThan(0);
    expect(phases.index.native_visits).toBe(0);
    expect(phases.index.charged_retained_bytes).toBeGreaterThan(0);
    expect(phases.payload.native_visits).toBeGreaterThan(0);
    expect(phases.payload.native_bytes).toBeGreaterThan(0);
    expect(prepared.vector.status).toBe("available");
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(1);

    const retry = runConditionalFieldRecallWithReceipt(request, { issue: "defer" });
    const deliveryId = retry.issue!({ index: retry.index,
      previews: captureIndexPreviews(retry.index, request.readers, WS), metadata: {} });
    expect(deliveryId).toBe(retry.delivery_id);
    expect(retry.index.entries).toEqual(first.index.entries);
    // The superseded prepared capture cannot commit over its successor.
    expect(() => first.issue!({ index: first.index,
      previews: captureIndexPreviews(first.index, request.readers, WS), metadata: {} }))
      .toThrow("stale prepared Recall delivery");
  });
});

it("keeps non-total navigation distinct from exhausted ordering resources", async () => {
  // The opportunity owner reports a non-total order only when a bound catalog
  // root has no captured position. That is navigation incompleteness, not a
  // refused ordering resource.
  const ordered = nativeNavigationProjection(navigationState({ missing: undefined }),
    [], new SourceSemanticResourceLedger({ work_units: 10_000, memory_bytes: 1_000_000 }));
  expect(ordered.status).toBe("ordered");
  const nonTotal = nativeNavigationProjection(navigationState({ missing: "second" }),
    [], new SourceSemanticResourceLedger({ work_units: 10_000, memory_bytes: 1_000_000 }));
  expect(nonTotal.status).toBe("non_total");
  expect(nonTotal.status === "non_total" ? nonTotal.missing_record_ids : []).toHaveLength(1);
  const refused = nativeNavigationProjection(navigationState({ missing: undefined }),
    [], new SourceSemanticResourceLedger({ work_units: 10_000, memory_bytes: 1 }));
  expect(refused.status).toBe("resource_refused");
  expect(refused.values.size).toBe(0);

  // The same incomplete navigation still delivers its observed membership rather
  // than reporting an empty-success page.
  await withIndexedSources([
    { id: "harbor", text: HARBOR, vector: [1, 0, 0] },
    { id: "berth", text: BERTH, vector: [0, 1, 0] },
    { id: "unrelated", text: UNRELATED, vector: [0, 0, 1] }
  ], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 2, missingCatalogPosition: "unrelated" });
    const executed = runConditionalFieldRecallWithReceipt(request);
    expect(executed.index.entries.length).toBeGreaterThan(0);
    expect(executed.index.order_status).not.toBe("complete");
    expect(executed.index.completeness.order_coverage).toBe("open");
  });
});

/** Minimal captured field surface read by the navigation owner: nomination facts and
 * observed seeds. Values are supplied separately, so the seed region need not match. */
function navigationState(options: Readonly<{ missing: string | undefined }>): FieldEngineState {
  const roots = ["first", "second"].map(id => sourceRecallTarget({ workspace_id: WS, root_kind: "source_record",
    root_id: id, source_version: "1", content_digest: `sha256:${id === "first" ? "1" : "2"}`.concat("0".repeat(63)), evidence_object_id: null }));
  const positions = Object.fromEntries(roots.filter(root => root.root_id !== options.missing)
    .map((root, index) => [sourceGoldRootIdentity(root), index]));
  return {
    observation_query_text: "Harbor", observation_workspace_id: WS, residuals: [], observations: [],
    native_sources: { result: { navigation_digest: `sha256:${"a".repeat(64)}`, completion: "complete" },
      witness: [], admitted_roots: roots, catalog_positions: positions }
  } as unknown as FieldEngineState;
}

it("refuses an unfit membership page instead of returning empty success and retains incurred work", async () => {
  await withIndexedSources([
    { id: "harbor", text: HARBOR, vector: [1, 0, 0] },
    { id: "berth", text: BERTH, vector: [0, 1, 0] }
  ], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 2, maxEncodedBytes: 64 });
    expect(() => runConditionalFieldRecallWithReceipt(request)).toThrow(/cannot carry its required public envelope/u);
    // Preparation and acquisition were already incurred by the refused request.
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(1);

    // The shared fit producer reports the failed envelope size and charges its own work.
    const deliverable = await fieldRequest(fixture, { page_budget: 2 });
    const page = runConditionalFieldRecallWithReceipt(deliverable.request).index;
    const meter = new SourceSemanticResourceLedger({ work_units: 10_000, memory_bytes: 1_000_000 });
    const unfitted = fitProjectedRecallPage({ index: page,
      previews: captureIndexPreviews(page, deliverable.request.readers, WS), metadata: {},
      request: { ...deliverable.request, delivery_budget: { max_total_tokens: 2_000, max_encoded_bytes: 64 } },
      request_digest: "refused-fit", meter });
    expect(unfitted.fits).toBe(false);
    expect(unfitted.bytes).toBeGreaterThan(64);
    // A refused fit is not free: the codec work it performed is charged, including
    // the serialization of the envelope it measured. The envelope is transient
    // output, so it does not also consume the delivery retention allowance.
    expect(meter.spentWork).toBeGreaterThan(0);
    expect(meter.spentBytes).toBe(0);
  });
});

it("fits payload expansion pages to the same encoded envelope and keeps visible intervals exact", async () => {
  await withIndexedSources([
    { id: "harbor", text: `${HARBOR} ${"Crane logs pile up. ".repeat(200)}`, vector: [1, 0, 0] }
  ], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 10 });
    const membership = runConditionalFieldRecallWithReceipt(request).index;
    const target = sourceTargetOf(membership, recordIdOf(fixture, "harbor"));
    // Expansion requests may declare their own delivery envelope; the frozen
    // continuation identity does not bind the resource-derived byte allowance.
    const expand = (byteBudget: number, maxEncodedBytes = 4_000_000): ConditionalFieldRecallRequest => ({
      ...request, delivery_budget: { max_total_tokens: 2_000, max_encoded_bytes: maxEncodedBytes },
      continuation: membership.continuation,
      payload_continuation: { schema_version: 1, purpose: "payload_expansion", target, start_offset: 0, byte_budget: byteBudget }
    });

    const expandedRun = runConditionalFieldRecallWithReceipt(expand(300));
    const expanded = expandedRun.index;
    expect(expanded.page_purpose).toBe("payload");
    // The expansion read and its envelope fit are charged to their own phases, so a
    // payload page never reports zero read work while shipping hydrated text.
    const actual = actualOf(expandedRun.execution_receipt);
    expect(actual.phases.payload.native_visits).toBeGreaterThan(0);
    expect(actual.phases.payload.native_bytes).toBeGreaterThan(0);
    expect(actual.phases.index.budget_work).toBeGreaterThan(0);
    // Hydrated bytes belong to the payload phase; the fit charges page work, not a
    // second retained copy of the same envelope.
    expect(actual.phases.payload.charged_retained_bytes).toBeGreaterThan(0);
    expect(expanded.entries).toHaveLength(1);
    const span = expanded.entries[0]!.target;
    expect(span.kind).toBe("source_evidence");
    if (span.kind !== "source_evidence") throw new Error("source target expected");
    expect(span.span).toMatchObject({ content_start: 0, content_end: 300, content_complete: false });
    const preview = [...captureIndexPreviews(expanded, request.readers, WS).values()][0] ?? "";
    expect(Buffer.byteLength(preview)).toBe(300);
    expect(Buffer.byteLength(JSON.stringify(expanded))).toBeLessThanOrEqual(6_500);

    // A whole-body expansion exceeds the same encoded envelope: hydration is capped
    // by the delivery budget, and the resulting page still does not fit. Refuse it
    // with the incurred read cost rather than staging an over-budget page.
    expect(() => runConditionalFieldRecallWithReceipt(expand(10_000, 6_500)))
      .toThrow(/cannot fit its required public envelope/u);
    // The refusal does not poison the pinned continuation: the deliverable range
    // remains readable, so a refused expansion is not a wedged cursor.
    const retried = runConditionalFieldRecallWithReceipt(expand(300)).index;
    expect(retried.entries).toHaveLength(1);
    expect(retried.entries[0]!.target.kind === "source_evidence"
      ? retried.entries[0]!.target.span?.content_end : undefined).toBe(300);
  });
});

it("separates a classified page-resource refusal from an authorized valid-empty delivery", async () => {
  await withIndexedSources([
    { id: "harbor", text: HARBOR, vector: [1, 0, 0] }
  ], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 2, maxEncodedBytes: 64 });
    const refusal = captureFailure(() => runConditionalFieldRecallWithReceipt(request));
    expect(refusal?.code).toBe("CONFLICT");
    // A deterministic envelope refusal is terminal, not retryable backpressure.
    expect(refusal?.subCode).toBeUndefined();
    expect(refusal?.details).toMatchObject({ outcome: "resource_exhausted", resource: "encoded_page",
      available_bytes: 64 });
    // The refused request still reports the work and preparation it already incurred.
    const receipt = refusal?.details?.execution_receipt as ConditionalFieldExecutionReceipt | undefined;
    expect(receipt?.actual).toBeDefined();
    expect(receipt?.query_preparation?.status).toBe("ready");
    // No phase may report more work than the request actually granted.
    expect(receipt!.actual!.phases.index.budget_work).toBeLessThanOrEqual(request.budget.work_units);
    expect(receipt!.actual!.native_visits).toBeLessThanOrEqual(request.budget.work_units);
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(1);

    // An authorized scope set that admits nothing is a valid empty delivery; it must
    // not be reported as a resource refusal or carry a fresh cursor.
    const denied = runConditionalFieldRecallWithReceipt({ ...request, ...restoredBudget(),
      delivery_budget: { max_total_tokens: 2_000, max_encoded_bytes: 4_000_000 }, authorized_scopes: [] });
    expect(denied.index.entries).toEqual([]);
    expect(denied.index.continuation).toBeNull();
  });
});

it("commits exactly the page its shared codec fits, including continuation and visible spans", async () => {
  await withIndexedSources([
    { id: "harbor", text: HARBOR, vector: [1, 0, 0] }
  ], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 2, maxEncodedBytes: 8_000 });
    const executed = runConditionalFieldRecallWithReceipt(request);
    const page = executed.index;
    const previews = captureIndexPreviews(page, request.readers, WS);
    const metadata = captureIndexSourceMetadata(page);
    // Re-encoding the committed page reproduces the same visible intervals and its
    // measured envelope stays inside the cap. A later membership expansion would
    // show up here as changed spans or a larger encoded page.
    const results = encodeIndexResults(page, previews, deliveryBudgetOf(request).max_total_tokens, metadata);
    const reframed = frameEncodedIndex(page, results);
    const envelope = encodeRecallPageResponse({ delivery_id: "independent-fit-check", index: reframed, results,
      active_constraints: [], active_constraints_count: null, degradation_reason: null });
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(8_000);
    expect(reframed.entries).toEqual(page.entries);
    expect(page.continuation).not.toBeNull();
    for (const entry of page.entries) {
      if (entry.target.kind !== "source_evidence" || entry.target.span === undefined) continue;
      const preview = previews.get(indexEntryCacheKey(entry)) ?? "";
      expect(entry.target.span.content_end - entry.target.span.content_start).toBe(Buffer.byteLength(preview));
    }
  });
});

it("derives one default delivery envelope for both the public view and the page fit", async () => {
  await withIndexedSources([
    { id: "harbor", text: HARBOR, vector: [1, 0, 0] }
  ], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 1 });
    const { delivery_budget: _omitted, ...withoutEnvelope } = request;
    const executed = runConditionalFieldRecallWithReceipt(withoutEnvelope);
    const announced = executed.execution_receipt.compile_input.view?.delivery_budget;
    expect(announced).toEqual(deliveryBudgetOf(withoutEnvelope));
    expect(announced?.max_encoded_bytes).toBe(withoutEnvelope.requested_budget?.memory_bytes);
    expect(executed.index.entries.length).toBeGreaterThan(0);
  });
});

it("carries a query-lease source restriction and prepared hint into native nomination identity", async () => {
  await withIndexedSources([
    { id: "harbor", text: HARBOR, vector: [1, 0, 0] },
    { id: "berth", text: BERTH, vector: [0, 1, 0] }
  ], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 2 });
    const seen: Readonly<Record<string, unknown>>[] = [];
    const readers: ObserverReaders = { ...request.readers, nominateSources: input => {
      seen.push(input as unknown as Readonly<Record<string, unknown>>);
      return request.readers.nominateSources!(input);
    } };
    const restricted = runConditionalFieldRecallWithReceipt({ ...request, readers,
      source_id: "harbor", access_hint: "Harbor opening" });
    expect(seen[0]).toMatchObject({ sourceId: "harbor", hint: "Harbor opening" });
    const otherSource = runConditionalFieldRecallWithReceipt({ ...request, source_id: "berth" }).index;
    expect(otherSource.query_id).not.toBe(restricted.index.query_id);
    const noHint = runConditionalFieldRecallWithReceipt({ ...request, source_id: "harbor" }).index;
    expect(noHint.query_id).not.toBe(restricted.index.query_id);
  });
});

it("rejects an acknowledgment whose source generation changed after preparation", async () => {
  await withIndexedSources([
    { id: "harbor", text: HARBOR, vector: [1, 0, 0] }
  ], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 1 });
    const prepared = runConditionalFieldRecallWithReceipt(request, { issue: "defer" });
    await fixture.admit({ id: "later", text: "Harbor crane maintenance.", vector: [1, 0, 0] }, "2");
    const failure = captureFailure(() => prepared.issue!({ index: prepared.index,
      previews: captureIndexPreviews(prepared.index, request.readers, WS), metadata: {} }));
    expect(failure).toMatchObject({ code: "CONFLICT", message: "Recall source generation changed before delivery",
      details: { outcome: "stale_generation",
      resource: "source_generation", execution_receipt: { query_id: prepared.index.query_id,
        actual: { native_visits: expect.any(Number) } } } });
    expect(failure?.details).not.toHaveProperty("worker");
    expect(failure?.details).not.toHaveProperty("work");
  });
});

it("captures request authorization before a nomination callback can change it", async () => {
  await withIndexedSources([
    { id: "harbor", text: HARBOR, vector: [1, 0, 0] }
  ], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 1 });
    const denied: readonly string[] = [];
    const frames: (readonly string[] | null)[] = [];
    const readers: ObserverReaders = { ...request.readers, nominateSources: input => {
      frames.push(input.authorizedScopes);
      // A port that mutates the frame it received must not reach the request's own
      // authorization, the compiled identity or the receipt.
      if (input.authorizedScopes !== null) (input.authorizedScopes as string[]).push("project");
      return request.readers.nominateSources!(input);
    } };
    const executed = runConditionalFieldRecallWithReceipt({ ...request, authorized_scopes: denied, readers });
    // Denied is its own authority, distinct from the omitted default.
    expect(executed.execution_receipt.compile_input.authorized_scopes).toEqual([]);
    expect(executed.index.entries).toHaveLength(0);
    // The caller's array and the retained authority are both unchanged by the port.
    expect(frames[0]).not.toBe(denied);
    expect(denied).toEqual([]);
    expect(request.authorized_scopes).toBeNull();
    // Omitted and denied stay distinguishable: an omitted scope is not an empty list.
    const omitted = runConditionalFieldRecallWithReceipt({ ...request, readers });
    expect(omitted.execution_receipt.compile_input.authorized_scopes).toBeNull();
  });
});

it("charges an empty membership envelope instead of treating it as free", async () => {
  await withIndexedSources([
    { id: "harbor", text: HARBOR, vector: [1, 0, 0] }
  ], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 1 });
    const empty = { ...runConditionalFieldRecallWithReceipt(request).index, entries: [],
      product_updates: undefined };
    expect(empty.entries).toHaveLength(0);
    let encoded = 0;
    const meter = new SourceSemanticResourceLedger({ work_units: 100, memory_bytes: 1_000_000 });
    const fitted = fitProjectedRecallPage({ index: empty, previews: new Map(), metadata: {},
      request: { ...request, encode_page: () => { encoded += 1; return { large: "x".repeat(100_000) }; } },
      request_digest: "empty-envelope", meter });
    // The envelope is still encoded, and its work grows with the real serialized
    // size: a 100-kilobyte envelope is never a zero-work page.
    expect(encoded).toBe(1);
    expect(fitted.bytes).toBeGreaterThan(100_000);
    expect(meter.spentWork).toBeGreaterThanOrEqual(100);
    expect(meter.spentBytes).toBe(0);
  });
});

it("refuses an unaffordable frame before encoding it and never reports free work", async () => {
  await withIndexedSources([
    { id: "harbor", text: HARBOR, vector: [1, 0, 0] }
  ], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 1 });
    const page = runConditionalFieldRecallWithReceipt(request).index;
    expect(page.entries.length).toBeGreaterThan(0);
    let encoded = 0;
    const meter = new SourceSemanticResourceLedger({ work_units: 1, memory_bytes: 1_000_000 });
    const fitted = fitProjectedRecallPage({ index: page, previews: new Map(), metadata: {},
      request: { ...request, encode_page: () => { encoded += 1; return {}; } },
      request_digest: "unaffordable", meter });
    // Work is bounded before it is performed.
    expect(encoded).toBe(0);
    expect(fitted.fits).toBe(false);
    expect(fitted.interruption).toBe("work");
    expect(meter.spentWork).toBe(0);
  });
});

it("refuses an oversized empty codec and retains the incurred framing receipt", async () => {
  await withIndexedSources([{ id: "harbor", text: HARBOR, vector: [1, 0, 0] }], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 1, maxEncodedBytes: 64 });
    const failure = captureFailure(() => runConditionalFieldRecallWithReceipt({ ...request, authorized_scopes: [],
      encode_page: () => ({ large: "x".repeat(100_000) }) }));
    expect(failure).toMatchObject({ code: "CONFLICT", details: { resource: "encoded_page",
      required_bytes: 100_012, execution_receipt: { actual: { phases: { index: { budget_work: expect.any(Number) } } } } } });
  });
});

it("attaches Core framing costs to a thrown codec without rewriting other owner receipts", async () => {
  await withIndexedSources([{ id: "harbor", text: HARBOR, vector: [1, 0, 0] }], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 1 });
    const work = { native_work: 7 }, worker = { native_visits: 9 };
    const failure = captureFailure(() => runConditionalFieldRecallWithReceipt({ ...request, authorized_scopes: [],
      encode_page: () => { throw new CoreError("CONFLICT", "authored codec refusal", { details: { work, worker } }); } }));
    expect(failure).toMatchObject({ message: "authored codec refusal", details: { execution_receipt: {
      actual: { phases: { index: { budget_work: 2 } } } } } });
    expect(failure?.details?.work).toBe(work);
    expect(failure?.details?.worker).toBe(worker);
  });
});

it("recovers an unfitted payload without issuing it or claiming unread support", async () => {
  await withIndexedSources([{ id: "harbor", text: `${HARBOR} ${"Crane logs. ".repeat(100)}`, vector: [1, 0, 0] }], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 1 });
    const first = runConditionalFieldRecallWithReceipt(request).index;
    const target = sourceTargetOf(first);
    const expansion = { ...request, continuation: first.continuation,
      payload_continuation: { schema_version: 1 as const, purpose: "payload_expansion" as const,
        target, start_offset: 0, byte_budget: 300 } };
    const interrupted = captureFailure(() => runConditionalFieldRecallWithReceipt({ ...expansion,
      budget: { ...request.budget, work_units: 7, finalization_reserve: 0, min_envelope: 1 } }));
    // No envelope can be measured under this remaining allowance. Refuse without
    // issuing or consuming the existing token; the larger request below recovers it.
    expect(interrupted).toMatchObject({ code: "CONFLICT", details: {
      outcome: "resource_exhausted", resource: "framing_work", execution_receipt: { actual: expect.any(Object) } } });
    expect(interrupted?.details).not.toHaveProperty("index");
    const recovered = runConditionalFieldRecallWithReceipt(expansion);
    expect(recovered.index.completeness.payload).not.toBe("interrupted");
    expect(sourceTargetOf(recovered.index).span).toMatchObject({ content_start: 0, content_end: 300 });
    expect([...captureIndexPreviews(recovered.index, request.readers, WS).values()].some(text => Buffer.byteLength(text) === 300)).toBe(true);
  });
});

it.each([2, 5])("never acknowledges an unfitted progress envelope under 64 bytes with %i work units", work_units => {
  const request: ConditionalFieldRecallRequest = {
    workspace_id: WS, query_text: "Harbor", budget: { ...QUERY_BUDGET, work_units,
      finalization_reserve: 0, min_envelope: 1 },
    snapshot_id: snapshotIdFromPin(WS, undefined), interpretation_clock: CLOCK, as_of: CLOCK,
    lifetime_now: CLOCK, expires_at: "2099-01-01T00:00:00.000Z", readers: {}, authorized_scopes: [],
    delivery_budget: { max_total_tokens: 2_000, max_encoded_bytes: 64 }
  };
  const failure = captureFailure(() => runConditionalFieldRecallWithReceipt(request, { issue: "defer" }));
  expect(failure).toMatchObject({ code: "CONFLICT", details: { outcome: "resource_exhausted",
    execution_receipt: { actual: expect.any(Object) } } });
  expect(failure?.details).not.toHaveProperty("index");
  expect(failure?.details).not.toHaveProperty("delivery_id");
  const recovered = runConditionalFieldRecallWithReceipt({ ...request, budget: QUERY_BUDGET,
    delivery_budget: { max_total_tokens: 2_000, max_encoded_bytes: 100_000 } });
  expect(recovered.index.entries).toEqual([]);
  expect(recovered.index.continuation).toBeNull();
});

it("rechecks a reduced replay allowance without consuming the exact issued retry", async () => {
  await withIndexedSources([{ id: "harbor", text: HARBOR, vector: [1, 0, 0] },
    { id: "berth", text: BERTH, vector: [0, 1, 0] }], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 1 });
    const first = runConditionalFieldRecallWithReceipt(request);
    expect(first.index.continuation).not.toBeNull();
    const next = { ...request, continuation: first.index.continuation };
    const issued = runConditionalFieldRecallWithReceipt(next, { issue: "defer" });
    const deliveryId = issued.issue!({ index: issued.index,
      previews: captureIndexPreviews(issued.index, request.readers, WS), metadata: captureIndexSourceMetadata(issued.index) });
    expect(deliveryId).toBeDefined();
    const failure = captureFailure(() => runConditionalFieldRecallWithReceipt({ ...next,
      delivery_budget: { max_total_tokens: 2_000, max_encoded_bytes: 64 } }));
    expect(failure).toMatchObject({ code: "CONFLICT", details: { outcome: "resource_exhausted",
      resource: "encoded_page", available_bytes: 64 } });
    const retried = runConditionalFieldRecallWithReceipt(next, { issue: "defer" });
    expect(retried.delivery_id).toBe(deliveryId);
    expect(retried.index.entries).toEqual(issued.index.entries);
    expect(actualOf(retried.execution_receipt).phases.payload.native_visits).toBe(0);
    expect(actualOf(retried.execution_receipt).phases.index.budget_work).toBeGreaterThan(0);
    expect(retried.issue!({ index: retried.index,
      previews: captureIndexPreviews(retried.index, request.readers, WS), metadata: captureIndexSourceMetadata(retried.index) }))
      .toBe(deliveryId);
  });
});

it("delivers a genuinely empty SQLite source using display decoration without inventing source bytes", async () => {
  await withIndexedSources([{ id: "empty", text: "", indexed: false },
    { id: "needle", text: "needle", vector: [0, 1, 0] }], async fixture => {
    const { request } = await fieldRequest(fixture, { page_budget: 10 });
    const execution = runConditionalFieldRecallWithReceipt(request, { issue: "defer" });
    const empty = sourceTargetOf(execution.index, recordIdOf(fixture, "empty"));
    const needle = sourceTargetOf(execution.index, recordIdOf(fixture, "needle"));
    expect(empty.span).toMatchObject({ content_start: 0, content_end: 0, content_complete: true });
    expect(needle.span).toMatchObject({ content_start: 0, content_end: 6, content_complete: true });
    const previews = captureIndexPreviews(execution.index, request.readers, WS);
    const metadata = captureIndexSourceMetadata(execution.index);
    const results = encodeIndexResults(execution.index, previews, 2_000, metadata);
    const response = encodeRecallPageResponse({ delivery_id: `delivery_${execution.delivery_id}`,
      index: frameEncodedIndex(execution.index, results), results, active_constraints: [],
      active_constraints_count: null, active_constraints_completeness: "incomplete", degradation_reason: null });
    expect(results.find(row => row.target.kind === "source_evidence" && row.target.root_id === empty.root_id)?.content_preview)
      .toBe("[empty source]");
    expect(response.index?.completeness.payload).toBe("complete");
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(request.delivery_budget!.max_encoded_bytes);
    expect(execution.issue!({ index: execution.index, previews, metadata })).toBe(execution.delivery_id);
  });
});

async function fieldRequest(fixture: IndexFixture, options: Readonly<{
  page_budget: number; maxEncodedBytes?: number; missingCatalogPosition?: string; memoryBytes?: number;
}>): Promise<{ request: ConditionalFieldRecallRequest; prepared: Awaited<ReturnType<IndexFixture["prepareQuery"]>> }> {
  prepareIndexedRecallProjection(fixture.database);
  const prepared = await fixture.prepareQuery({ navigation: "Harbor", signal: new AbortController().signal,
    remainingMs: () => 60_000 });
  const budget = { ...QUERY_BUDGET, page_budget: options.page_budget,
    ...(options.memoryBytes === undefined ? {} : { memory_bytes: options.memoryBytes }) };
  const request = {
    workspace_id: WS, query_text: "Harbor", budget, requested_budget: budget,
    snapshot_id: snapshotIdFromPin(WS, undefined), interpretation_clock: CLOCK, as_of: CLOCK,
    expires_at: "2099-01-01T00:00:00.000Z", lifetime_now: CLOCK,
    readers: nativeReaders(fixture, prepared.vector, options.missingCatalogPosition),
    prepared_query: prepared,
    authorized_scopes: null, enumeration_policy: "native_query", result_kind_view: "mixed",
    delivery_budget: { max_total_tokens: 2_000, max_encoded_bytes: options.maxEncodedBytes ?? 4_000_000 },
    protocol_version: 1, supported_result_kinds: ["memory_entry", "source_evidence"], supports_source_evidence: true
  } satisfies ConditionalFieldRecallRequest;
  return { request, prepared };
}

/** Native nomination plus the explicit bound catalog pool the live library adapter retains.
 * The position of one bound root is deliberately absent in the non-total case.
 */
function nativeReaders(fixture: IndexFixture, vector: Awaited<ReturnType<IndexFixture["prepareQuery"]>>["vector"],
  missingCatalogPosition?: string): ObserverReaders {
  const readers = createConditionalFieldObserverReaders(fixture.database, [], vector);
  const roots = sourceTargets(fixture);
  const positions = Object.fromEntries(roots
    .filter(root => root.root_id !== missingCatalogPosition)
    .map((root, index) => [sourceGoldRootIdentity(root), index]));
  return { ...readers, nominateSources: input => {
    const nomination = readers.nominateSources!(input);
    return { ...nomination, admitted_roots: roots, catalog_positions: positions };
  } };
}

function sourceTargets(fixture: IndexFixture): SourceEvidenceTarget[] {
  const rows = fixture.database.connection.prepare(
    `SELECT workspace_id, record_id, source_version, content_digest, evidence_object_id
     FROM source_records WHERE workspace_id = ? ORDER BY source_id DESC`
  ).all(WS) as { workspace_id: string; record_id: string; source_version: string;
    content_digest: string; evidence_object_id: string | null }[];
  return rows.map(row => sourceRecallTarget({ workspace_id: row.workspace_id, root_kind: "source_record",
    root_id: row.record_id, source_version: row.source_version, content_digest: row.content_digest,
    evidence_object_id: row.evidence_object_id }));
}

function actualOf(receipt: ConditionalFieldExecutionReceipt) {
  expect(receipt.actual).toBeDefined();
  if (receipt.actual === undefined) throw new Error("measured execution required");
  return receipt.actual;
}

type Failure = Readonly<{ code?: string; subCode?: string; details?: Record<string, unknown> }> | undefined;

function captureFailure(run: () => unknown): Failure {
  try { run(); return undefined; }
  catch (error) { return error as Failure; }
}

/** The fixture budget is the only envelope the frozen continuation accepts. */
function restoredBudget() {
  return { budget: { ...QUERY_BUDGET }, requested_budget: { ...QUERY_BUDGET } };
}

function recordIdOf(fixture: IndexFixture, sourceId: string): string {
  const row = fixture.database.connection.prepare(
    "SELECT record_id FROM source_records WHERE workspace_id = ? AND source_id = ?").get(WS, sourceId) as { record_id: string };
  return row.record_id;
}

function sourceTargetOf(index: InformationIndex, rootId?: string): SourceEvidenceTarget {
  const entry = index.entries.find(candidate => candidate.target.kind === "source_evidence"
    && (rootId === undefined || candidate.target.root_id === rootId));
  if (entry === undefined || entry.target.kind !== "source_evidence") throw new Error("source entry expected");
  return entry.target;
}
