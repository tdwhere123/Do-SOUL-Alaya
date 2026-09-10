import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  BOUNDED_DEFAULT_ARRAY_MAX,
  MILLIGRADE_BOTTOM,
  canonicalIndexEntryIdentity,
  productStateKeyFromIndexEntry,
  productSubjectId,
  reachableMilligradesOf,
  type ClaimState,
  type Continuation,
  type Derivation,
  type EnumerationPolicy,
  type FacetMode,
  type FacetVector,
  type FieldSnapshot,
  type FieldValue,
  type IndexEntry,
  type IndexRole,
  type InformationIndex,
  type QueryInterpretationStatus,
  type QueryView,
  type Proposition,
  type RequestBudget,
  type SupportRecord
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../../shared/errors.js";
import { compareText } from "../../../shared/compare-text.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import { composedFacetPathId, facetBelongsToOutput } from "../engine/path-composition.js";
import { groundedOutputDerivations, type GroundingProgress } from "../engine/output-derivations.js";
import { productStateNodeId, productIndexOrderKey } from "../reference/bind-max-min.js";
import { traceDerivationForest } from "../engine/derivation-provenance.js";
import { ExplanationDelivery, type ProjectedPage } from "./explanation-delivery.js";
import type { RetainedRows } from "../engine/retained-sequence.js";
import {
  admitIndexBudget,
  completenessForInterpretationStatus,
  composeCompleteness,
  continuationInvalidated,
  invalidatedCompleteness,
  resourceRejectedCompleteness,
  sufficientAlternatePaths,
  type ObserverCoverage
} from "./completeness.js";
import {
  explanationIdsForEntry,
  recoverExplanationForest,
  mixedPayloadGeneration,
  omittedStructuredPayload
} from "./explanation.js";

export type { ObserverCoverage } from "./completeness.js";
export {
  outputAttributionHandle,
  selectFeasibleWitnesses,
  witnessAttributionHandle
} from "./explanation.js";

export type AcceptingProjectionInput = Readonly<{
  readonly snapshot: FieldSnapshot;
  readonly ordered_values?: Readonly<{ size: number; at(index: number): FieldValue | undefined }>;
  readonly view: QueryView;
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly result_version: string;
  readonly budget: RequestBudget;
  readonly roles?: Readonly<{ get(id: string): IndexRole | undefined }>;
  readonly claims?: ReadonlyMap<string, ClaimState>;
  readonly support?: readonly SupportRecord[];
  readonly page_offset?: number;
  readonly projection_scan_offset?: number;
  readonly projection_generation?: number;
  readonly delivered_product_ids?: ReadonlySet<string>;
  readonly delivered_entry_revisions?: Readonly<Record<string, string>>;
  readonly on_projection_progress?: (offset: number) => void;
  readonly on_semantic_entries?: (entries: readonly IndexEntry[]) => void;
  readonly explanation_progress?: ExplanationDelivery;
  readonly on_explanation_progress?: (progress: ExplanationDelivery | undefined, retainedBytes: number, work: number) => void;
  readonly expires_at?: string;
  readonly as_of?: string;
  readonly lifetime_now?: string;
  readonly prior_continuation?: Continuation | null;
  readonly observer?: ObserverCoverage;
  readonly interpretation_status?: QueryInterpretationStatus;
  readonly interpretation_id?: string;
  readonly interpretation_clock?: string;
  readonly model_id?: string;
  readonly derivations?: readonly Derivation[];
  readonly derivation_forest?: ReadonlyMap<string, Derivation>;
  readonly output_derivation_roots?: ReadonlyMap<string, readonly string[]>;
  readonly output_derivations?: Readonly<Record<string, readonly string[]>>;
  readonly transition_derivations?: import("../engine/path-derivation.js").DerivationRootLookup;
  readonly grounding_progress?: GroundingProgress;
  readonly grounding_transitions?: RetainedRows<FieldSnapshot["retained_transitions"][number]>;
  readonly grounding_seeds?: RetainedRows<FieldSnapshot["seeds"][number]>;
  readonly grounding_derivations?: RetainedRows<Derivation>;
  readonly projection_facets?: RetainedRows<FacetVector>;
  readonly grounding_complete?: boolean;
  readonly remaining_memory_bytes?: number;
  readonly on_grounding_progress?: (progress: GroundingProgress, retainedBytes: number) => void;
  readonly claim_propositions?: ReadonlyMap<string, Proposition>;
  readonly on_remaining_reserve?: (remaining: number) => void;
  readonly finalize_payload?: (entries: readonly IndexEntry[], remaining: number) => {
    readonly remaining: number; readonly complete: boolean; readonly retryable?: boolean };
  readonly payload_work_per_entry?: number;
  readonly payload_generation?: string;
  readonly relation_facet_modes?: ReadonlyMap<string, FacetMode>;
  readonly expand_payload?: boolean;
  readonly resume_cursors?: Readonly<Record<string, string | null>>;
  readonly support_work_status?: "complete" | "open";
  readonly remaining_reserve?: number;
  readonly resource_work?: "complete" | "open";
  readonly payload_work?: "complete" | "open";
}>;

const OFFSET_CURSOR = /^offset-(\d+)$/u;
const RESUME_CURSOR = /^o(\d+)(?:\|(.*))?$/u;
const PROJECTION_CURSOR = /^p(\d+)(?:g(\d+))?(?:r(\d+))?(?:e(\d+))?$/u;
const REPRESENTATION_POLICY = "construct_index_then_page_then_payload" as const;
const MAX_PAYLOAD_MEMORY_BYTES = 16_384;

export function evaluateSamePathPredicate(
  vectors: readonly FacetVector[],
  threshold: number
): boolean {
  return vectors.some((vector) => vector.coordinates.every((value) => value > threshold));
}

export function evaluateFacetPredicate(
  mode: FacetMode,
  vectors: readonly FacetVector[],
  threshold: number
): boolean {
  if (mode === "same_path") return evaluateSamePathPredicate(vectors, threshold);
  return independentFacetPredicate(vectors, threshold);
}

export function projectAcceptingIndex(input: AcceptingProjectionInput): InformationIndex {
  const representation = representationDecision(input.budget.page_budget);
  const interpretationId = resolveInterpretationId(input);
  const epochInput = { ...input, interpretation_id: interpretationId };
  if (continuationInvalidated(epochInput) || continuationCursorInvalid(input)
    || continuationPolicyMismatch(input)) {
    return closedIndex(epochInput, representation, invalidatedCompleteness());
  }
  if (input.ordered_values === undefined && (input.view.enumeration_policy ?? "canonical") === "associative") {
    assertAssociativeMilligradeContract(input.snapshot.values);
  }
  const admission = input.interpretation_status === undefined
    ? undefined
    : completenessForInterpretationStatus(input.interpretation_status);
  if (admission !== undefined) return closedIndex(epochInput, representation, admission);
  if (admitIndexBudget(input.budget) === "resource_rejected") {
    return closedIndex(epochInput, representation, resourceRejectedCompleteness());
  }
  return pageAcceptingIndex(epochInput, representation);
}

export function continueAcceptingIndex(
  previous: InformationIndex,
  input: Omit<AcceptingProjectionInput, "query_id" | "snapshot_id" | "result_version" | "prior_continuation">
): InformationIndex {
  if (previous.continuation === null) {
    return closedIndex({
      query_id: previous.query_id,
      snapshot_id: previous.snapshot_id,
      result_version: previous.result_version
    }, previous.representation, invalidatedCompleteness());
  }
  return projectAcceptingIndex({
    ...input,
    query_id: previous.query_id,
    snapshot_id: previous.snapshot_id,
    result_version: previous.result_version,
    prior_continuation: previous.continuation,
    interpretation_id: input.interpretation_id ?? previous.continuation.interpretation_id
  });
}

function pageAcceptingIndex(
  input: AcceptingProjectionInput,
  representation: InformationIndex["representation"]
): InformationIndex {
  if (input.explanation_progress !== undefined) return finalizeIndexPage(input, representation,
    input.explanation_progress.page, input.remaining_reserve ?? input.budget.finalization_reserve, true);
  if (input.transition_derivations !== undefined && input.output_derivations === undefined && input.output_derivation_roots === undefined) {
    const allowance = input.remaining_reserve ?? input.budget.finalization_reserve;
    const deliveryWork = 1 + (input.finalize_payload === undefined ? 0 : input.payload_work_per_entry ?? 1);
    // Preserve one delivery opportunity when grounding can still advance; smaller requests resume after grounding.
    const groundingAllowance = allowance > deliveryWork ? allowance - deliveryWork : allowance;
    const availableMemory = input.remaining_memory_bytes ?? input.budget.memory_bytes;
    const payloadMemory = input.finalize_payload === undefined ? 0
      : Math.min(MAX_PAYLOAD_MEMORY_BYTES, Math.floor(availableMemory / 4));
    const grounded = groundedOutputDerivations({ seeds: input.grounding_seeds ?? input.snapshot.seeds,
      transitions: input.grounding_transitions ?? input.snapshot.retained_transitions,
      derivations: input.grounding_derivations ?? input.derivations ?? [],
      transition_derivations: input.transition_derivations,
      progress: input.grounding_progress, memory_bytes: availableMemory - payloadMemory,
      allowance: groundingAllowance });
    input.on_grounding_progress?.(grounded.progress, grounded.retained_bytes);
    input = { ...input, derivation_forest: grounded.progress.forest, output_derivation_roots: grounded.progress.root_map, grounding_progress: grounded.progress,
      grounding_complete: grounded.complete,
      ...(grounded.work > 0 && input.delivered_product_ids !== undefined ? { projection_scan_offset: 0 } : {}),
      remaining_reserve: allowance - grounded.work,
      ...(!grounded.complete ? { resource_work: "open" } : {}) };
  }
  const projected = acceptingEntries(input);
  const entries = sortEntries(projected.entries, input.view.enumeration_policy ?? "canonical");
  if (continuationPrefixUnverified(input, entries, projected.truncated)) {
    input.on_remaining_reserve?.(projected.remaining);
    return { ...closedIndex(input, representation, indexCompleteness(input, {
      total: entries.length, remaining: 1, omitted_payload: false,
      expand_payload: input.expand_payload !== false, resource_work: "open"
    })),
      continuation: input.prior_continuation ?? null };
  }
  if (continuationSetMismatch(input, entries)) {
    return closedIndex(input, representation, invalidatedCompleteness());
  }
  input.on_projection_progress?.(projected.next);
  const offset = resolvePageOffset(input, entries.length);
  const page = entries.slice(offset, offset + input.budget.page_budget);
  const remaining = Math.max(projected.truncated ? 1 : 0, entries.length - offset - page.length);
  return finalizeIndexPage(input, representation, { entries, page, offset, remaining,
    next: projected.next, truncated: projected.truncated }, projected.remaining);
}

function finalizeIndexPage(input: AcceptingProjectionInput, representation: InformationIndex["representation"],
  projected: ProjectedPage, allowance: number, proofOnly = false): InformationIndex {
  const { entries, offset, remaining } = projected;
  let page = proofOnly ? [] : projected.page;
  let proofRemaining = allowance;
  let explanations: readonly Derivation[];
  let proofOmitted = false;
  let proofOpen = false;
  if (input.on_explanation_progress !== undefined && (input.explanation_progress !== undefined || input.derivation_forest !== undefined)) {
    const cursor = input.explanation_progress ?? new ExplanationDelivery(projected, input.derivation_forest!);
    const reserve = page.length * (input.finalize_payload === undefined ? 0 : input.payload_work_per_entry ?? 1);
    const proof = cursor.advance(Math.max(0, allowance - reserve), input.remaining_memory_bytes ?? input.budget.memory_bytes);
    proofRemaining -= proof.work;
    if (!proof.complete && !proof.invalid && !proof.capacity_limited) {
      input.on_explanation_progress(cursor, proof.bytes, proof.work);
      input = { ...input, explanation_progress: cursor };
      explanations = [];
      proofOmitted = true;
      proofOpen = true;
    } else {
      input.on_explanation_progress(undefined, proof.bytes - cursor.retainedBytes, proof.work);
      explanations = proof.explanations;
      proofOmitted = proof.invalid || proof.capacity_limited;
      if (proofOmitted) page = page.map((entry) => ({ ...entry, explanation_ids: [] }));
    }
  } else if (input.derivation_forest !== undefined) {
    const roots = page.flatMap((entry) => entry.explanation_ids);
    // Traversal and serialization each pay their own node/edge visits.
    const traced = traceDerivationForest({ forest: input.derivation_forest, roots,
      maxVisits: Math.floor(Math.max(0, proofRemaining - page.length * (input.finalize_payload === undefined ? 0 : input.payload_work_per_entry ?? 1)) / 2) });
    proofRemaining -= traced.work;
    if (traced.complete && traced.traversal.nodes.size <= proofRemaining) {
      explanations = [...traced.traversal.nodes.values()];
      proofRemaining -= explanations.length;
    } else {
      explanations = [];
      proofOmitted = roots.length > 0;
      page = page.map((entry) => ({ ...entry, explanation_ids: [] }));
    }
  } else explanations = recoverExplanationForest(page.flatMap((entry) => entry.explanation_ids), input.derivations ?? []);
  if (explanations.length > BOUNDED_DEFAULT_ARRAY_MAX) {
    explanations = []; proofOmitted = true;
    page = page.map((entry) => ({ ...entry, explanation_ids: [] }));
  }
  const proofUpdates = proofOnly && !proofOpen && !proofOmitted ? projected.page.flatMap((entry) =>
    entry.explanation_ids.map((root) => ({ schema_version: 1 as const,
      product: productStateKeyFromIndexEntry(entry), update_kind: "proof" as const,
      revision: root, previous_revision: indexEntryRevision(entry) }))) : [];
  if (proofUpdates.length > BOUNDED_DEFAULT_ARRAY_MAX) {
    explanations = []; proofOmitted = true;
  }
  if (!proofOnly) input.on_semantic_entries?.(projected.page);
  const finalized = input.finalize_payload?.(page, proofRemaining);
  const retryPayload = finalized !== undefined && !finalized.complete && finalized.retryable !== false;
  if (finalized !== undefined) input = { ...input, payload_work: finalized.complete ? "complete" : "open" };
  input.on_remaining_reserve?.(finalized?.remaining ?? proofRemaining);
  const mixedPayload = mixedPayloadGeneration(input.snapshot_id, input.payload_generation);
  const expandPayload = input.expand_payload !== false && !mixedPayload;
  const omittedPayload = mixedPayload || proofOmitted || input.payload_work === "open"
    || (input.derivation_forest === undefined && input.explanation_progress === undefined && expandPayload && omittedStructuredPayload(
      input.support,
      input.derivations,
      input.budget.page_budget
    ));
  const resourceOpen = projected.truncated || input.resource_work === "open" || proofOpen;
  const completeness = indexCompleteness(input, {
    total: entries.length + (input.delivered_product_ids?.size
      ?? Number(PROJECTION_CURSOR.exec(input.prior_continuation?.cursor ?? "")?.[1] ?? 0)),
    remaining,
    omitted_payload: omittedPayload,
    expand_payload: expandPayload,
    ...(mixedPayload ? { mixed_generation: true } : {}),
    ...(input.support_work_status === undefined ? {} : { explanation_work: input.support_work_status }),
    ...(resourceOpen ? { resource_work: "open" as const } : {})
  });
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    entries: page,
    explanations,
    completeness,
    continuation: nextContinuation({ ...input, ...(resourceOpen || retryPayload ? { resource_work: "open" } : {}) },
      remaining, retryPayload ? offset : offset + page.length, entries,
      retryPayload ? Number(PROJECTION_CURSOR.exec(input.prior_continuation?.cursor ?? "")?.[1] ?? 0)
        : projected.truncated || input.delivered_product_ids !== undefined
          || PROJECTION_CURSOR.test(input.prior_continuation?.cursor ?? "") ? projected.next : undefined),
    representation,
    page_purpose: proofOnly ? "payload" : "membership",
    ...(proofOnly && !proofOpen && !proofOmitted ? { product_updates: proofUpdates } : {}),
    order_status: remaining > 0 || resourceOpen || completeness.order_coverage !== "complete" ? "open" : "complete"
  };
}

function indexCompleteness(
  input: AcceptingProjectionInput,
  extra: Parameters<typeof composeCompleteness>[0]
): ReturnType<typeof composeCompleteness> {
  const residuals = extra.residuals ?? input.observer?.open_regions ?? [];
  return composeCompleteness({
    observer: input.observer,
    interpretation_status: input.interpretation_status,
    query_id: input.query_id,
    residuals,
    sufficient_alternate_paths: extra.sufficient_alternate_paths ?? sufficientAlternatePaths(residuals),
    ...extra
  });
}

function acceptingEntries(
  input: AcceptingProjectionInput
): { readonly entries: IndexEntry[]; readonly truncated: boolean; readonly next: number; readonly remaining: number } {
  const entries: IndexEntry[] = [];
  let allowance = input.remaining_reserve ?? input.budget.finalization_reserve;
  let truncated = false;
  let groundingDeferred = false;
  const start = input.projection_scan_offset
    ?? Number(PROJECTION_CURSOR.exec(input.prior_continuation?.cursor ?? "")?.[1] ?? 0);
  const legacyValues = input.ordered_values === undefined
    ? [...input.snapshot.values].sort((a, b) => compareText(valueSortKey(a), valueSortKey(b))) : undefined;
  const values = input.ordered_values ?? { size: legacyValues!.length, at: (index: number) => legacyValues![index] };
  const payloadWork = input.finalize_payload === undefined ? 0 : input.payload_work_per_entry ?? 1;
  const pageLimited = input.projection_scan_offset !== undefined || input.delivered_product_ids !== undefined
    || input.delivered_entry_revisions !== undefined || input.grounding_complete === false
    || PROJECTION_CURSOR.test(input.prior_continuation?.cursor ?? "")
    || allowance < values.size * (1 + payloadWork);
  const pageEnd = resolvePageOffset(input, values.size) + input.budget.page_budget;
  if (input.budget.page_budget === 0 && pageLimited) {
    return { entries, truncated: start < values.size, next: start, remaining: allowance };
  }
  let next = start;
  for (let index = start; index < values.size; index += 1) {
    // Retained outputs own their payload reserve; another candidate may need
    // the same reserve, so admission precedes reading either candidate.
    if (allowance < 1 + payloadWork * (entries.length + 1)) { truncated = true; break; }
    allowance -= 1;
    const value = values.at(index)!;
    if ((input.view.enumeration_policy ?? "canonical") === "associative") assertAssociativeMilligradeContract([value]);
    if (input.delivered_entry_revisions === undefined && input.delivered_product_ids?.has(productStateNodeId(value.state))) { next += 1; continue; }
    const grounded = input.grounding_complete !== false || groundedSeedAccepts(value, input);
    const entry = grounded ? indexEntryForValue(value, input) : null;
    if (entry !== null && input.delivered_entry_revisions?.[productStateNodeId(value.state)] === indexEntryRevision(entry)) {
      next += 1;
      continue;
    }
    const payloadReserve = input.finalize_payload === undefined ? 0
      : (input.payload_work_per_entry ?? 1) * (entries.length + (value.accepting && grounded ? 1 : 0));
    if (allowance < payloadReserve) {
      truncated = true;
      break;
    }
    if (!grounded) {
      groundingDeferred ||= value.accepting;
      if (value.accepting && input.delivered_product_ids === undefined) break;
      next += 1;
      continue;
    }
    if (entry !== null) entries.push(entry);
    next += 1;
    if (pageLimited && entries.length >= pageEnd && next < values.size) { truncated = true; break; }
  }
  return { entries, truncated: truncated || groundingDeferred, next, remaining: allowance };
}

export function indexEntryRevision(entry: IndexEntry): string {
  const { target, ...membership } = entry;
  const { span: _span, ...root } = target.kind === "source_evidence" ? target : { ...target, span: undefined };
  return createHash("sha256").update(stableStringify({ ...membership, target: root })).digest("hex");
}

function groundedSeedAccepts(value: FieldValue, input: AcceptingProjectionInput): boolean {
  const key = productStateNodeId(value.state);
  if (input.grounding_progress !== undefined) return (input.grounding_progress.grades.get(key) ?? -1) >= (value.milligrades ?? 0)
    && input.grounding_progress.root_map.has(key);
  const roots = new Set(input.output_derivations?.[key] ?? []);
  return input.derivations?.some((root) => roots.has(root.derivation_id) && root.kind === "leaf"
      && root.observation_ids.includes(productSubjectId(value.state))
      && (root.association_milligrades ?? 0) >= (value.milligrades ?? 0)) === true
    && (input.grounding_seeds ?? input.snapshot.seeds).some((seed) => productStateNodeId(seed.state) === key
      && seed.milligrades >= (value.milligrades ?? 0));
}

function indexEntryForValue(
  value: FieldValue,
  input: AcceptingProjectionInput
): IndexEntry | null {
  if (!value.accepting) return null;
  const milligrades = reachableMilligradesOf(value);
  if (milligrades === undefined) return null;
  if (milligrades <= input.view.threshold_milligrades) return null;
  if (!facetsAccept(value, input)) return null;
  const kindView = input.view.result_kind_view ?? "mixed";
  if (kindView === "memory_only" && value.state.target.kind !== "memory_entry") return null;
  if (kindView === "source_only" && value.state.target.kind !== "source_evidence") return null;
  const key = productStateNodeId(value.state);
  const role = input.roles?.get(key)
    ?? input.roles?.get(productSubjectId(value.state))
    ?? "associated";
  if (role === "routing_only" && !input.view.include_routing_only) return null;
  if (!input.view.requested_roles.includes(role)) return null;
  const mixedPayload = mixedPayloadGeneration(input.snapshot_id, input.payload_generation);
  const expandPayload = input.expand_payload !== false && !mixedPayload;
  const subjectId = productSubjectId(value.state);
  const proposition = input.claim_propositions?.get(key) ?? input.claim_propositions?.get(subjectId);
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    target: value.state.target,
    ...(value.state.target.kind === "memory_entry" ? { object_id: value.state.target.object_id } : {}),
    hypothesis_id: value.state.hypothesis_id,
    output_binding: value.state.binding_context,
    program_state: value.state.program_state,
    time_state: value.state.time_state,
    role,
    association_milligrades: milligrades,
    claim: input.claims?.get(key) ?? input.claims?.get(subjectId) ?? "unknown",
    ...(proposition === undefined ? {} : {
      claim_proposition_id: proposition.proposition_id,
      claim_proposition: proposition
    }),
    explanation_ids: explanationIdsForEntry({
      value,
      support: input.support,
      derivations: input.derivations,
      derivation_forest: input.derivation_forest,
      output_derivation_roots: input.output_derivation_roots,
      output_derivations: input.output_derivations,
      page_budget: input.budget.page_budget,
      expand_payload: expandPayload
    })
  };
}

function facetsAccept(value: FieldValue, input: AcceptingProjectionInput): boolean {
  if ((input.projection_facets ?? input.snapshot.facets).length === 0) return true;
  const vectors = facetsForCandidate(value, input);
  if (vectors.length === 0) return false;
  return evaluateFacetPredicate(
    facetModeForValue(value, input),
    vectors,
    input.view.threshold_milligrades
  );
}

function facetsForCandidate(
  value: FieldValue,
  input: AcceptingProjectionInput
): readonly FacetVector[] {
  const facets = input.projection_facets ?? input.snapshot.facets;
  const seeds = (input.grounding_seeds ?? input.snapshot.seeds).filter((seed) => productStateNodeId(seed.state) === productStateNodeId(value.state));
  return [...facets.filter((vector) => facetBelongsToOutput(vector.path_id, value.state)),
    ...seeds.map((seed) => ({ schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      path_id: composedFacetPathId(seed.state, "seed"), coordinates: [seed.milligrades] }))];
}

function facetModeForValue(value: FieldValue, input: AcceptingProjectionInput): FacetMode {
  if (input.relation_facet_modes === undefined) return input.view.facet_mode;
  for (const transition of input.snapshot.retained_transitions) {
    if (productStateNodeId(transition.to) !== productStateNodeId(value.state)) continue;
    const override = input.relation_facet_modes?.get(transition.relation_kind);
    if (override !== undefined) return override;
  }
  return input.view.facet_mode;
}

function sortEntries(entries: readonly IndexEntry[], policy: EnumerationPolicy = "canonical"): IndexEntry[] {
  // Canonical order is full product identity. Associative uses guaranteed lower milligrades
  // then exactly that canonical key. Membership is unchanged.
  return [...entries].sort((left, right) => compareIndexEntries(left, right, policy));
}

function compareIndexEntries(
  left: IndexEntry,
  right: IndexEntry,
  policy: EnumerationPolicy
): number {
  if (policy === "associative") {
    const grade = right.association_milligrades - left.association_milligrades;
    if (grade !== 0) return grade;
  }
  return compareText(canonicalIndexEntryIdentity(left), canonicalIndexEntryIdentity(right));
}

function valueSortKey(value: FieldValue): string {
  return productIndexOrderKey(value.state);
}

function entrySortKey(entry: IndexEntry): string {
  return canonicalIndexEntryIdentity(entry);
}

function resolvePageOffset(input: AcceptingProjectionInput, total: number): number {
  if (input.delivered_product_ids !== undefined) return 0;
  if (input.page_offset !== undefined) return Math.max(0, input.page_offset);
  const cursor = input.prior_continuation?.cursor;
  if (cursor === undefined) return 0;
  if (PROJECTION_CURSOR.test(cursor)) return 0;
  const resume = RESUME_CURSOR.exec(cursor);
  if (resume !== null) return Number(resume[1]);
  const matched = OFFSET_CURSOR.exec(cursor);
  if (matched === null) return total;
  return Number(matched[1]);
}

function continuationCursorInvalid(input: AcceptingProjectionInput): boolean {
  if (input.page_offset !== undefined) return false;
  const cursor = input.prior_continuation?.cursor;
  if (cursor === undefined) return false;
  // Associative order is not an offset into a canonical scan. Progressive
  // emitted-set pagination is CP08; an offset cursor under associative policy
  // cannot be replayed without skipping or duplicating members.
  if ((input.view.enumeration_policy ?? "canonical") === "associative" && OFFSET_CURSOR.test(cursor)) {
    return true;
  }
  return !OFFSET_CURSOR.test(cursor) && !RESUME_CURSOR.test(cursor) && !PROJECTION_CURSOR.test(cursor);
}

function continuationSetMismatch(
  input: AcceptingProjectionInput,
  entries: readonly IndexEntry[]
): boolean {
  if (input.delivered_product_ids !== undefined) return false;
  if (input.page_offset !== undefined) return false;
  const cursor = input.prior_continuation?.cursor;
  if (cursor === undefined) return false;
  const projection = PROJECTION_CURSOR.exec(cursor);
  if (projection !== null) {
    const offset = Number(projection[1]);
    return offset > input.snapshot.values.length
      || input.prior_continuation?.continuation_id !== projectionPrefixIdentity(input, offset);
  }
  const offset = resolvePageOffset(input, entries.length);
  if (offset === 0) return false;
  if (entries.length < offset) return true;
  const digest = resumeDigest(cursor);
  if (digest === undefined) return false;
  return digest !== identityDigest(entries.slice(0, offset).map(entrySortKey));
}

function continuationPrefixUnverified(
  input: AcceptingProjectionInput,
  entries: readonly IndexEntry[],
  truncated: boolean
): boolean {
  if (!truncated || input.delivered_product_ids !== undefined || input.page_offset !== undefined) return false;
  const cursor = input.prior_continuation?.cursor;
  return cursor !== undefined && !PROJECTION_CURSOR.test(cursor)
    && entries.length < resolvePageOffset(input, entries.length);
}

function projectionPrefixIdentity(input: AcceptingProjectionInput, offset: number): string {
  if (input.delivered_product_ids !== undefined) return `projection-${input.projection_generation ?? 0}-${offset}`;
  const prefix = [...input.snapshot.values].sort((a, b) => compareText(valueSortKey(a), valueSortKey(b)))
    .slice(0, offset).map((value) => stableStringify([value,
      input.roles?.get(productStateNodeId(value.state)) ?? "associated",
      facetsForCandidate(value, input), facetModeForValue(value, input)]));
  return `projection-${identityDigest([stableStringify(input.view), ...prefix])}`;
}

function nextContinuation(
  input: AcceptingProjectionInput,
  remaining: number,
  nextOffset: number,
  entries: readonly IndexEntry[],
  projectionOffset?: number
): Continuation | null {
  if (input.expires_at === undefined) return null;
  const observerOpen = input.observer?.outcome.status === "open"
    || input.observer?.outcome.status === "interrupted";
  if (remaining <= 0 && !observerOpen && input.resource_work !== "open" && input.support_work_status !== "open") return null;
  const cursor = projectionOffset === undefined
    ? encodeResumeCursor(nextOffset, entries.slice(0, nextOffset).map(entrySortKey))
    : `p${projectionOffset}g${input.grounding_progress?.completed_work ?? 0}`
      + (input.projection_generation === undefined ? "" : `r${input.projection_generation}`)
      + (input.explanation_progress === undefined ? "" : `e${input.explanation_progress.completedWork}`);
  if (cursor === null) return null;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    continuation_id: projectionOffset !== undefined && input.delivered_product_ids === undefined
      ? projectionPrefixIdentity(input, projectionOffset) : `page-${nextOffset}`,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    expires_at: input.expires_at,
    cursor,
    ...(input.interpretation_id === undefined ? {} : { interpretation_id: input.interpretation_id }),
    enumeration_policy: input.view.enumeration_policy ?? "canonical",
    result_kind_view: input.view.result_kind_view ?? "mixed"
  };
}

function continuationPolicyMismatch(input: AcceptingProjectionInput): boolean {
  const prior = input.prior_continuation;
  if (prior === undefined || prior === null) return false;
  return (prior.enumeration_policy ?? "canonical") !== (input.view.enumeration_policy ?? "canonical")
    || (prior.result_kind_view ?? "mixed") !== (input.view.result_kind_view ?? "mixed");
}

function assertAssociativeMilligradeContract(values: readonly FieldValue[]): void {
  for (const value of values) {
    const milligrades = reachableMilligradesOf(value);
    if (milligrades === undefined) continue;
    if (!Number.isInteger(milligrades) || milligrades < MILLIGRADE_BOTTOM || milligrades > 1000) {
      throw new CoreError(
        "VALIDATION",
        "unsupported-policy: associative requires a shared milligrade cap contract"
      );
    }
  }
}

function encodeResumeCursor(offset: number, prefixKeys: readonly string[]): string | null {
  const cursor = `o${String(offset)}|${identityDigest(prefixKeys)}`;
  return cursor.length >= 1 && cursor.length <= 256 ? cursor : null;
}

function resumeDigest(cursor: string): string | undefined {
  const resume = RESUME_CURSOR.exec(cursor);
  const suffix = resume?.[2];
  return suffix === undefined || suffix.length === 0 ? undefined : suffix;
}

function identityDigest(keys: readonly string[]): string {
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

function resolveInterpretationId(input: AcceptingProjectionInput): string | undefined {
  if (input.interpretation_id !== undefined) return input.interpretation_id;
  const clock = input.interpretation_clock;
  const model = input.model_id;
  if (clock !== undefined && model !== undefined) {
    const joined = `${clock}+${model}`;
    return joined.length <= 256 ? joined : identityDigest([clock, model]);
  }
  return clock ?? model;
}

function representationDecision(pageBudget: number): InformationIndex["representation"] {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    policy: REPRESENTATION_POLICY,
    page_budget: pageBudget,
    identity_tie_break: "serialization"
  };
}

function closedIndex(
  input: Readonly<{
    readonly query_id: string;
    readonly snapshot_id: string;
    readonly result_version: string;
  }>,
  representation: InformationIndex["representation"],
  completeness: InformationIndex["completeness"]
): InformationIndex {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    entries: [],
    completeness,
    continuation: null,
    representation
  };
}

function independentFacetPredicate(vectors: readonly FacetVector[], threshold: number): boolean {
  if (vectors.length === 0) return false;
  const width = Math.max(...vectors.map((vector) => vector.coordinates.length));
  for (let index = 0; index < width; index += 1) {
    let best = MILLIGRADE_BOTTOM;
    for (const vector of vectors) {
      const value = vector.coordinates[index] ?? MILLIGRADE_BOTTOM;
      if (value > best) best = value;
    }
    if (best <= threshold) return false;
  }
  return true;
}
