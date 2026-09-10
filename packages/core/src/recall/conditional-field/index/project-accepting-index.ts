import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  canonicalIndexEntryIdentity,
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
import { associativeCapDomainAdmission } from "../query/query-admission.js";
import { capContractId } from "../cap-contract.js";
import { claimObligationAccepts } from "./claim-obligation.js";
import { CoreError } from "../../../shared/errors.js";
import { compareText } from "../../../shared/compare-text.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import { groundedOutputDerivations, type GroundingProgress } from "../engine/output-derivations.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import {
  accountFacetPreparation,
  indexedFacetsForCandidate,
  type FacetVisitIndex,
  type FacetVisitProgress
} from "./facet-visit-accounting.js";
import type { RequestCostLedger } from "../../runtime/request-cost-ledger.js";
import {
  OFFSET_CURSOR,
  PROJECTION_CURSOR,
  RESUME_CURSOR,
  continuationCursorInvalid,
  continuationPolicyMismatch,
  emittedRevisionsOf,
  encodeResumeCursor,
  identityDigest,
  indexEntryRevision,
  mergeCommittedRevisions,
  missingEmittedIdentities,
  productIdOfEntry,
  productUpdateFor,
  resumeDigest,
  sortFieldValues,
  sortIndexEntries,
  type EmittedRevisions
} from "../../runtime/index-continuation.js";
import {
  admitIndexBudget,
  completenessForInterpretationStatus,
  composeCompleteness,
  continuationInvalidated,
  invalidatedCompleteness,
  resourceRejectedCompleteness,
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
export { indexEntryRevision } from "../../runtime/index-continuation.js";

export type AcceptingProjectionInput = Readonly<{
  readonly snapshot: FieldSnapshot;
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
  readonly ordered_values?: Readonly<{ size: number; at(index: number): FieldValue | undefined }>;
  readonly on_projection_progress?: (offset: number, facet?: FacetVisitProgress) => void;
  readonly projection_facet_offset?: number;
  readonly projection_facet_index?: FacetVisitIndex;
  readonly cost?: RequestCostLedger;
  readonly on_semantic_entries?: (entries: readonly IndexEntry[]) => void;
  readonly explanation_progress?: import("./explanation-delivery.js").ExplanationDelivery;
  readonly on_explanation_progress?: (
    progress: import("./explanation-delivery.js").ExplanationDelivery | undefined,
    retainedBytes: number,
    work: number
  ) => void;
  readonly expires_at?: string;
  readonly as_of?: string;
  readonly lifetime_now?: string;
  readonly authorized_scopes?: readonly string[];
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
  readonly grounding_transitions?: FieldSnapshot["retained_transitions"];
  readonly grounding_seeds?: FieldSnapshot["seeds"];
  readonly grounding_derivations?: readonly Derivation[];
  readonly projection_facets?: readonly FacetVector[];
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
  if ((input.view.enumeration_policy ?? "canonical") === "associative") {
    assertAssociativeMilligradeContract(input.snapshot.values, input.view);
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
  const emitted = previous.continuation.emitted_revisions
    ?? input.delivered_entry_revisions
    ?? {};
  return projectAcceptingIndex({
    ...input,
    query_id: previous.query_id,
    snapshot_id: previous.snapshot_id,
    result_version: previous.result_version,
    prior_continuation: previous.continuation,
    delivered_entry_revisions: { ...input.delivered_entry_revisions, ...emitted },
    delivered_product_ids: new Set([
      ...input.delivered_product_ids ?? [],
      ...Object.keys(emitted)
    ]),
    interpretation_id: input.interpretation_id ?? previous.continuation.interpretation_id
  });
}

function pageAcceptingIndex(
  input: AcceptingProjectionInput,
  representation: InformationIndex["representation"]
): InformationIndex {
  if (input.transition_derivations !== undefined && input.output_derivations === undefined) {
    const allowance = input.remaining_reserve ?? input.budget.finalization_reserve;
    const deliveryWork = 1 + (input.finalize_payload === undefined ? 0 : input.payload_work_per_entry ?? 1);
    // Preserve one delivery opportunity when grounding can still advance; smaller requests resume after grounding.
    const groundingAllowance = allowance > deliveryWork ? allowance - deliveryWork : allowance;
    const availableMemory = input.remaining_memory_bytes ?? input.budget.memory_bytes;
    const payloadMemory = input.finalize_payload === undefined ? 0
      : Math.min(MAX_PAYLOAD_MEMORY_BYTES, Math.floor(availableMemory / 4));
    const groundingInput = { seeds: input.snapshot.seeds,
      transitions: input.snapshot.retained_transitions, derivations: input.derivations ?? [],
      transition_derivations: input.transition_derivations ?? {},
      progress: input.grounding_progress, memory_bytes: availableMemory - payloadMemory,
      allowance: groundingAllowance };
    const grounded = input.cost === undefined
      ? groundedOutputDerivations(groundingInput)
      : input.cost.time("solve", () => groundedOutputDerivations(groundingInput));
    input.cost?.add("solve", {
      relaxations: grounded.work,
      charged_retained_bytes: grounded.retained_bytes
    });
    input.on_grounding_progress?.(grounded.progress, grounded.retained_bytes);
    input = { ...input, derivations: grounded.derivations, output_derivations: grounded.roots, grounding_progress: grounded.progress,
      grounding_complete: grounded.complete,
      ...(grounded.work > 0 && input.delivered_product_ids !== undefined ? { projection_scan_offset: 0 } : {}),
      remaining_reserve: allowance - grounded.work,
      ...(!grounded.complete ? { resource_work: "open" } : {}) };
  }
  const policy = input.view.enumeration_policy ?? "canonical";
  const emitted = emittedRevisionsOf(input);
  const useEmittedSet = usesEmittedSet(input, policy);
  if (useEmittedSet && missingEmittedIdentities(emitted, input.snapshot.values).length > 0) {
    return closedIndex(input, representation, invalidatedCompleteness());
  }
  const projected = acceptingEntries(input, useEmittedSet ? emitted : undefined);
  const entries = sortIndexEntries(projected.entries, policy);
  if (!useEmittedSet && continuationPrefixUnverified(input, entries, projected.truncated)) {
    input.on_remaining_reserve?.(projected.remaining);
    return { ...closedIndex(input, representation, indexCompleteness(input, {
      total: entries.length, remaining: 1, omitted_payload: false,
      expand_payload: input.expand_payload !== false, resource_work: "open"
    })),
      continuation: input.prior_continuation ?? null };
  }
  if (!useEmittedSet && continuationSetMismatch(input, entries)) {
    return closedIndex(input, representation, invalidatedCompleteness());
  }
  input.on_projection_progress?.(projected.next, projected.facet);
  if (projected.facet !== undefined) {
    input.cost?.add("index", {
      native_visits: projected.facet.visits,
      cache_hits: projected.facet.cache_hits,
      cache_misses: projected.facet.cache_misses
    });
  }
  const offset = useEmittedSet ? 0 : resolvePageOffset(input, entries.length);
  const members = useEmittedSet
    ? projected.members
    : entries.slice(offset, offset + input.budget.page_budget);
  const updates = useEmittedSet ? projected.updates : [];
  const remaining = useEmittedSet
    ? Math.max(projected.truncated ? 1 : 0, projected.unemitted - members.length)
    : Math.max(projected.truncated ? 1 : 0, entries.length - offset - members.length);
  const prepared = members.length > 0 ? members : updates;
  if (!useEmittedSet || members.length > 0) input.on_semantic_entries?.(prepared);
  const finalized = input.finalize_payload?.(prepared, projected.remaining);
  const retryPayload = finalized !== undefined && !finalized.complete;
  if (finalized !== undefined) input = { ...input, payload_work: finalized.complete ? "complete" : "open" };
  input.on_remaining_reserve?.(finalized?.remaining ?? projected.remaining);
  const committed = !retryPayload;
  const mixedPayload = mixedPayloadGeneration(input.snapshot_id, input.payload_generation);
  const expandPayload = input.expand_payload !== false && !mixedPayload;
  const omittedPayload = mixedPayload || input.payload_work === "open"
    || (expandPayload && omittedStructuredPayload(
      input.support,
      input.derivations,
      input.budget.page_budget
    ));
  const resourceOpen = projected.truncated || input.resource_work === "open";
  const completeness = indexCompleteness(input, {
    total: members.length + updates.length + Object.keys(emitted).length,
    remaining,
    omitted_payload: omittedPayload,
    expand_payload: expandPayload,
    ...(mixedPayload ? { mixed_generation: true } : {}),
    ...(input.support_work_status === undefined ? {} : { explanation_work: input.support_work_status }),
    ...(resourceOpen ? { resource_work: "open" as const } : {})
  });
  const committedRevisions = committed
    ? mergeCommittedRevisions(emitted, [...members, ...updates])
    : { ...emitted };
  const nextOffset = retryPayload ? offset : offset + members.length;
  const scanOffset = retryPayload
    ? Number(PROJECTION_CURSOR.exec(input.prior_continuation?.cursor ?? "")?.[1] ?? 0)
    : projected.truncated || useEmittedSet
      || PROJECTION_CURSOR.test(input.prior_continuation?.cursor ?? "") ? projected.next : undefined;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    entries: prepared,
    explanations: recoverExplanationForest(prepared.flatMap((entry) => entry.explanation_ids), input.derivations ?? []),
    completeness,
    continuation: nextContinuation({
      ...input,
      projection_facet_offset: projected.facet.scan_offset,
      projection_facet_index: projected.facet.index,
      ...(resourceOpen || omittedPayload ? { resource_work: "open" } : {}),
      delivered_entry_revisions: committedRevisions
    }, remaining, nextOffset, useEmittedSet ? [...members, ...updates] : entries, scanOffset,
      committedRevisions, useEmittedSet),
    representation,
    page_purpose: members.length > 0 ? "membership" : updates.length > 0 ? "update" : "membership",
    ...(updates.length === 0 ? {} : {
      product_updates: updates.map((entry) => productUpdateFor(entry, emitted[productIdOfEntry(entry)]))
    }),
    order_status: remaining > 0 || resourceOpen || completeness.order_coverage !== "complete"
      ? "open"
      : "complete"
  };
}

function indexCompleteness(
  input: AcceptingProjectionInput,
  extra: Parameters<typeof composeCompleteness>[0]
): ReturnType<typeof composeCompleteness> {
  const residuals = extra.residuals ?? input.observer?.open_regions ?? [];
  return composeCompleteness({
    ...extra,
    observer: extra.observer ?? input.observer,
    interpretation_status: extra.interpretation_status ?? input.interpretation_status,
    query_id: extra.query_id ?? input.query_id,
    residuals,
    result_kind_view: extra.result_kind_view ?? input.view.result_kind_view,
    program_id: extra.program_id ?? input.interpretation_id
  });
}

function usesEmittedSet(input: AcceptingProjectionInput, policy: EnumerationPolicy): boolean {
  // Offset into a resorted list drops late stronger members; the continuation's
  // emitted_revisions ledger is the projector's own resume state for every policy.
  return policy === "associative"
    || input.delivered_product_ids !== undefined
    || input.delivered_entry_revisions !== undefined
    || input.prior_continuation?.emitted_revisions !== undefined;
}

function acceptingEntries(
  input: AcceptingProjectionInput,
  emitted?: EmittedRevisions
): {
  readonly entries: IndexEntry[];
  readonly members: IndexEntry[];
  readonly updates: IndexEntry[];
  readonly unemitted: number;
  readonly truncated: boolean;
  readonly next: number;
  readonly remaining: number;
  readonly facet: FacetVisitProgress;
} {
  const entries: IndexEntry[] = [];
  const members: IndexEntry[] = [];
  const updates: IndexEntry[] = [];
  let allowance = input.remaining_reserve ?? input.budget.finalization_reserve;
  let truncated = false;
  let groundingDeferred = false;
  const policy = input.view.enumeration_policy ?? "canonical";
  const cursorMatch = PROJECTION_CURSOR.exec(input.prior_continuation?.cursor ?? "");
  const start = emitted !== undefined && Object.keys(emitted).length > 0
    ? 0
    : input.projection_scan_offset
      ?? Number(cursorMatch?.[1] ?? 0);
  const sorted = sortFieldValues(input.snapshot.values, emitted === undefined ? "canonical" : policy);
  const values = input.ordered_values !== undefined && emitted === undefined
    ? input.ordered_values
    : { size: sorted.length, at: (index: number) => sorted[index] };
  const payloadWork = input.finalize_payload === undefined ? 0 : input.payload_work_per_entry ?? 1;
  const pageLimited = input.projection_scan_offset !== undefined || input.delivered_product_ids !== undefined
    || input.delivered_entry_revisions !== undefined || input.grounding_complete === false
    || PROJECTION_CURSOR.test(input.prior_continuation?.cursor ?? "")
    || allowance < values.size * (1 + payloadWork);
  const pageEnd = resolvePageOffset(input, values.size) + input.budget.page_budget;
  const scanOffset = input.projection_facet_offset ?? Number(cursorMatch?.[4] ?? 0);
  if (input.budget.page_budget === 0) {
    return {
      entries, members, updates, unemitted: values.size,
      truncated: start < values.size, next: start, remaining: allowance,
      facet: accountFacetPreparation(input.snapshot.facets, input.snapshot.seeds, 0,
        input.projection_facet_index, scanOffset).facet
    };
  }
  const prepared = accountFacetPreparation(
    input.snapshot.facets, input.snapshot.seeds, allowance, input.projection_facet_index, scanOffset,
    Math.min(input.budget.page_budget, Math.max(1, values.size))
      * (1 + (input.finalize_payload === undefined ? 0 : input.payload_work_per_entry ?? 1))
  );
  allowance = prepared.remaining;
  let facet = prepared.facet;
  truncated = prepared.truncated;
  const indexed = { ...input, projection_facet_index: prepared.facet.index };
  if (prepared.truncated && allowance <= 0) {
    return {
      entries, members, updates, unemitted: values.size,
      truncated: true, next: start, remaining: allowance, facet
    };
  }
  let next = start;
  for (let index = start; index < values.size; index += 1) {
    const value = values.at(index);
    if (value === undefined) break;
    const key = productStateNodeId(value.state);
    if (emitted !== undefined) {
      const prior = emitted[key];
      if (prior !== undefined) {
        const grounded = input.grounding_complete !== false || groundedSeedAccepts(value, input);
        const entry = grounded ? indexEntryForValue(value, indexed) : null;
        if (entry === null || prior === indexEntryRevision(entry)) {
          next += 1;
          continue;
        }
        if (allowance < 1) { truncated = true; break; }
        allowance -= 1;
        if (updates.length < input.budget.page_budget) updates.push(entry);
        next += 1;
        continue;
      }
      if (input.delivered_product_ids?.has(key)) {
        next += 1;
        continue;
      }
    } else if (input.delivered_entry_revisions === undefined
      && input.delivered_product_ids?.has(key)) {
      next += 1;
      continue;
    }
    const grounded = input.grounding_complete !== false || groundedSeedAccepts(value, indexed);
    const entry = grounded ? indexEntryForValue(value, indexed) : null;
    if (value.accepting && grounded && input.snapshot.facets.length > 0
      && indexed.projection_facet_index?.complete !== true && !facetsAccept(value, indexed)) {
      truncated = true;
      break;
    }
    if (entry !== null && input.delivered_entry_revisions?.[key] === indexEntryRevision(entry)) {
      next += 1; facet = { ...facet, scan_offset: 0 };
      continue;
    }
    const collected = emitted === undefined ? entries.length : members.length;
    const payloadReserve = input.finalize_payload === undefined ? 0
      : (input.payload_work_per_entry ?? 1) * (collected + (value.accepting && grounded ? 1 : 0));
    if (allowance < 1 + payloadReserve) {
      truncated = true;
      facet = { ...facet, scan_offset: Math.max(facet.scan_offset, 1) };
      break;
    }
    allowance -= 1;
    if (!grounded) {
      groundingDeferred ||= value.accepting;
      if (value.accepting && input.delivered_product_ids === undefined && emitted === undefined) break;
      next += 1; facet = { ...facet, scan_offset: 0 };
      continue;
    }
    if (entry !== null) {
      entries.push(entry);
      if (emitted !== undefined && members.length < input.budget.page_budget) members.push(entry);
    }
    next += 1; facet = { ...facet, scan_offset: 0 };
    if (emitted !== undefined) {
      if (members.length >= input.budget.page_budget) {
        truncated = truncated || next < values.size;
        break;
      }
      continue;
    }
    if (pageLimited && entries.length >= pageEnd && next < values.size) { truncated = true; break; }
  }
  const unemitted = emitted === undefined
    ? Math.max(0, entries.length)
    : members.length + (truncated ? 1 : 0);
  return {
    entries,
    members: emitted === undefined ? entries : members,
    updates,
    unemitted,
    truncated: truncated || groundingDeferred,
    next,
    remaining: allowance,
    facet
  };
}

function groundedSeedAccepts(value: FieldValue, input: AcceptingProjectionInput): boolean {
  const key = productStateNodeId(value.state);
  const roots = new Set(input.output_derivations?.[key] ?? []);
  return input.derivations?.some((root) => roots.has(root.derivation_id) && root.kind === "leaf"
      && root.observation_ids.includes(productSubjectId(value.state))
      && (root.association_milligrades ?? 0) >= (value.milligrades ?? 0)) === true
    && input.snapshot.seeds.some((seed) => productStateNodeId(seed.state) === key
      && seed.milligrades >= (value.milligrades ?? 0));
}

function indexEntryForValue(
  value: FieldValue,
  input: AcceptingProjectionInput
): IndexEntry | null {
  if (!value.accepting) return null;
  const milligrades = reachableMilligradesOf(value);
  if (milligrades === undefined) return null;
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
  const claim = input.claims?.get(key) ?? input.claims?.get(subjectId) ?? "unknown";
  if (!claimObligationAccepts(value, input.view, claim)) return null;
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
    claim,
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
  if (input.snapshot.facets.length === 0) return true;
  if (input.projection_facet_index?.complete !== true) return false;
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
  if (input.snapshot.facets.length === 0 || input.projection_facet_index === undefined) return [];
  return indexedFacetsForCandidate(value, input.projection_facet_index, input.snapshot.facets);
}

function facetModeForValue(value: FieldValue, input: AcceptingProjectionInput): FacetMode {
  for (const transition of input.snapshot.retained_transitions) {
    if (productStateNodeId(transition.to) !== productStateNodeId(value.state)) continue;
    const override = input.relation_facet_modes?.get(transition.relation_kind);
    if (override !== undefined) return override;
  }
  return input.view.facet_mode;
}

function valueSortKey(value: FieldValue): string {
  return canonicalIndexEntryIdentity({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    target: value.state.target,
    ...(value.state.target.kind === "memory_entry" ? { object_id: value.state.target.object_id } : {}),
    hypothesis_id: value.state.hypothesis_id,
    output_binding: value.state.binding_context,
    program_state: value.state.program_state,
    time_state: value.state.time_state,
    role: "associated",
    association_milligrades: reachableMilligradesOf(value) ?? 0,
    claim: "unknown",
    explanation_ids: []
  });
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
  projectionOffset: number | undefined,
  committed: EmittedRevisions,
  useEmittedSet: boolean
): Continuation | null {
  if (input.expires_at === undefined) return null;
  const observerOpen = input.observer?.outcome.status === "open"
    || input.observer?.outcome.status === "interrupted";
  if (remaining <= 0 && !observerOpen && input.resource_work !== "open" && input.support_work_status !== "open") return null;
  const emittedKeys = Object.keys(committed).sort(compareText);
  const cursor = projectionOffset === undefined
    ? encodeResumeCursor(
      useEmittedSet ? emittedKeys.length : nextOffset,
      useEmittedSet ? emittedKeys : entries.slice(0, nextOffset).map(entrySortKey)
    )
    : `p${projectionOffset}g${input.grounding_progress?.completed_work ?? 0}`
      + (input.projection_generation === undefined ? "" : `r${input.projection_generation}`)
      + ((input.projection_facet_offset ?? 0) > 0 ? `e${input.projection_facet_offset}` : "");
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
    result_kind_view: input.view.result_kind_view ?? "mixed",
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes }),
    ...(input.view.cap_contracts === undefined ? {} : { cap_contracts: input.view.cap_contracts }),
    ...(input.view.claim_demands === undefined ? {} : { claim_demands: input.view.claim_demands }),
    ...wireEmittedRevisions(committed)
  };
}

function wireEmittedRevisions(committed: EmittedRevisions): { readonly emitted_revisions: EmittedRevisions } | {} {
  const next: Record<string, string> = {};
  for (const [id, revision] of Object.entries(committed)) {
    if (revision.length > 0) next[id] = revision;
  }
  return Object.keys(next).length === 0 ? {} : { emitted_revisions: next };
}

function assertAssociativeMilligradeContract(values: readonly FieldValue[], view: QueryView): void {
  if (associativeCapDomainAdmission(view) === "incompatible") {
    throw new CoreError(
      "VALIDATION",
      "unsupported-policy: associative requires a shared milligrade cap contract"
    );
  }
  const expected = view.cap_contracts === undefined || view.cap_contracts.length === 0
    ? undefined
    : capContractId(view.cap_contracts[0]!);
  const seen = new Set<string>();
  for (const value of values) {
    if (reachableMilligradesOf(value) === undefined) continue;
    const id = value.cap_contract_id
      ?? (value.activation?.kind === "reachable" ? value.activation.cap_contract_id : undefined);
    if (id !== undefined) seen.add(id);
  }
  if (seen.size > 1 || (expected !== undefined && seen.size === 1 && !seen.has(expected))) {
    throw new CoreError(
      "VALIDATION",
      "unsupported-policy: associative requires a shared milligrade cap contract"
    );
  }
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
