import { expect, vi } from "vitest";
import { sourceDisclosure, SourceDeliveredSpanSchema, SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  sourceRecallTarget, type SourceRecordIdentity, type SoulInterpretationResponse }
  from "@do-soul/alaya-protocol";
import { authorizeSemanticScope, encodeSourceSemanticLibraryResponse, fieldContractSha256, hydrateUtf8Chunk,
  projectSourceDisclosure, sourceSemanticLibrarySourceEntry, type SourceSemanticLibraryPackage }
  from "@do-soul/alaya-core";
import { currentSemanticSource, SourceSemanticReadBudget, sourceSemanticReadStores }
  from "../../../runtime/field/source-semantic-read-stores.js";
import { prepareLibraryPackages } from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import type { LibraryPageSelector } from "../../../runtime/recall-read-worker/source-semantic-library-delivery.js";
import { CLOCK } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";
import { physicalRoot, rawSourceTwin, selectionExecutionBudget }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { deliverAllPages, measureNativeSubset, type NativeSubsetContext, type NativeMeasurement }
  from "./source-semantic-library-subset-packing.test-support.js";

export { nativeSubsetContext } from "./source-semantic-library-subset-packing.test-support.js";
export { previewNoveltySelectionFixture } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
export type { NativeSubsetContext };
export type DirectedOrder = "cover_first" | "cover_last";
export type Receipt = (name: string, value: unknown) => void;
type PublicRecall = Extract<SoulInterpretationResponse, { operation: "recall" }>;
type Identity = Pick<SourceRecordIdentity, "workspace_id" | "source_id" | "identity" | "source_version" | "content_digest">;
const SCOPES = ["project"];

/** Existing preparation has no delivery-planning calls. Only its source seeds use rawSourceTwin. */
export function prepareOriginalCandidates(context: NativeSubsetContext) {
  const meter = new SourceSemanticReadBudget(selectionExecutionBudget);
  const result = prepareLibraryPackages(context.runtime,
    { workspace_id: "ws", as_of: CLOCK, authorized_scopes: { mode: "named", scopes: SCOPES } } as never,
    SCOPES, meter, context.fixture.pool.map(rawSourceTwin).map(row => row.entry),
    context.fixture.sources.map(source => ({ proof: source.package.proofs[0]!, group: source.package,
      source: source.body, dependencies: source.dependencies })));
  if (result.incomplete) throw new Error("original candidate preparation incomplete; no delivery attempts allowed");
  if (context.fixture.sources.some(source => source.budget_rejections.length > 0)) {
    throw new Error("fixture computation exhausted its native budget; no delivery attempts allowed");
  }
  return { candidates: result.packages, work: ledgerState(meter) };
}

/** The returned constructor accepts only identity, never gold or a desired interval. */
export function sourceCoverConstructor(context: NativeSubsetContext, originals: readonly SourceSemanticLibraryPackage[]) {
  return (identity: Identity) => {
    const meter = new SourceSemanticReadBudget(selectionExecutionBudget);
    const stores = sourceSemanticReadStores(context.runtime.database, identity.workspace_id, identity.source_id, meter, SCOPES);
    const stored = currentSemanticSource(stores, identity.workspace_id, identity.source_id), record = stored.record;
    if (record.identity !== identity.identity || record.source_version !== identity.source_version
      || record.content_digest !== identity.content_digest) throw new Error("cover source is not the named current source");
    authorizeSemanticScope(record.scope_class, SCOPES);
    if (`sha256:${fieldContractSha256(stored.content_bytes)}` !== record.content_digest) throw new Error("stored body digest mismatch");
    const siblings = originals.filter(row => row.entry.target.kind === "source_evidence"
      && row.entry.target.root_id === identity.identity && row.entry.target.source_version === identity.source_version
      && row.entry.target.content_digest === identity.content_digest);
    const raw = siblings.find(row => row.proofs.length === 0);
    if (raw?.entry.target.kind !== "source_evidence" || raw.entry.target.span === undefined) throw new Error("original raw span missing");
    const spans = siblings.map(row => {
      if (row.entry.target.kind !== "source_evidence" || row.entry.target.span?.retained_extent !== "body") throw new Error("original body span missing");
      return row.entry.target.span;
    });
    const start = Math.min(...spans.map(span => span.content_start)), end = Math.max(...spans.map(span => span.content_end));
    const bodyBytes = Buffer.byteLength(stored.content_bytes, "utf8");
    if (start !== 0 || end !== bodyBytes) throw new Error("original span hull is not the entire admitted body");
    // The existing raw preparation owns original completeness. Body closure cannot upgrade it.
    const originalComplete = raw.entry.target.span.original_complete;
    if (spans.some(span => span.original_complete !== originalComplete)) throw new Error("conflicting original completeness authority");
    const chunk = hydrateUtf8Chunk(stored.content_bytes, { offset: start, byteLimit: end - start });
    if (chunk.status !== "chunk" || chunk.start_offset !== start || chunk.end_offset !== end) throw new Error("cover UTF-8 bounds unavailable");
    const fresh = sourceSemanticLibrarySourceEntry({ workspaceId: record.workspace_id, root_id: record.identity,
      source_version: record.source_version, content_digest: record.content_digest,
      evidence_object_id: record.evidence_object_id, hypothesis_id: "library" });
    if (fresh.target.kind !== "source_evidence") throw new Error("source constructor returned another target kind");
    const entry = { ...fresh, target: sourceRecallTarget({ ...fresh.target, span: SourceDeliveredSpanSchema.parse({
      content_start: chunk.start_offset, content_end: chunk.end_offset, retained_extent: "body",
      content_complete: chunk.start_offset === 0 && chunk.end_offset === bodyBytes, original_complete: originalComplete
    }) }) };
    const cover: SourceSemanticLibraryPackage = { entry, entries: [entry], proofs: [], explanations: [],
      preview: chunk.text, access_position: raw.access_position, payload_support: "not_applicable",
      source_disclosure: projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of: CLOCK,
        source: record, proof_use: "source_only" }) };
    return { cover, binding: { record, body_bytes: bodyBytes, body_sha256: fieldContractSha256(stored.content_bytes),
      original_spans: spans, hull: { start, end }, original_completeness_authority: "unchanged_original_raw_span",
      source_read_work: ledgerState(meter), authorized_scopes: { mode: "named", scopes: SCOPES } } };
  };
}

function ledgerState(meter: SourceSemanticResourceLedger) {
  return { logical_work: meter.spentWork, logical_bytes: meter.spentBytes,
    remaining_work: meter.work, remaining_bytes: meter.bytes,
    ...(meter instanceof SourceSemanticReadBudget ? { native_work: meter.nativeWork, native_bytes: meter.nativeBytes } : {}) };
}

/** Read-only instrumentation: delegates every original call once, with unchanged arguments. */
export function observeNativeBudgets() {
  const ledgers = new Map<SourceSemanticResourceLedger, { id: number; phases: Record<string, { calls: number; work: number; bytes: number }> }>();
  const refusals: unknown[] = [], retained: { phase: string; encoded: PublicRecall }[] = [];
  const preparationLedgers = new Set<SourceSemanticResourceLedger>();
  const rowFor = (ledger: SourceSemanticResourceLedger) => {
    let row = ledgers.get(ledger);
    if (row === undefined) { row = { id: ledgers.size + 1, phases: {} }; ledgers.set(ledger, row); }
    return row;
  };
  const reserve = SourceSemanticResourceLedger.prototype.reserve, charge = SourceSemanticResourceLedger.prototype.charge;
  const retain = SourceSemanticResourceLedger.prototype.retain;
  const reserveSpy = vi.spyOn(SourceSemanticResourceLedger.prototype, "reserve").mockImplementation(function (this: SourceSemanticResourceLedger, work, bytes, phase) {
    const row = rowFor(this);
    try { return reserve.call(this, work, bytes, phase); }
    catch (error) {
      refusals.push({ ledger: row.id, phase: phase ?? "preparation", work, bytes, state: ledgerState(this), error: errorRecord(error) });
      throw error;
    }
  });
  const chargeSpy = vi.spyOn(SourceSemanticResourceLedger.prototype, "charge").mockImplementation(function (this: SourceSemanticResourceLedger, work, bytes, phase = "preparation") {
    const row = rowFor(this);
    if (phase === "library page root census") preparationLedgers.add(this);
    charge.call(this, work, bytes, phase);
    const totals = row.phases[phase] ??= { calls: 0, work: 0, bytes: 0 };
    totals.calls++; totals.work += work; totals.bytes += bytes;
  });
  const retainSpy = vi.spyOn(SourceSemanticResourceLedger.prototype, "retain").mockImplementation(function (this: SourceSemanticResourceLedger, value, phase) {
    retain.call(this, value, phase);
    if (phase === "candidate delivery encoding" || phase === "candidate partial delivery encoding") {
      const encoded = value as SoulInterpretationResponse;
      if (encoded.operation !== "recall") throw new Error("candidate recall encoding expected");
      retained.push({ phase, encoded });
    }
  });
  return { retained, refusals, snapshot: () => ({
    observed_prepare_invocations: preparationLedgers.size, retained_candidate_encodings: retained.length,
    reserve_page_calls: "not_measured", all_encoder_calls: "not_measured", rss_bound: "NOT_CLAIMED",
    ledgers: [...ledgers].map(([ledger, row]) => ({ ...row, ...ledgerState(ledger),
      role: preparationLedgers.has(ledger) ? "preparation" : "delivery_or_internal" })), refusals
  }), restore: () => { retainSpy.mockRestore(); chargeSpy.mockRestore(); reserveSpy.mockRestore(); } };
}

export function errorRecord(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack,
    ...(error instanceof SourceSemanticResourceExhausted ? { phase: error.phase } : {}),
    ...("code" in error ? { code: error.code } : {}), ...("issues" in error ? { issues: error.issues } : {}) }
    : { thrown: String(error) };
}

function packageRecord(row: SourceSemanticLibraryPackage, cover: SourceSemanticLibraryPackage) {
  return { root: physicalRoot(row), target: row.entry.target, representation: row === cover ? "whole_source_cover"
    : row.proofs.length === 0 ? "original_raw" : "original_proof", proof_count: row.proofs.length };
}

/** Private directed compositions; no native-policy claim, subset search or selector fallback. */
function directedSelector(order: DirectedOrder, cover: SourceSemanticLibraryPackage, receipt: Receipt,
  budget: ReturnType<typeof observeNativeBudgets>, quiet: () => void) {
  let selections = 0, fits = 0;
  const trace: unknown[] = [];
  const selector: LibraryPageSelector = input => {
    quiet();
    const selection = ++selections, coverOffered = input.candidates.includes(cover);
    const others = input.candidates.filter(row => row.proofs.length === 0 && row !== cover && physicalRoot(row) !== physicalRoot(cover));
    const roots = new Set(input.candidates.map(physicalRoot));
    const probe = (name: string, composition: readonly SourceSemanticLibraryPackage[]) => {
      quiet();
      const ordinal = ++fits, before = budget.retained.length;
      let outcome: boolean | undefined, error: unknown;
      try { outcome = input.fits(composition); return outcome; }
      catch (caught) { error = errorRecord(caught); throw caught; }
      finally {
        const record = { selection, fit_call: ordinal, requested: name, observation: "fit_probe_not_delivery",
          composition: composition.map(row => packageRecord(row, cover)), fits: outcome ?? "not_returned", error,
          reservations: budget.retained.slice(before).map(({ phase, encoded }) => ({ phase, encoded,
            encoded_bytes: Buffer.byteLength(JSON.stringify(encoded)),
            result_budget_states: encoded.results?.map(row => row.budget_state) ?? null })) };
        trace.push(record); receipt(`fit-${ordinal}`, record);
      }
    };
    let selected: readonly SourceSemanticLibraryPackage[] = [];
    if (coverOffered && order === "cover_first") {
      const mixed = [cover, ...others], mixedFits = probe("cover_plus_other_original_raw", mixed);
      const aloneFits = probe("cover_alone", [cover]);
      selected = mixedFits ? mixed : aloneFits ? [cover] : [];
    } else if (others.length > 0) {
      if (probe("other_original_raw_roots", others)) selected = others;
    } else if (coverOffered && roots.size === 1) {
      if (probe("cover_on_actual_last_root", [cover])) selected = [cover];
    }
    // A native-owner final-proof callback offers no directed composition. It is not a cover.
    const record = { selection, offered: input.candidates.map(row => packageRecord(row, cover)),
      native_owner_callback: coverOffered || others.length > 0 ? "ordinary" : "final_proof_no_directed_composition",
      selected: selected.map(row => packageRecord(row, cover)), remaining_root_count: roots.size };
    trace.push(record); receipt(`selection-${selection}`, record);
    quiet(); return selected;
  };
  return { selector, snapshot: () => ({ selector_calls: selections, fit_calls: fits, trace }) };
}

type DeliveryObservation = {
  emitted: { mixed_cover: string; cover_alone_continuing: string; cover_alone_final: string };
  observations: unknown[]; observed_pages: number; omitted_frozen_pages: number | "not_measured";
};

function observeDelivery(context: NativeSubsetContext, measurement: NativeMeasurement, cover: SourceSemanticLibraryPackage,
  receipt: Receipt, quiet: () => void, exhausted: boolean, delivery: DeliveryObservation) {
  let previousContinuation: NativeMeasurement["native"]["index"]["continuation"] = null;
  delivery.omitted_frozen_pages = measurement.plan.pages.length;
  const observe = (native: NativeMeasurement["native"], cost: NativeMeasurement["delivery_work"]) => {
    quiet();
    const index = delivery.observed_pages++, frozenPage = measurement.plan.pages[index]!;
    delivery.omitted_frozen_pages = measurement.plan.pages.length - delivery.observed_pages;
    const encoded = encodeSourceSemanticLibraryResponse(native);
    if (encoded.operation !== "recall") throw new Error("public recall expected");
    receipt(`page-${index + 1}-native`, native); receipt(`page-${index + 1}-public`, encoded);
    const exposure = measurement.exposure_pages[index]!;
    const coverIndex = frozenPage.indexOf(cover);
    const kind = coverIndex < 0 ? "no_cover" : frozenPage.length > 1 ? "mixed_cover"
      : native.index.continuation === null ? "cover_alone_final" : "cover_alone_continuing";
    if (kind !== "no_cover") delivery.emitted[kind] = "emitted";
    const observation = { page: index + 1, kind, delivery_id: native.delivery_id,
      previous_continuation: previousContinuation,
      frozen_plan_offset: measurement.plan.pages.slice(0, index).reduce((sum, page) => sum + page.length, 0),
      continuation: native.index.continuation, index: native.index, coverage: native.coverage, discovery: native.discovery,
      selected: frozenPage.map(row => packageRecord(row, cover)), encoded_bytes: Buffer.byteLength(JSON.stringify(encoded)),
      output_byte_limit: measurement.limit, result_budget_states: encoded.results?.map(row => row.budget_state),
      public_atomic_token_budget: 2_000, exposure, cost };
    delivery.observations.push(observation); receipt(`page-${index + 1}-observation`, observation);
    previousContinuation = native.index.continuation;
    if (coverIndex >= 0) {
      const entry = native.index.entries[coverIndex]!, result = encoded.results?.[coverIndex];
      expect(entry).toEqual(cover.entry); expect(entry.interpretation_node).toBeUndefined(); expect(entry.explanation_ids).toEqual([]);
      expect(result?.target).toEqual(cover.entry.target); expect(result?.content_preview).toBe(cover.preview);
      expect(sourceDisclosure(result!.source_disclosure!).proof_use).toEqual({ kind: "source_only", qualification: "not_current_proof" });
      const qualifiers = native.slot_qualifiers.filter(row => row.index === coverIndex);
      expect(qualifiers).toHaveLength(1); expect(qualifiers[0]?.evidence_kind).toBe("source_evidence");
      expect(qualifiers[0]?.witnesses).toBeUndefined(); expect(qualifiers[0]?.support).toBeUndefined();
      expect(qualifiers[0]?.conditional_computation_id).toBeUndefined();
      expect(qualifiers[0]?.source_interpretation_id).toBeUndefined();
      expect(qualifiers[0]?.query_semantics_id).toBeUndefined(); expect(qualifiers[0]?.semantic_correspondence_id).toBeUndefined();
      expect(sourceDisclosure(result!.source_disclosure!).source_binding).toBe("checked_record");
      expect(result?.budget_state.within_budget).toBe(true);
      const interval = exposure.position.intervals.find(row => row.root === physicalRoot(cover));
      expect(interval).toEqual({ root: physicalRoot(cover), start: 0, end: Buffer.byteLength(cover.preview) });
      expect(exposure.position.issues.filter(issue => issue.startsWith(`slot_${coverIndex}:`))).toEqual([]);
    }
  };
  if (exhausted) observe(measurement.native, measurement.delivery_work);
  else deliverAllPages(context, measurement, observe);
  return delivery;
}

/** Exactly one helper call containing exactly one prepareLibraryDelivery; no desired-subset probe. */
export function attemptWholeSourceCover(context: NativeSubsetContext, originals: readonly SourceSemanticLibraryPackage[],
  cover: SourceSemanticLibraryPackage, limit: number, order: DirectedOrder, receipt: Receipt, quiet: () => void) {
  const budget = observeNativeBudgets(), directed = directedSelector(order, cover, receipt, budget, quiet);
  const delivery: DeliveryObservation = { emitted: { mixed_cover: "not_emitted", cover_alone_continuing: "not_emitted",
    cover_alone_final: "not_emitted" }, observations: [], observed_pages: 0, omitted_frozen_pages: "not_measured" };
  let stage = "native_preparation_and_first_delivery";
  try {
    quiet();
    const measurement = measureNativeSubset(context, limit, undefined, [...originals, cover], directed.selector);
    stage = "delivery_observation";
    receipt("frozen-plan", measurement.plan);
    observeDelivery(context, measurement, cover, receipt, quiet, budget.refusals.length > 0, delivery);
    const exhausted = budget.refusals.length > 0;
    return { status: exhausted ? "resource_exhausted" : "observed", stop: exhausted, ...delivery,
      native_delivery: { coverage: measurement.native.coverage, discovery: measurement.native.discovery,
        preparation_work: measurement.preparation_work, preparation_phases: measurement.preparation_phases,
        selector_regions: measurement.selector_regions, budget_rejections: measurement.budget_rejections },
      budgets: budget.snapshot(), directed: directed.snapshot() };
  } catch (error) {
    const status = budget.refusals.length > 0 ? "resource_exhausted"
      : stage === "native_preparation_and_first_delivery" && error instanceof Error
        && (error.name === "ZodError" || "code" in error && ["VALIDATION", "CONFLICT", "OBLIGATION_VIOLATION"].includes(String(error.code)))
        ? "native_admission_rejected" : "unexpected_observation_error";
    return { status, stop: true, ...delivery, stage, error: errorRecord(error),
      budgets: budget.snapshot(), directed: directed.snapshot() };
  } finally { budget.restore(); }
}
