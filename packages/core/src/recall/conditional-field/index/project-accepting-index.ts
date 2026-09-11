import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  productStateKeyFromIndexEntry,
  reachableMilligradesOf,
  sharedProductIdentity,
  type ClaimState,
  type Continuation,
  type Derivation,
  type FacetMode,
  type FacetVector,
  type FieldSnapshot,
  type FieldValue,
  type IndexEntry,
  type IndexRole,
  type InformationIndex,
  type ProductStateKey,
  type QueryInterpretationStatus,
  type QueryView,
  type Proposition,
  type RequestBudget,
  type SupportRecord
} from "@do-soul/alaya-protocol";
import { associativeCapDomainAdmission } from "../query/query-admission.js";
import { capContractId } from "../cap-contract.js";
import { CoreError } from "../../../shared/errors.js";
import { groundedOutputDerivations, type GroundingProgress } from "../engine/output-derivations.js";
import {
  type FacetVisitIndex,
  type FacetVisitProgress
} from "./facet-visit-accounting.js";
import type { RequestCostLedger } from "../../runtime/request-cost-ledger.js";
import {
  PROJECTION_CURSOR,
  continuationCursorInvalid,
  continuationPolicyMismatch,
  emittedRevisionsOf,
  identityDigest,
  mergeCommittedRevisions,
  missingEmittedIdentities,
  productIdOfEntry,
  productUpdateFor,
  sortIndexEntries
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
  recoverExplanationForest,
  mixedPayloadGeneration,
  omittedStructuredPayload
} from "./explanation.js";
import { acceptingEntries } from "./project-accepting-entries.js";
import {
  bindCommittedDelivery,
  committedProductStatesOf,
  mergeCommittedProductStates,
  pagePurposeFor,
  productComponentState,
  productUpdatesBetween,
  type EmittedProductLedger
} from "./product-component-diff.js";
import { orderClosureFromProjection } from "./order-closure.js";
import {
  continuationPrefixUnverified,
  continuationSetMismatch,
  nextContinuation,
  resolvePageOffset,
  usesEmittedSet
} from "./project-accepting-continuation.js";

export type { ObserverCoverage } from "./completeness.js";
export {
  outputAttributionHandle,
  selectFeasibleWitnesses,
  witnessAttributionHandle
} from "./explanation.js";
export { indexEntryRevision } from "../../runtime/index-continuation.js";
export {
  evaluateFacetPredicate,
  evaluateSamePathPredicate
} from "./project-accepting-entries.js";
export {
  facetObligationsAccept,
  queryRequiresFacetMeasurement,
  requiredFacetObligations
} from "./facet-obligation-join.js";

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
  readonly delivered_product_states?: EmittedProductLedger;
  readonly payload_expansion?: boolean;
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
  readonly authorized_scopes?: readonly string[] | null;
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
  const products = committedProductStatesOf(previous)
    ?? committedProductStatesOf(previous.continuation)
    ?? {};
  return projectAcceptingIndex({
    ...input,
    query_id: previous.query_id,
    snapshot_id: previous.snapshot_id,
    result_version: previous.result_version,
    prior_continuation: previous.continuation,
    delivered_entry_revisions: { ...input.delivered_entry_revisions, ...emitted },
    delivered_product_states: { ...products, ...input.delivered_product_states },
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
  // Offset lives with continuation; pass pageEnd so scan/entry does not import it.
  const scanSize = !useEmittedSet && input.ordered_values !== undefined
    ? input.ordered_values.size
    : input.snapshot.values.length;
  const pageEnd = resolvePageOffset(input, scanSize) + input.budget.page_budget;
  const projected = acceptingEntries(input, useEmittedSet ? emitted : undefined, pageEnd);
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
  const ledger = input.delivered_product_states
    ?? committedProductStatesOf(input.prior_continuation)
    ?? {};
  const productUpdates = [
    ...retractionUpdates(projected.retracted, ledger),
    ...updates.flatMap((entry) => componentUpdatesFor(entry, emitted, ledger))
  ];
  const committedProducts = mergeCommittedProductStates(
    ledger, members, updates, projected.retracted
  );
  const order = orderClosureFromProjection({
    view: input.view,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    interpretation_id: input.interpretation_id,
    observer: input.observer,
    remaining,
    resource_open: resourceOpen,
    pending_semantic_work: omittedPayload || input.support_work_status === "open"
      || input.payload_work === "open"
  });
  const index = {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    entries: prepared,
    explanations: recoverExplanationForest(prepared.flatMap((entry) => entry.explanation_ids), input.derivations ?? []),
    completeness: order.order_status === "complete"
      ? { ...completeness, order_coverage: "complete" as const }
      : completeness,
    continuation: nextContinuation({
      ...input,
      projection_facet_offset: projected.facet.scan_offset,
      projection_facet_index: projected.facet.index,
      ...(resourceOpen || omittedPayload ? { resource_work: "open" } : {}),
      delivered_entry_revisions: committedRevisions
    }, remaining, nextOffset, useEmittedSet ? [...members, ...updates] : entries, scanOffset,
      committedRevisions, useEmittedSet),
    representation,
    page_purpose: pagePurposeFor({
      payload_expansion: input.payload_expansion === true,
      member_count: members.length,
      update_count: productUpdates.length
    }),
    ...(productUpdates.length === 0 ? {} : { product_updates: productUpdates }),
    order_status: order.order_status
  };
  bindCommittedDelivery(index, committedRevisions, committedProducts);
  return index;
}

function componentUpdatesFor(
  entry: IndexEntry,
  emitted: Readonly<Record<string, string>>,
  ledger: EmittedProductLedger
): ReturnType<typeof productUpdatesBetween> {
  const id = productIdOfEntry(entry);
  const previous = ledger[id];
  if (previous !== undefined) {
    return productUpdatesBetween(
      productStateKeyFromIndexEntry(entry),
      previous,
      productComponentState(entry)
    );
  }
  return [productUpdateFor(entry, emitted[id])];
}

function retractionUpdates(
  retracted: readonly ProductStateKey[],
  ledger: EmittedProductLedger
): ReturnType<typeof productUpdatesBetween> {
  return retracted.flatMap((product) => {
    const previous = ledger[sharedProductIdentity(product)] ?? {
      membership_revision: "emitted",
      proof_revision: "emitted",
      claim_revision: "emitted",
      explanation_revision: "emitted",
      payload_revision: "emitted",
      membership_present: true
    };
    return productUpdatesBetween(product, previous, { ...previous, membership_present: false });
  });
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
