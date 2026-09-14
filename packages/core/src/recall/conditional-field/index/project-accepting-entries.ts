import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  guaranteedMilligradesOf,
  productStateKeyFromIndexEntry,
  productSubjectId,
  reachableMilligradesOf,
  sharedProductIdentity,
  type FacetMode,
  type FacetVector,
  type FieldValue,
  type IndexEntry,
  type ProductStateKey
} from "@do-soul/alaya-protocol";
import { claimObligationAccepts } from "./claim-obligation.js";
import {
  facetObligationsAccept,
  queryRequiresFacetMeasurement
} from "./facet-obligation-join.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import {
  accountFacetPreparation,
  indexedFacetsForCandidate,
  type FacetVisitProgress
} from "./facet-visit-accounting.js";
import {
  PROJECTION_CURSOR,
  indexEntryRevision,
  sortFieldValues,
  type EmittedRevisions
} from "../../runtime/index-continuation.js";
import {
  explanationIdsForEntry,
  mixedPayloadGeneration
} from "./explanation.js";
import type { AcceptingProjectionInput } from "./project-accepting-index.js";
import {
  committedProductStatesOf,
  productComponentState,
  productUpdatesBetween
} from "./product-component-diff.js";

export {
  evaluateFacetPredicate,
  evaluateSamePathPredicate
} from "../engine/facet-predicates.js";

export function acceptingEntries(
  input: AcceptingProjectionInput,
  emitted: EmittedRevisions | undefined,
  pageEnd: number
): {
  readonly entries: IndexEntry[];
  readonly members: IndexEntry[];
  readonly updates: IndexEntry[];
  readonly retracted: ProductStateKey[];
  readonly unemitted: number;
  readonly truncated: boolean;
  readonly next: number;
  readonly remaining: number;
  readonly facet: FacetVisitProgress;
  readonly has_incomparable_activations: boolean | undefined;
} {
  const entries: IndexEntry[] = [];
  const members: IndexEntry[] = [];
  const updates: IndexEntry[] = [];
  const retracted: ProductStateKey[] = [];
  let allowance = input.remaining_reserve ?? input.budget.finalization_reserve;
  let truncated = false;
  let groundingDeferred = false;
  const policy = input.view.enumeration_policy ?? "canonical";
  const cursorMatch = PROJECTION_CURSOR.exec(input.prior_continuation?.cursor ?? "");
  const start = emitted !== undefined && Object.keys(emitted).length > 0
    ? 0
    : input.projection_scan_offset
      ?? Number(cursorMatch?.[1] ?? 0);
  let values: NonNullable<AcceptingProjectionInput["ordered_values"]>;
  if (input.ordered_values !== undefined && emitted === undefined) values = input.ordered_values;
  else {
    const sorted = sortFieldValues(input.snapshot.values, emitted === undefined ? "canonical" : policy);
    values = { size: sorted.length, at: (index: number) => sorted[index] };
  }
  const payloadWork = input.finalize_payload === undefined ? 0 : input.payload_work_per_entry ?? 1;
  const pageLimited = input.projection_scan_offset !== undefined || input.delivered_product_ids !== undefined
    || input.delivered_entry_revisions !== undefined || input.grounding_complete === false
    || PROJECTION_CURSOR.test(input.prior_continuation?.cursor ?? "")
    || allowance < values.size * (1 + payloadWork);
  const scanOffset = input.projection_facet_offset ?? Number(cursorMatch?.[4] ?? 0);
  if (input.budget.page_budget === 0) {
    return {
      entries, members, updates, retracted, unemitted: values.size,
      has_incomparable_activations: input.snapshot.has_incomparable_activations ?? (values.size === 0 ? false : undefined),
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
      entries, members, updates, retracted, unemitted: values.size,
      has_incomparable_activations: input.snapshot.has_incomparable_activations,
      truncated: true, next: start, remaining: allowance, facet
    };
  }
  let next = start;
  let encounteredConflict = false;
  ({ next, truncated, groundingDeferred, allowance, facet } = scanAcceptingValues({
    input: indexed, emitted, pageEnd, pageLimited, values, start, next, truncated,
    groundingDeferred, allowance, facet, entries, members, updates,
    onConflict: () => { encounteredConflict = true; }
  }));
  const unemitted = emitted === undefined
    ? Math.max(0, entries.length)
    : members.length + (truncated ? 1 : 0);
  if (emitted !== undefined && input.budget.page_budget > 0) {
    collectRetractions(emitted, values, indexed, retracted);
  }
  return {
    entries,
    members: emitted === undefined ? entries : members,
    updates,
    retracted,
    unemitted,
    truncated: truncated || groundingDeferred,
    next,
    remaining: allowance,
    facet,
    has_incomparable_activations: encounteredConflict ? true : input.snapshot.has_incomparable_activations
      ?? (start === 0 && next === values.size && !truncated ? false : undefined)
  };
}

function scanAcceptingValues(scan: {
  readonly input: AcceptingProjectionInput;
  readonly emitted: EmittedRevisions | undefined;
  readonly pageEnd: number;
  readonly pageLimited: boolean;
  readonly values: { readonly size: number; at(index: number): FieldValue | undefined };
  start: number;
  next: number;
  truncated: boolean;
  groundingDeferred: boolean;
  allowance: number;
  facet: FacetVisitProgress;
  readonly entries: IndexEntry[];
  readonly members: IndexEntry[];
  readonly updates: IndexEntry[];
  readonly onConflict: () => void;
}): {
  next: number;
  truncated: boolean;
  groundingDeferred: boolean;
  allowance: number;
  facet: FacetVisitProgress;
} {
  const { input, emitted, pageEnd, pageLimited, values, entries, members, updates } = scan;
  let { next, truncated, groundingDeferred, allowance, facet } = scan;
  const needsConflictScan = input.snapshot.has_incomparable_activations === undefined;
  const entryVisit = needsConflictScan ? 0 : 1;
  for (let index = scan.start; index < values.size; index += 1) {
    if (needsConflictScan && allowance < 1) { truncated = true; break; }
    const value = values.at(index);
    if (value === undefined) break;
    if (needsConflictScan) {
      allowance -= 1;
      if (value.activation?.kind === "incomparable") scan.onConflict();
    }
    const key = sharedProductIdentity(value.state);
    if (emitted !== undefined) {
      const prior = emitted[key];
      const previousState = input.delivered_product_states?.[key]
        ?? committedProductStatesOf(input.prior_continuation)?.[key];
      if (prior !== undefined && previousState?.membership_present !== false) {
        const grounded = input.grounding_complete !== false || groundedSeedAccepts(value, input);
        const entry = grounded ? indexEntryForValue(value, input) : null;
        if (entry === null || productUnchanged(entry, prior, input, key)) {
          next += 1;
          continue;
        }
        if (allowance < entryVisit || updates.length >= input.budget.page_budget) { truncated = true; break; }
        allowance -= entryVisit;
        updates.push(entry);
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
    const grounded = input.grounding_complete !== false || groundedSeedAccepts(value, input);
    const entry = grounded ? indexEntryForValue(value, input) : null;
    if (value.accepting && grounded && input.snapshot.facets.length > 0
      && input.projection_facet_index?.complete !== true && !facetsAccept(value, input)) {
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
    if (allowance < entryVisit + payloadReserve) {
      truncated = true;
      facet = { ...facet, scan_offset: Math.max(facet.scan_offset, 1) };
      break;
    }
    allowance -= entryVisit;
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
  return { next, truncated, groundingDeferred, allowance, facet };
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

function productUnchanged(
  entry: IndexEntry,
  prior: string,
  input: AcceptingProjectionInput,
  key: string
): boolean {
  const previous = input.delivered_product_states?.[key]
    ?? committedProductStatesOf(input.prior_continuation)?.[key];
  if (previous === undefined) return prior === indexEntryRevision(entry);
  return productUpdatesBetween(
    productStateKeyFromIndexEntry(entry),
    previous,
    productComponentState(entry)
  ).length === 0;
}

function collectRetractions(
  emitted: EmittedRevisions,
  values: Readonly<{ size: number; at(index: number): FieldValue | undefined }>,
  input: AcceptingProjectionInput,
  retracted: ProductStateKey[]
): void {
  const ledger = input.delivered_product_states
    ?? committedProductStatesOf(input.prior_continuation)
    ?? {};
  for (let index = 0; index < values.size; index += 1) {
    const value = values.at(index);
    if (value === undefined) continue;
    const key = sharedProductIdentity(value.state);
    if (emitted[key] === undefined || ledger[key]?.membership_present === false) continue;
    if (indexEntryForValue(value, input) === null
      && indexEntryForValue(value, input, { holdIncompleteFacets: true }) === null) {
      retracted.push(value.state);
    }
  }
}

export function indexEntryForValue(
  value: FieldValue,
  input: AcceptingProjectionInput,
  options?: Readonly<{ readonly holdIncompleteFacets?: boolean }>
): IndexEntry | null {
  if (!value.accepting) return null;
  const milligrades = reachableMilligradesOf(value);
  if (milligrades === undefined) return null;
  if (!facetsAccept(value, input, options?.holdIncompleteFacets === true)) return null;
  const kindView = input.view.result_kind_view ?? "mixed";
  if (kindView === "memory_only" && value.state.target.kind !== "memory_entry") return null;
  if (kindView === "source_only" && value.state.target.kind !== "source_evidence") return null;
  const key = productStateNodeId(value.state);
  const role = input.roles?.get(key) ?? "associated";
  if (role === "routing_only" && !input.view.include_routing_only) return null;
  if (!input.view.requested_roles.includes(role)) return null;
  const mixedPayload = mixedPayloadGeneration(input.snapshot_id, input.payload_generation);
  const expandPayload = input.expand_payload !== false && !mixedPayload;
  const claim = input.claims?.get(key) ?? "unknown";
  if (!claimObligationAccepts(value, input.view, claim, input.binding_contexts)) return null;
  const proposition = input.claim_propositions?.get(key);
  const guaranteed = guaranteedMilligradesOf(value);
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
    ...(guaranteed === undefined ? {} : { guaranteed_milligrades: guaranteed }),
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

function facetsAccept(
  value: FieldValue,
  input: AcceptingProjectionInput,
  holdIncompleteFacets = false
): boolean {
  if (!queryRequiresFacetMeasurement(input.view.facet_obligations)) return true;
  if (input.snapshot.facets.length === 0) return false;
  if (input.projection_facet_index?.complete !== true) return holdIncompleteFacets;
  const vectors = facetsForCandidate(value, input);
  if (vectors.length === 0) return false;
  return facetObligationsAccept(
    input.view.facet_obligations,
    vectors,
    facetModeForValue(value, input)
  );
}

export function facetsForCandidate(
  value: FieldValue,
  input: AcceptingProjectionInput
): readonly FacetVector[] {
  if (input.snapshot.facets.length === 0 || input.projection_facet_index === undefined) return [];
  return indexedFacetsForCandidate(value, input.projection_facet_index, input.snapshot.facets);
}

export function facetModeForValue(value: FieldValue, input: AcceptingProjectionInput): FacetMode {
  for (const transition of input.snapshot.retained_transitions) {
    if (productStateNodeId(transition.to) !== productStateNodeId(value.state)) continue;
    const override = input.relation_facet_modes?.get(transition.relation_kind);
    if (override !== undefined) return override;
  }
  return input.view.facet_mode;
}
