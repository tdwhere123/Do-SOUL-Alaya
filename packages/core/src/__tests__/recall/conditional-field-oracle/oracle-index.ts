import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type ClaimState,
  type CompletenessReport,
  type CompletenessStatus,
  type Continuation,
  type CoverageRegion,
  type FacetMode,
  type FacetVector,
  type FieldValue,
  type IndexEntry,
  type IndexRole,
  type InformationIndex,
  type ObserverCursor,
  type QueryInterpretationStatus,
  type QueryView,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import {
  evaluateFacets,
  type EnumeratedField
} from "./enumerate-simple-paths.js";
import type { NativeReaderPage } from "./finite-worlds.js";

export const CONTRACT_ONLY_UNTIL_REAL_PRODUCERS = "contract-only until real producers bind";

export type OracleCounts = Readonly<{
  readonly matches: number;
  readonly mismatches: number;
  readonly unsupported: number;
  readonly observation_holes: number;
  readonly skipped_environments: number;
}>;

export type ObserverCoverage = Readonly<{
  readonly outcome: { readonly schema_version: 1; readonly status: CompletenessStatus };
  readonly open_regions: readonly CoverageRegion[];
}>;

export type IndexOracleInput = Readonly<{
  readonly field: EnumeratedField;
  readonly view: QueryView;
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly result_version: string;
  readonly budget: RequestBudget;
  readonly roles: ReadonlyMap<string, IndexRole>;
  readonly claims?: ReadonlyMap<string, ClaimState>;
  readonly facets?: readonly FacetVector[];
  readonly page_offset?: number;
  readonly expires_at?: string;
  readonly as_of?: string;
  readonly prior_continuation?: Continuation;
  readonly observer?: ObserverCoverage;
  readonly interpretation_status?: QueryInterpretationStatus;
  readonly interpretation_coverage?: CompletenessStatus;
  readonly omitted_hypotheses?: readonly string[];
  readonly relation_facet_modes?: ReadonlyMap<string, FacetMode>;
  readonly retained_relation_kinds?: ReadonlyMap<string, string>;
}>;

export type FairRegion = Readonly<{
  readonly id: string;
  readonly finite: boolean;
  readonly work: number;
}>;

export function emptyCounts(): OracleCounts {
  return {
    matches: 0,
    mismatches: 0,
    unsupported: 0,
    observation_holes: 0,
    skipped_environments: 0
  };
}

export function tally(counts: OracleCounts, bucket: keyof OracleCounts, amount = 1): OracleCounts {
  return { ...counts, [bucket]: counts[bucket] + amount };
}

export function admitRequestBudget(budget: RequestBudget): "admit" | "resource_rejected" {
  if (budget.finalization_reserve > budget.work_units) return "resource_rejected";
  if (budget.min_envelope > budget.work_units - budget.finalization_reserve) return "resource_rejected";
  if (budget.min_envelope > budget.memory_bytes) return "resource_rejected";
  return "admit";
}

export function mapNativeReaderPage(page: NativeReaderPage): ObserverCoverage {
  if (!page.readerAvailable) {
    return { outcome: { schema_version: 1, status: "unavailable" }, open_regions: [] };
  }
  if (page.truncated && page.ids.length === 0) {
    return { outcome: { schema_version: 1, status: "interrupted" }, open_regions: defaultOpenRegions() };
  }
  if (!page.truncated && page.ids.length === 0) {
    return { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] };
  }
  return {
    outcome: { schema_version: 1, status: page.truncated ? "open" : "exhausted" },
    open_regions: page.truncated ? defaultOpenRegions() : []
  };
}

export function advanceObserverCursor(cursor: ObserverCursor, observedId: string): ObserverCursor {
  return { ...cursor, position: observedId, committed_through: observedId };
}

export function resumeIdsAfterCursor(ids: readonly string[], cursor: ObserverCursor): readonly string[] {
  if (cursor.committed_through === null) return ids;
  const index = ids.indexOf(cursor.committed_through);
  if (index < 0) return ids;
  return ids.slice(index + 1);
}

export function scheduleFairWork(input: Readonly<{
  readonly regions: readonly FairRegion[];
  readonly explorationBudget: number;
  readonly finalizationReserve: number;
}>): Readonly<{
  readonly served: readonly string[];
  readonly remainingReserve: number;
  readonly starvedFinite: boolean;
}> {
  let remaining = input.explorationBudget;
  const served: string[] = [];
  const ordered = [...input.regions].sort((left, right) => Number(right.finite) - Number(left.finite));
  for (const region of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(region.work, remaining);
    if (take <= 0) continue;
    remaining -= take;
    served.push(region.id);
  }
  const finiteIds = input.regions.filter((region) => region.finite).map((region) => region.id);
  return {
    served,
    remainingReserve: input.finalizationReserve,
    starvedFinite: finiteIds.some((id) => !served.includes(id))
  };
}

export function projectOracleIndex(input: IndexOracleInput): InformationIndex {
  const representation = {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    policy: "construct_index_then_page_then_payload" as const,
    page_budget: input.budget.page_budget,
    identity_tie_break: "serialization" as const
  };
  if (continuationInvalidated(input)) return invalidatedIndex(input, representation);
  const admission = completenessForInterpretation(input.interpretation_status);
  if (admission !== undefined) {
    return emptyIndex(input, representation, admission);
  }
  const entries = sortEntries(acceptingEntries(input));
  const offset = input.page_offset ?? 0;
  const page = entries.slice(offset, offset + input.budget.page_budget);
  const remaining = entries.length - offset - page.length;
  const continuation = remaining > 0 && input.expires_at !== undefined
    ? {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        continuation_id: `page-${offset + page.length}`,
        query_id: input.query_id,
        snapshot_id: input.snapshot_id,
        result_version: input.result_version,
        expires_at: input.expires_at,
        cursor: `offset-${offset + page.length}`
      }
    : null;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    entries: page,
    completeness: composeCompleteness(input, entries.length, remaining),
    continuation,
    representation
  };
}

export function interpretationMayEmitCompleteEmpty(status: QueryInterpretationStatus): boolean {
  return status === "resolved";
}

export function milligradeOf(field: EnumeratedField, objectId: string): number {
  let best = 0;
  for (const value of field.accepting) {
    if (value.state.object_id !== objectId) continue;
    best = Math.max(best, value.milligrades);
  }
  return best;
}

export function entryIdentity(entry: Pick<IndexEntry, "object_id" | "hypothesis_id" | "output_binding">): string {
  return `${entry.hypothesis_id}\0${entry.output_binding}\0${entry.object_id}`;
}

export function productIdentity(entry: Pick<IndexEntry, "object_id" | "hypothesis_id" | "output_binding" | "program_state" | "time_state">): string {
  return [
    entry.object_id,
    entry.hypothesis_id,
    entry.output_binding,
    entry.program_state ?? "",
    entry.time_state ?? ""
  ].join("\0");
}

function completenessForInterpretation(
  status: QueryInterpretationStatus | undefined
): CompletenessReport | undefined {
  if (status === "resource_rejected") return uniformCompleteness("resource_rejected");
  if (status === "unsupported" || status === "malformed") return uniformCompleteness("unavailable");
  return undefined;
}

function composeCompleteness(
  input: IndexOracleInput,
  total: number,
  remaining: number
): CompletenessReport {
  const observerStatus = input.observer?.outcome.status;
  const open = (input.observer?.open_regions ?? []).some((region) => region.status === "open")
    || observerStatus === "open";
  if (observerStatus === "unavailable") {
    return withInterpretationCoverage(uniformCompleteness("unavailable", remaining), input);
  }
  if (
    observerStatus === "cancelled"
    || observerStatus === "unknown"
    || observerStatus === "not_applicable"
    || observerStatus === "invalidated"
  ) {
    return withInterpretationCoverage({
      schema_version: 1,
      logical_index: "open",
      observed_coverage: observerStatus,
      transport: remaining > 0 ? "partial" : "open",
      payload: remaining > 0 ? "partial" : "open",
      representation: "complete"
    }, input);
  }
  if (observerStatus === "interrupted" || open) {
    return withInterpretationCoverage({
      schema_version: 1,
      logical_index: "open",
      observed_coverage: observerStatus === "interrupted" ? "interrupted" : "open",
      transport: remaining > 0 ? "partial" : "open",
      payload: remaining > 0 ? "partial" : "open",
      representation: "complete"
    }, input);
  }
  if (total === 0) {
    if (input.interpretation_status !== undefined && !interpretationMayEmitCompleteEmpty(input.interpretation_status)) {
      return withInterpretationCoverage(uniformCompleteness("unavailable"), input);
    }
    return withInterpretationCoverage({
      schema_version: 1,
      logical_index: "complete",
      observed_coverage: "exhausted_empty",
      transport: "complete",
      payload: "complete",
      representation: "complete"
    }, input);
  }
  return withInterpretationCoverage({
    schema_version: 1,
    logical_index: "complete",
    observed_coverage: "complete",
    transport: remaining > 0 ? "partial" : "complete",
    payload: remaining > 0 ? "partial" : "complete",
    representation: "complete"
  }, input);
}

function acceptingEntries(input: IndexOracleInput): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const value of input.field.accepting) {
    const entry = entryForValue(value, input);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

function entryForValue(value: FieldValue, input: IndexOracleInput): IndexEntry | null {
  if (!value.accepting) return null;
  if (value.milligrades <= input.view.threshold_milligrades) return null;
  if (!facetsAccept(value, input)) return null;
  const role = input.roles.get(value.state.object_id) ?? "associated";
  if (role === "routing_only" && !input.view.include_routing_only) return null;
  if (!input.view.requested_roles.includes(role)) return null;
  return {
    schema_version: 1,
    object_id: value.state.object_id,
    hypothesis_id: value.state.hypothesis_id,
    output_binding: value.state.binding_context,
    role,
    association_milligrades: value.milligrades,
    claim: input.claims?.get(value.state.object_id) ?? "unknown",
    explanation_ids: [],
    program_state: value.state.program_state,
    time_state: value.state.time_state
  };
}

function facetsAccept(value: FieldValue, input: IndexOracleInput): boolean {
  const facets = input.facets ?? [];
  if (facets.length === 0) return true;
  const relationKind = input.retained_relation_kinds?.get(value.state.object_id);
  const mode = relationKind === undefined
    ? input.view.facet_mode
    : (input.relation_facet_modes?.get(relationKind) ?? input.view.facet_mode);
  return evaluateFacets(mode, facets, input.view.threshold_milligrades);
}

function sortEntries(entries: readonly IndexEntry[]): IndexEntry[] {
  return [...entries].sort((left, right) => {
    const compared = entryIdentity(left).localeCompare(entryIdentity(right));
    return compared;
  });
}

function continuationInvalidated(input: IndexOracleInput): boolean {
  if (input.as_of !== undefined && input.expires_at !== undefined && input.expires_at < input.as_of) {
    return true;
  }
  const prior = input.prior_continuation;
  if (prior === undefined) return false;
  if (prior.snapshot_id !== input.snapshot_id) return true;
  return input.as_of !== undefined && prior.expires_at < input.as_of;
}

function invalidatedIndex(
  input: IndexOracleInput,
  representation: InformationIndex["representation"]
): InformationIndex {
  return emptyIndex(input, representation, uniformCompleteness("invalidated"));
}

function emptyIndex(
  input: IndexOracleInput,
  representation: InformationIndex["representation"],
  completeness: CompletenessReport
): InformationIndex {
  return {
    schema_version: 1,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    entries: [],
    completeness,
    continuation: null,
    representation
  };
}

function uniformCompleteness(status: CompletenessStatus, remaining = 0): CompletenessReport {
  return {
    schema_version: 1,
    logical_index: status,
    observed_coverage: status,
    transport: remaining > 0 ? "partial" : status,
    payload: remaining > 0 ? "partial" : status,
    representation: status === "unavailable" || status === "resource_rejected" || status === "invalidated"
      ? status
      : "complete"
  };
}

function withInterpretationCoverage(
  report: CompletenessReport,
  input: IndexOracleInput
): CompletenessReport {
  const coverage = interpretationCoverageOf(input);
  if (coverage === undefined) return report;
  return { ...report, interpretation_coverage: coverage };
}

function interpretationCoverageOf(input: IndexOracleInput): CompletenessStatus | undefined {
  if (input.interpretation_coverage !== undefined) return input.interpretation_coverage;
  if ((input.omitted_hypotheses?.length ?? 0) > 0) return "open";
  if (input.interpretation_status === "hypotheses" || input.interpretation_status === "partial") {
    return "open";
  }
  return undefined;
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
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    region_id: id,
    kind,
    status: "open"
  };
}


