import { createHash, randomUUID } from "node:crypto";
import { CONDITIONAL_FIELD_SCHEMA_VERSION, InformationIndexSchema, sharedProductIdentity,
  productStateKeyFromIndexEntry, sourceEvidenceRootTarget, stableCanonicalStringify,
  type FieldSnapshot, type InformationIndex, type QueryInterpretation } from "@do-soul/alaya-protocol";
import { interpretationIdentity } from "../conditional-field/query/compile-query.js";
import { interpretationCoverageFor } from "../conditional-field/reference/interpret-query.js";
import { projectFieldDelta, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { orderedProjectionValues } from "../conditional-field/engine/field-solve.js";
import { projectAcceptingIndex } from "../conditional-field/index/project-accepting-index.js";
import { fieldProgressFingerprint } from "../conditional-field/index/facet-visit-accounting.js";
import { BoundedIndexPayload } from "./index-payload.js";
import { deliveredPayloadEntry, fieldResumeKey, issuedContinuationForState, issuedDeliveryRevoked,
  invalidateFieldDelivery, replayIssuedDelivery, replayIssuedIndex, resumeIndexProjection,
  observationSettled, facetIndexStillOpen, type ProjectionProgress } from "./index-continuation.js";
import { attachIndexSurfaces, replayIssuedSurfaces, retainAndIssueIndex, stageIssuedDelivery } from "./recall-index-commit.js";
import type { ConditionalFieldRecallRequest } from "./recall-service-runner-types.js";
import type { RequestCostLedger } from "./request-cost-ledger.js";
import { rolesFrom } from "./semantic-attribution.js";
import { governanceManifestationCeilings, governanceManifestationFor } from "./governance-manifestation.js";
import { continuationConsumerIdentity } from "./recall-consumer-compatibility.js";

const RESULT_VERSION = "v1";
type ProjectionContext = Readonly<{
  state: FieldEngineState; input: ConditionalFieldRecallRequest; interpretation: QueryInterpretation;
  snapshot: FieldSnapshot; payload: BoundedIndexPayload; projectionProgress: ProjectionProgress;
  queryKey: string; requestDigest: string; cost: RequestCostLedger;
  retain: ((state: FieldEngineState) => void) | undefined;
  restored?: FieldEngineState;
}>;

export function projectFromField(
  state: FieldEngineState,
  input: ConditionalFieldRecallRequest,
  interpretation: QueryInterpretation,
  retain: ((state: FieldEngineState) => void) | undefined,
  cost: RequestCostLedger,
  restored?: FieldEngineState
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
  const queryKey = fieldResumeKey(
    interpretation.query_id,
    interpretation.snapshot_id,
    interpretationIdentity({ interpretation_clock: interpretation.interpretation_clock })
  );
  const baseDigest = input.continuation == null ? `${queryKey}:root:${randomUUID()}` : input.continuation.continuation_id;
  const requestDigest = input.payload_continuation === undefined ? baseDigest
    : createHash("sha256").update(stableCanonicalStringify([baseDigest, input.payload_continuation])).digest("hex");
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
    attachIndexSurfaces(replayed, surface?.previews ?? new Map(), surface?.metadata ?? {});
    retain?.(retained);
    return replayed;
  }
  const payload = new BoundedIndexPayload({ sourceFacts: state.source_facts,
    previewCache: state.preview_cache, readers: input.readers, workspaceId: input.workspace_id,
    remainingMemoryBytes: state.remaining_memory_bytes, manifestationFor,
    ...(input.payload_continuation === undefined
      ? {}
      : { payloadContinuation: input.payload_continuation }) });
  const context = { state, input, interpretation, snapshot, payload, projectionProgress, queryKey, requestDigest, retain, cost, restored };
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
  const finalized = cost.time("payload", () => payload.finalize([entry],
    Math.min(state.remaining_reserve + state.remaining_exploration, input.budget.finalization_reserve)));
  const work = payload.takeNativeWork();
  cost.add("payload", { ...work, charged_retained_bytes: work.native_bytes, native_rows: 1 });
  const expanded = payload.applyDeliveredSpans({
    ...delivered.index,
    entries: [entry],
    continuation: input.continuation ?? null,
    page_purpose: "payload",
    product_updates: [],
    completeness: { ...delivered.index.completeness, payload: finalized.complete ? "complete" : "partial" }
  });
  attachIndexSurfaces(expanded, payload.previews, payload.sourceMetadata);
  stageIssuedDelivery(expanded, { query_key: queryKey, request_digest: requestDigest, request: input.continuation });
  retain?.({ ...state, remaining_memory_bytes: payload.remainingMemoryBytes,
    remaining_reserve: Math.min(state.remaining_reserve, finalized.remaining),
    remaining_exploration: Math.max(0, finalized.remaining - state.remaining_reserve) });
  return expanded;
}

function projectMembershipPage(context: ProjectionContext): InformationIndex {
  const { state, input, interpretation, snapshot, payload, queryKey, requestDigest, retain, cost, restored } = context;
  let retained = state;
  let projectionProgress = context.projectionProgress;
  const projected = cost.time("index", () => projectAcceptingIndex({
    snapshot,
    binding_contexts: state.binding_contexts,
    ordered_values: orderedProjectionValues(state),
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
      retained = { ...retained, remaining_reserve: Math.min(state.remaining_reserve, remaining),
        remaining_exploration: Math.max(0, remaining - state.remaining_reserve) };
    },
    support: state.support,
    expires_at: input.expires_at,
    as_of: input.as_of,
    lifetime_now: input.lifetime_now,
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes }),
    payload_work_per_entry: 5,
    // Truncated source chunks stay retryable so payload_continuation can fetch the next offset.
    finalize_payload: (entries, allowance) => cost.time("payload", () => {
      const result = payload.finalize(entries, allowance);
      const work = payload.takeNativeWork();
      cost.add("payload", { native_visits: work.native_visits, native_bytes: work.native_bytes,
        charged_retained_bytes: work.native_bytes, native_rows: entries.length });
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
    remaining_reserve: state.remaining_exploration + state.remaining_reserve,
    interpretation_id: interpretationIdentity({
      interpretation_clock: interpretation.interpretation_clock
    }),
    ...(interpretation.interpretation_clock === undefined
      ? {}
      : { interpretation_clock: interpretation.interpretation_clock }),
    payload_generation: interpretation.snapshot_id,
    ...((state.derivations?.length ?? 0) === 0 ? {} : { derivations: [...state.derivations] }),
    ...(state.support_work_status === undefined ? {} : { support_work_status: state.support_work_status }),
    ...(state.memory_exhausted || state.remaining_work.length > 0
      ? { resource_work: "open" as const }
      : {})
  }));
  const committed = retainAndIssueIndex({
    index: annotatePublicIndex(InformationIndexSchema.parse(projected), interpretation),
    projected,
    projectionProgress,
    state: retained,
    first_retention: state.projection_progress === undefined,
    payload,
    request: input,
    queryKey,
    requestDigest,
    close_when: (retained, index) => closeIdlePage(retained, index, input, restored)
  });
  retain?.(committed.retained);
  return committed.index;
}

function closeIdlePage(state: FieldEngineState, index: InformationIndex,
  input: ConditionalFieldRecallRequest, restored: FieldEngineState | undefined): boolean {
  if (index.entries.length !== 0) return false;
  if (input.budget.work_units <= 1) return true;
  return restored !== undefined && fieldProgressFingerprint(state) === fieldProgressFingerprint(restored)
    && observationSettled(state) && !facetIndexStillOpen(state);
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
