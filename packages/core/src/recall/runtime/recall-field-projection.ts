import { nativeNavigationProjection, type NativeFieldNavigation } from "./native-navigation-projection.js";
import { deliveryBudgetOf, fitProjectedRecallPage, framingReserve, framingInterruption, pageResourceRefusal,
  type RecallPageInterruption } from "./recall-page-fit.js";
import type { RecallProgressDelivery } from "./recall-progress-delivery.js";
import { ORDINARY_NATIVE_FIELD_RESULT_VERSION, SourceSemanticResourceLedger,
  CONDITIONAL_FIELD_SCHEMA_VERSION, InformationIndexSchema, sharedProductIdentity, indexEntryCacheKey,
  productStateKeyFromIndexEntry, sourceEvidenceRootTarget, stableCanonicalStringify,
  type FieldSnapshot, type InformationIndex, type QueryInterpretation } from "@do-soul/alaya-protocol";
import { interpretationIdentity } from "../conditional-field/query/compile-query.js";
import { interpretationCoverageFor } from "../conditional-field/reference/interpret-query.js";
import { projectFieldDelta, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { orderedProjectionValues } from "../conditional-field/engine/field-solve.js";
import { projectAcceptingIndex } from "../conditional-field/index/project-accepting-index.js";
import { fieldProgressFingerprint } from "../conditional-field/index/facet-visit-accounting.js";
import { BoundedIndexPayload } from "./index-payload.js";
import { deliveredPayloadEntry, recallDeliveryIdentity, issuedContinuationForState, issuedDeliveryRevoked,
  invalidateFieldDelivery, replayIssuedDelivery, replayIssuedIndex, resumeIndexProjection,
  observationSettled, facetIndexStillOpen, type ProjectionProgress } from "./index-continuation.js";
import { attachIndexSurfaces, commitPreparedIndex, prepareIndexCommit, prepareFittedProgressCommit, replayIssuedSurfaces,
  stageIssuedDelivery } from "./recall-index-commit.js";
import type { ConditionalFieldRecallRequest } from "./recall-service-runner-types.js";
import type { RequestCostLedger } from "./request-cost-ledger.js";
import { rolesFrom } from "./semantic-attribution.js";
import { governanceManifestationCeilings, governanceManifestationFor } from "./governance-manifestation.js";
import { continuationConsumerIdentity } from "./recall-consumer-compatibility.js";

const RESULT_VERSION = ORDINARY_NATIVE_FIELD_RESULT_VERSION;
const PAYLOAD_WORK_PER_ENTRY = 5;
type ProjectionContext = Readonly<{
  state: FieldEngineState; input: ConditionalFieldRecallRequest; interpretation: QueryInterpretation;
  snapshot: FieldSnapshot; payload: BoundedIndexPayload; projectionProgress: ProjectionProgress;
  queryKey: string; requestDigest: string; cost: RequestCostLedger;
  retain: ((state: FieldEngineState) => void) | undefined;
  restored?: FieldEngineState;
  /** Reused across shrink attempts so a failed fit does not re-order the same capture. */
  navigation?: NativeFieldNavigation;
  progress_delivery?: RecallProgressDelivery;
}>;

export function projectFromField(
  state: FieldEngineState,
  input: ConditionalFieldRecallRequest,
  interpretation: QueryInterpretation,
  retain: ((state: FieldEngineState) => void) | undefined,
  cost: RequestCostLedger,
  restored?: FieldEngineState,
  progressDelivery?: RecallProgressDelivery
): InformationIndex {
  const delta = projectFieldDelta(state);
  const snapshot = state.binding.kind === "bound"
    ? state.binding.snapshot
    : {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      snapshot_id: state.snapshot_id,
      query_id: state.query_id,
      seeds: [...state.seeds],
      values: [...delta.accepted_states],
      retained_transitions: [...state.transitions],
      facets: [...state.facets]
    };
  const ceilings = governanceManifestationCeilings(input.governance?.paths ?? []);
  const manifestationFor = (id: string) => input.governance === undefined ? "excerpt" as const
    : governanceManifestationFor(id, ceilings, input.governance.completeness === "complete"
      && !input.governance.temporal_uncertain);
  const retained = state;
  const projectionProgress = resumeIndexProjection(state, snapshot);
  const { query_key: queryKey, request_digest: requestDigest } = progressDelivery ?? recallDeliveryIdentity(input, interpretation);
  const issued = input.continuation == null ? undefined : replayIssuedDelivery(requestDigest);
  if (issued !== undefined) {
    const eligible = new Set(snapshot.values
      .filter((value) => value.accepting)
      .map((value) => sharedProductIdentity(value.state)));
    if (issuedDeliveryRevoked(issued, eligible)) {
      invalidateFieldDelivery(queryKey);
      return annotatePublicIndex(invalidatedPublicIndex(interpretation, input), interpretation);
    }
    const replayed = replayIssuedIndex(issued);
    const surface = replayIssuedSurfaces(requestDigest);
    // Identity deliberately excludes delivery allowance. Recheck the actual current
    // envelope, without rehydrating or recharging the retained page's old work.
    const meter = new SourceSemanticResourceLedger({
      work_units: state.remaining_exploration + state.remaining_reserve,
      memory_bytes: state.remaining_memory_bytes });
    let fitted;
    try {
      fitted = fitProjectedRecallPage({ index: replayed, previews: surface?.previews ?? new Map(),
        metadata: surface?.metadata ?? {}, request: input, request_digest: requestDigest, meter });
    } finally {
      cost.add("index", { budget_work: meter.spentWork, charged_retained_bytes: meter.spentBytes });
    }
    if (fitted.interruption !== undefined) throw framingInterruption(fitted.interruption);
    if (!fitted.fits || stableCanonicalStringify(fitted.index) !== stableCanonicalStringify(replayed)
      || replayed.entries.some(entry => fitted.previews.get(indexEntryCacheKey(entry))
        !== surface?.previews.get(indexEntryCacheKey(entry)))) {
      throw pageResourceRefusal({ message: "Recall replay cannot fit its unchanged public envelope",
        request: input, required_bytes: fitted.bytes });
    }
    attachIndexSurfaces(replayed, fitted.previews, surface?.metadata ?? {});
    retain?.({ ...retained, remaining_memory_bytes: meter.bytes, ...remainingWorkFields(retained, meter.work) });
    return replayed;
  }
  const payload = new BoundedIndexPayload({ sourceFacts: state.source_facts,
    previewCache: state.preview_cache, readers: input.readers, workspaceId: input.workspace_id,
    asOf: interpretation.interpretation_clock,
    contentByteBudget: deliveryBudgetOf(input).max_encoded_bytes,
    remainingMemoryBytes: state.remaining_memory_bytes, manifestationFor,
    ...(input.payload_continuation === undefined
      ? {}
      : { payloadContinuation: input.payload_continuation }) });
  const context = { state, input, interpretation, snapshot, payload, projectionProgress, queryKey, requestDigest, retain, cost, restored,
    progress_delivery: progressDelivery };
  return input.payload_continuation === undefined ? projectMembershipPage(context) : projectPayloadPage(context);
}

function projectPayloadPage(context: ProjectionContext): InformationIndex {
  const { state, input, interpretation, snapshot, payload, projectionProgress, queryKey, requestDigest, retain, cost } = context;
  if (input.payload_continuation === undefined) throw new Error("payload continuation required");
  const delivered = input.continuation == null ? undefined
    : deliveredPayloadEntry(queryKey, input.payload_continuation.target);
  const productId = delivered === undefined ? undefined : sharedProductIdentity(productStateKeyFromIndexEntry(delivered.entry));
  if (delivered === undefined || productId === undefined || !projectionProgress.delivered_entries[productId]
    || !snapshot.values.some((value) => value.accepting && sharedProductIdentity(value.state) === productId)) {
    return annotatePublicIndex(invalidatedPublicIndex(interpretation, input), interpretation);
  }
  const entry = { ...delivered.entry, target: delivered.entry.target.kind === "source_evidence"
    ? sourceEvidenceRootTarget(delivered.entry.target) : delivered.entry.target };
  const total = state.remaining_exploration + state.remaining_reserve;
  const allowance = Math.min(total, input.budget.finalization_reserve);
  const finalized = cost.time("payload", () => payload.finalize([entry], allowance));
  const work = payload.takeWork();
  cost.add("payload", { ...work, native_rows: 1 });
  const assembled = payload.applyDeliveredSpans({
    ...delivered.index,
    entries: [entry],
    continuation: input.continuation ?? null,
    page_purpose: "payload",
    product_updates: [],
    completeness: { ...delivered.index.completeness, payload: finalized.complete ? "complete" : "partial" }
  });
  // Hydration and the envelope fit share one request allowance: subtract the payload
  // spend first, then fit from what is left. The two must never be treated as
  // overlapping allowances whose larger value is retained.
  const payloadSpent = allowance - finalized.remaining;
  const fitted = fitPageEnvelope(context, assembled, Math.max(0, total - payloadSpent));
  // A work or memory interruption is an ordinary recoverable page: the membership,
  // its continuation and the incurred cost are retained so the caller can resume with
  // a larger budget. Only a page that kept failing to fit while work remained is a
  // deterministic encoded-size refusal.
  if (fitted.interruption !== undefined) {
    if (context.progress_delivery?.control !== undefined) {
      const control = context.progress_delivery.control;
      attachIndexSurfaces(control, new Map(), {});
      retain?.({ ...state, remaining_memory_bytes: fitted.remaining_memory_bytes,
        memory_exhausted: fitted.interruption === "memory", ...remainingWorkFields(state, fitted.remaining_work) });
      return control;
    }
    payload.remainingMemoryBytes = fitted.remaining_memory_bytes;
    const interrupted = withInterruptedPayload(assembled);
    const controlMeter = new SourceSemanticResourceLedger({ work_units: fitted.remaining_work,
      memory_bytes: fitted.remaining_memory_bytes });
    let control;
    try {
      control = fitProjectedRecallPage({ index: interrupted, previews: new Map(), metadata: {},
        request: input, request_digest: requestDigest, meter: controlMeter });
    } finally {
      cost.add("index", { budget_work: controlMeter.spentWork, charged_retained_bytes: controlMeter.spentBytes });
    }
    if (control.interruption !== undefined) throw framingInterruption(control.interruption);
    if (!control.fits) throw pageResourceRefusal({ message: "Recall interruption cannot fit its public envelope",
      request: input, required_bytes: control.bytes });
    payload.remainingMemoryBytes = controlMeter.bytes;
    attachIndexSurfaces(interrupted, new Map(), {});
    // An interrupted expansion delivers no membership, so it is not staged as an
    // issued page: replaying it would turn a resource interruption into a cached
    // refusal that a larger budget could never recover from.
    retain?.({ ...state, remaining_memory_bytes: payload.remainingMemoryBytes,
      memory_exhausted: fitted.interruption === "memory",
      ...remainingWorkFields(state, controlMeter.work) });
    return interrupted;
  }
  const expanded = fitted.index;
  attachIndexSurfaces(expanded, expanded === assembled ? payload.previews : fitted.previews, payload.sourceMetadata);
  stageIssuedDelivery(expanded, { query_key: queryKey, request_digest: requestDigest, request: input.continuation });
  retain?.({ ...state, remaining_memory_bytes: payload.remainingMemoryBytes,
    ...remainingWorkFields(state, fitted.remaining_work) });
  return expanded;
}

/** The source was already delivered, but this unfitted expansion exposed no bytes.
 * Keep its authorized retry token without claiming an unencoded support interval. */
function withInterruptedPayload(index: InformationIndex): InformationIndex {
  return { ...index, entries: index.entries.map(entry => entry.target.kind === "source_evidence"
    ? { ...entry, target: sourceEvidenceRootTarget(entry.target) } : entry),
    completeness: { ...index.completeness, payload: "interrupted", transport: "interrupted" },
    continuation: index.continuation ?? null };
}

/** One payload-envelope fit. Resource interruption and deterministic size refusal stay
 * separate facts: only a page that was actually encoded and still exceeds its declared
 * encoded allowance is terminal. */
function fitPageEnvelope(context: ProjectionContext, assembled: InformationIndex, work_units: number): Readonly<{
  index: InformationIndex; previews: ReadonlyMap<string, string>;
  interruption?: RecallPageInterruption; remaining_work: number; remaining_memory_bytes: number;
}> {
  const { input, payload, requestDigest, cost } = context;
  const meter = new SourceSemanticResourceLedger({ work_units, memory_bytes: payload.remainingMemoryBytes });
  let fitted;
  try {
    fitted = cost.time("index", () => fitProjectedRecallPage({ index: assembled, previews: payload.previews,
      metadata: payload.sourceMetadata, request: input, request_digest: requestDigest, meter }));
  } finally {
    cost.add("index", { budget_work: meter.spentWork, charged_retained_bytes: meter.spentBytes });
  }
  payload.remainingMemoryBytes = meter.bytes;
  if (fitted.interruption !== undefined) {
    return { index: assembled, previews: payload.previews, interruption: fitted.interruption,
      remaining_work: meter.work, remaining_memory_bytes: meter.bytes };
  }
  if (!fitted.fits) {
    throw pageResourceRefusal({ message: "Recall page cannot fit its required public envelope",
      request: input, required_bytes: fitted.bytes, result_count: fitted.result_count });
  }
  return { index: fitted.index, previews: fitted.previews,
    remaining_work: meter.work, remaining_memory_bytes: meter.bytes };
}

/** Preserve the resource split while carrying one cumulative remaining allowance. */
function remainingWorkFields(
  state: FieldEngineState, total: number
): Pick<FieldEngineState, "remaining_reserve" | "remaining_exploration"> {
  const reserve = Math.min(state.remaining_reserve, total);
  return { remaining_reserve: reserve, remaining_exploration: Math.max(0, total - reserve) };
}

function projectMembershipPage(context: ProjectionContext): InformationIndex {
  let current = context;
  let width = context.input.budget.page_budget;
  let droppedNonEmpty = false;
  let requiredMembershipBytes: number | undefined;
  for (;;) {
    const candidate = projectMembershipCandidate({ ...current,
      input: { ...current.input, budget: { ...current.input.budget, page_budget: width } } });
    // Assemble the final page (continuation, sealed token, hydrated visible spans)
    // before measuring it, so the fit sees exactly what the caller would receive.
    const prepared = prepareIndexCommit({
      index: candidate.index,
      projected: candidate.projected,
      projectionProgress: candidate.projectionProgress,
      state: candidate.retained,
      first_retention: candidate.first_retention,
      payload: candidate.payload,
      request: current.input,
      queryKey: context.queryKey,
      requestDigest: context.requestDigest,
      close_when: (retained, index) => candidate.navigation?.status !== "resource_refused"
        && closeIdlePage(retained, index, current.input, context.restored)
    });
    const available = candidate.retained.remaining_exploration + candidate.retained.remaining_reserve;
    // Delivery retention is already known, but not yet committed. Keep it out of
    // the codec allowance; a rejected/shrunk page releases this hold exactly once.
    const meter = new SourceSemanticResourceLedger({ work_units: available + candidate.framing,
      memory_bytes: candidate.payload.remainingMemoryBytes - prepared.retention_bytes });
    let fitted;
    try {
      fitted = context.cost.time("index", () => fitProjectedRecallPage({ index: prepared.index,
        previews: candidate.payload.previews, metadata: candidate.payload.sourceMetadata,
        request: current.input, request_digest: context.requestDigest, meter }));
    } finally {
      context.cost.add("index", { budget_work: meter.spentWork, charged_retained_bytes: meter.spentBytes });
    }
    candidate.payload.remainingMemoryBytes = meter.bytes + prepared.retention_bytes;
    // A refused fit is never a committed delivery, including an empty membership.
    // Resource interruption is separate from a measured oversized envelope.
    if (fitted.interruption !== undefined) {
      return commitInterruptedMembership(current, candidate, meter.work);
    }
    // Dropping every member of a nonempty page is a resource refusal, not a
    // valid-empty delivery: the field still holds undelivered membership.
    if (fitted.fits && !(droppedNonEmpty && prepared.index.entries.length === 0)) {
      const committed = commitPreparedIndex({ prepared: { ...prepared, retained: {
        ...prepared.retained, ...remainingWorkFields(prepared.retained, meter.work) } },
        index: fitted.index, previews: fitted.previews, payload: candidate.payload, cost: context.cost });
      context.retain?.(committed.retained);
      return committed.index;
    }
    if (candidate.index.entries.length > 0) {
      droppedNonEmpty = true;
      requiredMembershipBytes = fitted.bytes;
    }
    if (width === 0 || candidate.index.entries.length === 0 || fitted.result_count === 0) {
      throw pageResourceRefusal({ message: "Recall output budget cannot carry its required public envelope",
        request: current.input, required_bytes: requiredMembershipBytes ?? fitted.bytes });
    }
    // A failed fit commits nothing. Carry the post-fit remaining allowance into the
    // narrower retry so framing and hydration work is never restored or double-spent.
    width = Math.min(width - 1, fitted.result_count, candidate.index.entries.length - 1);
    current = { ...context, state: {
      ...candidate.retained, ...remainingWorkFields(candidate.retained, meter.work),
      remaining_memory_bytes: candidate.payload.remainingMemoryBytes },
      projectionProgress: context.projectionProgress, navigation: candidate.navigation };
  }
}

/** A resource interruption acknowledges computation, not an unfitted data page.
 * The zero-width projector owns its cursor and pending state. No candidate member,
 * revision, preview or explanation is issued. The replacement must itself pass the
 * same paid fit; otherwise refuse without consuming the incoming token.
 * A subsequent request follows the new token; retrying this acknowledged token
 * still replays the exact interrupted control result, as with other prepared pages.
 */
function commitInterruptedMembership(context: ProjectionContext,
  candidate: ReturnType<typeof projectMembershipCandidate>, remaining: number): InformationIndex {
  const paid = context.progress_delivery;
  if (paid?.control !== undefined) {
    const prepared = prepareFittedProgressCommit({ index: paid.control,
      state: { ...candidate.retained, ...remainingWorkFields(candidate.retained, remaining) },
      // Facet preparation is computation even when the candidate cannot ship.
      // Only an empty candidate may advance its scan past nonmembers; unfitted
      // members/updates must remain behind the acknowledged frontier.
      progress: { ...context.projectionProgress,
        facet_index: candidate.projectionProgress.facet_index ?? context.projectionProgress.facet_index,
        ...(candidate.index.entries.length === 0 && (candidate.index.product_updates?.length ?? 0) === 0
          ? { offset: candidate.projectionProgress.offset, facet_offset: candidate.projectionProgress.facet_offset } : {}) },
      first_retention: candidate.first_retention,
      generation: paid.control_generation!, available_bytes: candidate.payload.remainingMemoryBytes,
      queryKey: context.queryKey, requestDigest: context.requestDigest, request: context.input.continuation });
    const committed = commitPreparedIndex({ prepared, index: paid.control, previews: new Map(),
      payload: candidate.payload, cost: context.cost });
    context.retain?.(committed.retained);
    return committed.index;
  }
  const control = projectMembershipCandidate({ ...context,
    state: { ...candidate.retained, ...remainingWorkFields(candidate.retained, 0) },
    input: { ...context.input, budget: { ...context.input.budget, page_budget: 0 } },
    navigation: candidate.navigation,
    projectionProgress: context.projectionProgress });
  const index = { ...control.index, entries: [], product_updates: [], explanations: [],
    completeness: { ...control.index.completeness, transport: "interrupted" as const, payload: "interrupted" as const } };
  const prepared = prepareIndexCommit({ index, projected: index, projectionProgress: context.projectionProgress,
    state: { ...control.retained, ...remainingWorkFields(control.retained, remaining) },
    first_retention: control.first_retention, payload: control.payload, request: context.input,
    queryKey: context.queryKey, requestDigest: context.requestDigest,
    close_when: (state, page) => context.projectionProgress.offset >= context.snapshot.values.length
      && closeIdlePage(state, page, context.input, context.restored) });
  const meter = new SourceSemanticResourceLedger({ work_units: remaining,
    memory_bytes: control.payload.remainingMemoryBytes - prepared.retention_bytes });
  let fitted;
  try {
    fitted = fitProjectedRecallPage({ index: prepared.index, previews: new Map(), metadata: {},
      request: context.input, request_digest: context.requestDigest, meter });
  } finally {
    context.cost.add("index", { budget_work: meter.spentWork, charged_retained_bytes: meter.spentBytes });
  }
  if (fitted.interruption !== undefined) throw framingInterruption(fitted.interruption);
  if (!fitted.fits) throw pageResourceRefusal({ message: "Recall interruption cannot fit its public envelope",
    request: context.input, required_bytes: fitted.bytes });
  control.payload.remainingMemoryBytes = meter.bytes + prepared.retention_bytes;
  const committed = commitPreparedIndex({ prepared: { ...prepared, retained: {
    ...prepared.retained, ...remainingWorkFields(prepared.retained, meter.work) } },
    index: fitted.index, previews: fitted.previews, payload: control.payload, cost: context.cost });
  attachIndexSurfaces(committed.index, new Map(), {});
  context.retain?.(committed.retained);
  return committed.index;
}

function prepareMembershipNavigation(context: ProjectionContext) {
  const { state, input, interpretation, snapshot, payload, cost, projectionProgress } = context;
  // Reserve codec entry before projection. The incremental envelope scan may
  // still interrupt on additional work; a retry never restores spent allowance.
  const available = state.remaining_exploration + state.remaining_reserve;
  const navigationMeter = new SourceSemanticResourceLedger({
    work_units: available, memory_bytes: payload.remainingMemoryBytes });
  // Navigation coordinates captured source and memory membership. Without any
  // captured source, or after the membership scan is consumed, there is no new
  // cross-lane order to compute. Keep the field's existing order and revisions.
  //
  // The order is recomputed from this page's own values and ordering inputs. A
  // retained order is not a safe cache: access coordinates stay stable while a
  // value's activation, bounds or identity can change between pages, so replaying
  // an earlier order would deliver a superseded value. Within one page the shrink
  // retries reuse the order they just measured (`context.navigation`).
  let navigation: NativeFieldNavigation | undefined;
  try {
    navigation = interpretation.view.enumeration_policy === "native_query"
      && interpretation.view.result_kind_view !== "memory_only"
      && ((state.native_sources?.admitted_roots?.length ?? state.native_sources?.result?.nominations.length ?? 0) > 0)
      && projectionProgress.offset < snapshot.values.length
      ? context.navigation
        ?? cost.time("index", () => nativeNavigationProjection(state, snapshot.values, navigationMeter)) : undefined;
  } finally {
    payload.remainingMemoryBytes = navigationMeter.bytes;
    cost.add("index", { budget_work: navigationMeter.spentWork, charged_retained_bytes: navigationMeter.spentBytes });
  }
  // Ordering is paid before projection and framing, including failed attempts.
  const framing = Math.min(framingReserve(input.budget.page_budget), navigationMeter.work);
  return { navigation, framing, remaining: navigationMeter.work };
}

function projectMembershipCandidate(context: ProjectionContext) {
  const { state, input, interpretation, snapshot, payload, cost } = context;
  const { navigation, framing, remaining } = prepareMembershipNavigation(context);
  // Rejected/empty projection can return before its remaining-work callback.
  // Keep the framing hold in that path too; adding it back must not double it.
  let retained = { ...state, ...remainingWorkFields(state, remaining - framing),
    remaining_memory_bytes: payload.remainingMemoryBytes };
  let projectionProgress = context.projectionProgress;
  const projected = cost.time("index", () => projectAcceptingIndex({
    snapshot,
    binding_contexts: state.binding_contexts,
    // Native navigation owns the order only when it actually produced one. Without
    // it, keep the accepted canonical observation order instead of the identity
    // index order (which follows arrival sequence).
    ordered_values: navigation?.values ?? orderedProjectionValues(state),
    navigationFor: navigation?.witnessFor,
    view: interpretation.view,
    query_id: interpretation.query_id,
    snapshot_id: interpretation.snapshot_id,
    result_version: RESULT_VERSION,
    budget: input.budget,
    cost,
    projection_scan_offset: projectionProgress.offset,
    projection_generation: projectionProgress.generation,
    projection_facet_offset: projectionProgress.facet_offset,
    projection_facet_index: projectionProgress.facet_index,
    delivered_product_ids: new Set(Object.keys(projectionProgress.delivered_entries)),
    delivered_entry_revisions: projectionProgress.delivered_entries,
    delivered_product_states: projectionProgress.delivered_products,
    on_projection_progress: (offset, facet) => {
      projectionProgress = { ...projectionProgress, offset,
        ...(facet === undefined ? {} : { facet_offset: facet.scan_offset, facet_index: facet.index }) };
    },
    explanation_progress: state.explanation_progress,
    on_explanation_progress: (progress, retainedBytes, work) => {
      payload.remainingMemoryBytes = Math.max(0, payload.remainingMemoryBytes - retainedBytes);
      cost.add("index", { charged_retained_bytes: retainedBytes });
      retained = { ...retained, explanation_progress: progress,
        explanation_completed_work: (retained.explanation_completed_work ?? 0) + work,
        remaining_memory_bytes: payload.remainingMemoryBytes };
    },
    roles: rolesFrom(state),
    claims: state.claims,
    claim_propositions: state.claim_propositions,
    transition_derivations: state.transition_derivations,
    grounding_progress: state.grounding_progress,
    remaining_memory_bytes: payload.remainingMemoryBytes,
    grounding_transitions: [...state.transitions],
    grounding_seeds: [...state.seeds],
    grounding_derivations: [...state.derivations],
    projection_facets: [...state.facets],
    on_grounding_progress: (progress, retainedBytes) => {
      payload.remainingMemoryBytes = Math.max(0, payload.remainingMemoryBytes - retainedBytes);
      retained = { ...retained, grounding_progress: progress, remaining_memory_bytes: payload.remainingMemoryBytes };
      projectionProgress = resumeIndexProjection(retained, snapshot);
    },
    on_remaining_reserve: (remaining) => {
      retained = { ...retained, ...remainingWorkFields(state, remaining) };
    },
    support: state.support,
    expires_at: input.expires_at,
    as_of: input.as_of,
    lifetime_now: input.lifetime_now,
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes }),
    payload_work_per_entry: PAYLOAD_WORK_PER_ENTRY,
    // Truncated source chunks stay retryable so payload_continuation can fetch the next offset.
    finalize_payload: (entries, allowance) => cost.time("payload", () => {
      const result = payload.finalize(entries, allowance);
      const work = payload.takeWork();
      cost.add("payload", { native_visits: work.native_visits, native_bytes: work.native_bytes,
        charged_retained_bytes: work.charged_retained_bytes, native_rows: entries.length });
      return result;
    }),
    prior_continuation: input.continuation == null
      ? null
      : issuedContinuationForState(state) ?? input.continuation,
    observer: {
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: state.closure.observation },
      open_regions: state.residuals
    },
    resume_cursors: state.resume_cursors,
    interpretation_status: interpretation.status,
    remaining_reserve: remaining - framing,
    interpretation_id: interpretationIdentity({
      interpretation_clock: interpretation.interpretation_clock
    }),
    ...(interpretation.interpretation_clock === undefined
      ? {}
      : { interpretation_clock: interpretation.interpretation_clock }),
    payload_generation: interpretation.snapshot_id,
    ...((state.derivations?.length ?? 0) === 0 ? {} : { derivations: [...state.derivations] }),
    ...(state.support_work_status === undefined ? {} : { support_work_status: state.support_work_status }),
    ...(navigation?.status === "resource_refused" || state.memory_exhausted || state.remaining_work.length > 0
      ? { resource_work: "open" as const }
      : {})
  }));
  return { index: annotatePublicIndex(InformationIndexSchema.parse(
    withNavigationOrder(projected, navigation)), interpretation),
  projected, navigation, projectionProgress, payload, framing,
  retained: { ...retained, remaining_memory_bytes: payload.remainingMemoryBytes },
  first_retention: state.projection_progress === undefined };
}

/** A bound root without a captured catalog position leaves navigation non-total.
 * That is an ordering incompleteness, never an exhausted resource: the existing
 * order closure and resource-open flag stay independent facts.
 */
function withNavigationOrder(
  projected: InformationIndex,
  navigation: NativeFieldNavigation | undefined
): InformationIndex {
  if (navigation?.status !== "non_total") return projected;
  if (projected.order_status !== "complete" && projected.order_status !== "certified_prefix") return projected;
  const { certificate_id: _certificate, ...completeness } = projected.completeness;
  return { ...projected, order_status: "partial", completeness: { ...completeness, order_coverage: "open" } };
}

function closeIdlePage(state: FieldEngineState, index: InformationIndex,
  input: ConditionalFieldRecallRequest, restored: FieldEngineState | undefined): boolean {
  if (index.entries.length !== 0 || (index.product_updates?.length ?? 0) !== 0) return false;
  if (input.budget.work_units <= 1) return true;
  if (restored === undefined || fieldProgressFingerprint(state) !== fieldProgressFingerprint(restored)) return false;
  // Keep the first resource interruption recoverable. A consumed continuation
  // that cannot advance under the same budget ends with its residual intact.
  const repeatedMemoryBlock = state.memory_exhausted && restored.memory_exhausted
    && stableCanonicalStringify(state.budget) === stableCanonicalStringify(restored.budget);
  return repeatedMemoryBlock || (observationSettled(state) && !facetIndexStillOpen(state));
}

export function annotatePublicIndex(
  index: InformationIndex,
  interpretation: QueryInterpretation
): InformationIndex {
  const interpretationId = interpretationIdentity({ interpretation_clock: interpretation.interpretation_clock });
  const coverage = interpretationCoverageFor(interpretation.status, interpretation);
  const completeness = index.completeness.interpretation_coverage === undefined
    ? { ...index.completeness, interpretation_coverage: coverage }
    : index.completeness;
  const continuation = index.continuation === null
    ? null
    : {
      ...index.continuation,
      interpretation_id: index.continuation.interpretation_id ?? interpretationId,
      interpretation_clock: index.continuation.interpretation_clock
        ?? interpretation.interpretation_clock,
      enumeration_policy: index.continuation.enumeration_policy
        ?? interpretation.view.enumeration_policy,
      result_kind_view: index.continuation.result_kind_view
        ?? interpretation.view.result_kind_view,
      ...(index.continuation.authorized_scopes === undefined ? {} : {
        authorized_scopes: index.continuation.authorized_scopes
      }),
      ...(index.continuation.cap_contracts === undefined && interpretation.view.cap_contracts === undefined
        ? {}
        : { cap_contracts: index.continuation.cap_contracts ?? interpretation.view.cap_contracts }),
      ...(index.continuation.claim_demands === undefined && interpretation.view.claim_demands === undefined
        ? {}
        : { claim_demands: index.continuation.claim_demands ?? interpretation.view.claim_demands }),
      ...continuationConsumerIdentity(index.continuation, interpretation.view)
    };
  return { ...index, completeness, continuation, interpretation_id: interpretationId,
    as_of: interpretation.interpretation_clock };
}

export function invalidatedPublicIndex(
  interpretation: QueryInterpretation,
  input: ConditionalFieldRecallRequest
): InformationIndex {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: interpretation.query_id,
    snapshot_id: interpretation.snapshot_id,
    result_version: RESULT_VERSION,
    entries: [],
    completeness: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      logical_index: "invalidated",
      observed_coverage: "invalidated",
      interpretation_coverage: interpretationCoverageFor(interpretation.status, interpretation),
      transport: "invalidated",
      payload: "invalidated",
      representation: "invalidated"
    },
    continuation: null,
    representation: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      policy: "construct_index_then_page_then_payload",
      page_budget: input.budget.page_budget,
      identity_tie_break: "serialization"
    }
  };
}
