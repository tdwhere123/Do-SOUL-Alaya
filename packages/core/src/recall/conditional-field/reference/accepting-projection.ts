import {
  MILLIGRADE_BOTTOM,
  type ClaimState,
  type CompletenessReport,
  type Continuation,
  type CoverageRegion,
  type FacetMode,
  type FacetVector,
  type FieldSnapshot,
  type FieldValue,
  type IndexEntry,
  type IndexRole,
  type InformationIndex,
  type ObserverCursor,
  type ObserverOutcome,
  type QueryInterpretationStatus,
  type QueryView,
  type RequestBudget,
  type SupportRecord,
  type Witness
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import {
  completenessForInterpretationStatus,
  interpretationMayEmitCompleteEmpty
} from "./interpret-query.js";

export type ObserverCoverage = Readonly<{
  readonly outcome: ObserverOutcome;
  readonly open_regions?: readonly CoverageRegion[];
}>;

export type HyperedgePremise = Readonly<{
  readonly hypothesis_id: string;
  readonly binding_context: string;
  readonly time_state: string;
  readonly present: boolean;
}>;

export type AcceptingProjectionInput = Readonly<{
  readonly snapshot: FieldSnapshot;
  readonly view: QueryView;
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly result_version: string;
  readonly budget: RequestBudget;
  readonly roles?: ReadonlyMap<string, IndexRole>;
  readonly claims?: ReadonlyMap<string, ClaimState>;
  readonly support?: readonly SupportRecord[];
  readonly page_offset?: number;
  readonly expires_at?: string;
  readonly as_of?: string;
  readonly prior_continuation?: Continuation;
  readonly observer?: ObserverCoverage;
  readonly interpretation_status?: QueryInterpretationStatus;
  readonly relation_facet_modes?: ReadonlyMap<string, FacetMode>;
}>;

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

export function joinHyperedgeAnd(premises: readonly HyperedgePremise[]): boolean {
  if (premises.length === 0) return false;
  if (!premises.every((premise) => premise.present)) return false;
  const first = premises[0];
  if (first === undefined) return false;
  return premises.every((premise) =>
    premise.hypothesis_id === first.hypothesis_id
    && premise.binding_context === first.binding_context
    && premise.time_state === first.time_state
  );
}

export function joinHyperedgeOr(witnesses: readonly Witness[]): readonly Witness[] {
  return witnesses.filter((witness) => witness.complete);
}

export function selectFeasibleWitnesses(
  witnesses: readonly Witness[],
  pageBudget: number
): readonly Witness[] {
  return witnesses.filter((witness) => witness.complete && witness.cost <= pageBudget);
}

export function advanceObserverCursor(
  cursor: ObserverCursor,
  observedId: string
): ObserverCursor {
  return {
    ...cursor,
    position: observedId,
    committed_through: observedId
  };
}

export function resumeIdsAfterCursor(
  ids: readonly string[],
  cursor: ObserverCursor
): readonly string[] {
  if (cursor.committed_through === null) return ids;
  const index = ids.indexOf(cursor.committed_through);
  if (index < 0) return ids;
  return ids.slice(index + 1);
}

export function mapNativeReaderPage(input: Readonly<{
  readonly ids: readonly string[];
  readonly truncated: boolean;
  readonly readerAvailable: boolean;
  readonly regions?: readonly CoverageRegion[];
}>): ObserverCoverage {
  if (!input.readerAvailable) {
    return {
      outcome: { schema_version: 1, status: "unavailable" },
      open_regions: input.regions ?? []
    };
  }
  if (input.truncated && input.ids.length === 0) {
    return {
      outcome: { schema_version: 1, status: "interrupted" },
      open_regions: input.regions ?? defaultOpenRegions()
    };
  }
  if (!input.truncated && input.ids.length === 0) {
    return {
      outcome: { schema_version: 1, status: "exhausted" },
      open_regions: []
    };
  }
  return {
    outcome: {
      schema_version: 1,
      status: input.truncated ? "open" : "exhausted"
    },
    open_regions: input.truncated ? (input.regions ?? defaultOpenRegions()) : []
  };
}

export function projectAcceptingIndex(input: AcceptingProjectionInput): InformationIndex {
  const representation: InformationIndex["representation"] = {
    schema_version: 1,
    policy: "construct_index_then_page_then_payload",
    page_budget: input.budget.page_budget,
    identity_tie_break: "serialization"
  };
  if (continuationInvalidated(input)) {
    return invalidatedIndex(input, representation);
  }
  const admission = input.interpretation_status === undefined
    ? undefined
    : completenessForInterpretationStatus(input.interpretation_status);
  if (admission !== undefined) {
    return {
      schema_version: 1,
      query_id: input.query_id,
      snapshot_id: input.snapshot_id,
      result_version: input.result_version,
      entries: [],
      completeness: admission,
      continuation: null,
      representation
    };
  }
  return pageAcceptingIndex(input, representation);
}

function pageAcceptingIndex(
  input: AcceptingProjectionInput,
  representation: InformationIndex["representation"]
): InformationIndex {
  const entries = sortEntries(acceptingEntries(input));
  const offset = input.page_offset ?? 0;
  const page = entries.slice(offset, offset + input.budget.page_budget);
  const remaining = entries.length - offset - page.length;
  const continuation = remaining > 0 && input.expires_at !== undefined
    ? {
        schema_version: 1 as const,
        continuation_id: `page-${offset + page.length}`,
        query_id: input.query_id,
        snapshot_id: input.snapshot_id,
        result_version: input.result_version,
        expires_at: input.expires_at,
        cursor: `offset-${offset + page.length}`
      }
    : null;
  return {
    schema_version: 1,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    entries: page,
    completeness: composeCompleteness(input, entries.length, remaining),
    continuation,
    representation
  };
}

function continuationInvalidated(input: AcceptingProjectionInput): boolean {
  if (input.as_of !== undefined && input.expires_at !== undefined && input.expires_at < input.as_of) {
    return true;
  }
  const prior = input.prior_continuation;
  if (prior === undefined) return false;
  if (prior.snapshot_id !== input.snapshot_id) return true;
  return input.as_of !== undefined && prior.expires_at < input.as_of;
}

function invalidatedIndex(
  input: AcceptingProjectionInput,
  representation: InformationIndex["representation"]
): InformationIndex {
  return {
    schema_version: 1,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    entries: [],
    completeness: {
      schema_version: 1,
      logical_index: "invalidated",
      observed_coverage: "invalidated",
      transport: "invalidated",
      payload: "invalidated",
      representation: "invalidated"
    },
    continuation: null,
    representation
  };
}

function acceptingEntries(input: AcceptingProjectionInput): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const value of input.snapshot.values) {
    const entry = indexEntryForValue(value, input);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

function indexEntryForValue(
  value: FieldValue,
  input: AcceptingProjectionInput
): IndexEntry | null {
  if (!value.accepting) return null;
  if (value.milligrades <= input.view.threshold_milligrades) return null;
  if (!facetsAccept(value, input)) return null;
  const role = input.roles?.get(value.state.object_id) ?? "associated";
  if (role === "routing_only" && !input.view.include_routing_only) return null;
  if (!input.view.requested_roles.includes(role)) return null;
  return {
    schema_version: 1,
    object_id: value.state.object_id,
    hypothesis_id: value.state.hypothesis_id,
    output_binding: value.state.binding_context,
    program_state: value.state.program_state,
    time_state: value.state.time_state,
    role,
    association_milligrades: value.milligrades,
    claim: input.claims?.get(value.state.object_id) ?? "unknown",
    explanation_ids: explanationIds(input.support, input.budget.page_budget)
  };
}

function facetsAccept(value: FieldValue, input: AcceptingProjectionInput): boolean {
  if (input.snapshot.facets.length === 0) return true;
  return evaluateFacetPredicate(
    facetModeForValue(value, input),
    input.snapshot.facets,
    input.view.threshold_milligrades
  );
}

function facetModeForValue(value: FieldValue, input: AcceptingProjectionInput): FacetMode {
  for (const transition of input.snapshot.retained_transitions) {
    if (transition.to.object_id !== value.state.object_id) continue;
    const override = input.relation_facet_modes?.get(transition.relation_kind);
    if (override !== undefined) return override;
  }
  return input.view.facet_mode;
}

function explanationIds(
  support: readonly SupportRecord[] | undefined,
  pageBudget: number
): readonly string[] {
  if (support === undefined) return [];
  const ids: string[] = [];
  for (const record of support) {
    for (const witness of selectFeasibleWitnesses(record.witnesses, pageBudget)) {
      ids.push(witness.witness_id);
    }
  }
  return ids;
}

function sortEntries(entries: readonly IndexEntry[]): IndexEntry[] {
  return [...entries].sort((left, right) => compareText(entrySortKey(left), entrySortKey(right)));
}

function entrySortKey(entry: IndexEntry): string {
  return stableStringify({
    object_id: entry.object_id,
    hypothesis_id: entry.hypothesis_id,
    output_binding: entry.output_binding,
    program_state: entry.program_state ?? "",
    time_state: entry.time_state ?? ""
  });
}

function composeCompleteness(
  input: AcceptingProjectionInput,
  total: number,
  remaining: number
): CompletenessReport {
  const observer = input.observer;
  const observerStatus = observer?.outcome.status;
  const open = (observer?.open_regions ?? []).some((region) => region.status === "open")
    || observerStatus === "open";
  if (observerStatus === "unavailable") return coverageReport("unavailable", remaining);
  if (observerStatus === "cancelled" || observerStatus === "unknown" || observerStatus === "not_applicable" || observerStatus === "invalidated") {
    return incompleteObserverCoverage(observerStatus, remaining);
  }
  if (observerStatus === "interrupted" || open) {
    return {
      schema_version: 1,
      logical_index: "open",
      observed_coverage: observerStatus === "interrupted" ? "interrupted" : "open",
      transport: remaining > 0 ? "partial" : "open",
      payload: remaining > 0 ? "partial" : "open",
      representation: "complete"
    };
  }
  if (total === 0) return emptyCompleteness(input);
  return {
    schema_version: 1,
    logical_index: "complete",
    observed_coverage: "complete",
    transport: remaining > 0 ? "partial" : "complete",
    payload: remaining > 0 ? "partial" : "complete",
    representation: "complete"
  };
}

function emptyCompleteness(input: AcceptingProjectionInput): CompletenessReport {
  const status = input.interpretation_status;
  if (status !== undefined && !interpretationMayEmitCompleteEmpty(status)) {
    return coverageReport("unavailable", 0);
  }
  return {
    schema_version: 1,
    logical_index: "complete",
    observed_coverage: "exhausted_empty",
    transport: "complete",
    payload: "complete",
    representation: "complete"
  };
}

function incompleteObserverCoverage(
  observed: "cancelled" | "unknown" | "not_applicable" | "invalidated",
  remaining: number
): CompletenessReport {
  return {
    schema_version: 1,
    logical_index: "open",
    observed_coverage: observed,
    transport: remaining > 0 ? "partial" : "open",
    payload: remaining > 0 ? "partial" : "open",
    representation: "complete"
  };
}

function coverageReport(
  status: CompletenessReport["logical_index"],
  remaining: number
): CompletenessReport {
  return {
    schema_version: 1,
    logical_index: status,
    observed_coverage: status,
    transport: remaining > 0 ? "partial" : status,
    payload: remaining > 0 ? "partial" : status,
    representation: "complete"
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

function defaultOpenRegions(): readonly CoverageRegion[] {
  return [
    region("seed", "seed"),
    region("adjacency", "adjacency"),
    region("guard", "guard"),
    region("binding", "binding")
  ];
}

function region(id: string, kind: CoverageRegion["kind"]): CoverageRegion {
  return {
    schema_version: 1,
    region_id: id,
    kind,
    status: "open"
  };
}
