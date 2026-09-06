import {
  MILLIGRADE_BOTTOM,
  type ClaimState,
  type CompletenessReport,
  type CoverageRegion,
  type FacetMode,
  type FacetVector,
  type FieldSnapshot,
  type FieldValue,
  type IndexEntry,
  type IndexRole,
  type InformationIndex,
  type ObserverOutcome,
  type QueryView,
  type RequestBudget,
  type SupportRecord,
  type Witness
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import { stableStringify } from "../../../shared/stable-stringify.js";

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

export function joinHyperedgeAnd(premisesPresent: readonly boolean[]): boolean {
  return premisesPresent.length > 0 && premisesPresent.every((present) => present);
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

export function mapNativeReaderPage(input: Readonly<{
  readonly ids: readonly string[];
  readonly truncated: boolean;
  readonly readerAvailable: boolean;
  readonly regions?: readonly CoverageRegion[];
}>): Readonly<{
  readonly outcome: ObserverOutcome;
  readonly open_regions: readonly CoverageRegion[];
}> {
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
  const entries = sortEntries(acceptingEntries(input));
  const offset = input.page_offset ?? 0;
  const page = entries.slice(offset, offset + input.budget.page_budget);
  const remaining = entries.length - offset - page.length;
  const continuation: InformationIndex["continuation"] = remaining > 0
    ? {
        schema_version: 1,
        continuation_id: `page-${offset + page.length}`,
        query_id: input.query_id,
        snapshot_id: input.snapshot_id,
        result_version: input.result_version,
        expires_at: input.expires_at ?? "9999-12-31T00:00:00.000Z",
        cursor: `offset-${offset + page.length}`
      }
    : null;
  return {
    schema_version: 1,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    entries: page,
    completeness: completenessForPage(entries.length, remaining),
    continuation,
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
  if (!value.accepting || value.milligrades <= MILLIGRADE_BOTTOM) return null;
  const role = input.roles?.get(value.state.object_id) ?? "associated";
  if (role === "routing_only" && !input.view.include_routing_only) return null;
  if (!input.view.requested_roles.includes(role)) return null;
  return {
    schema_version: 1,
    object_id: value.state.object_id,
    hypothesis_id: value.state.hypothesis_id,
    role,
    association_milligrades: value.milligrades,
    claim: input.claims?.get(value.state.object_id) ?? "unknown",
    explanation_ids: explanationIds(input.support, input.budget.page_budget)
  };
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
  return [...entries].sort((left, right) => compareText(
    stableStringify({ object_id: left.object_id, hypothesis_id: left.hypothesis_id }),
    stableStringify({ object_id: right.object_id, hypothesis_id: right.hypothesis_id })
  ));
}

function completenessForPage(
  total: number,
  remaining: number
): CompletenessReport {
  if (total === 0) {
    return {
      schema_version: 1,
      logical_index: "complete",
      observed_coverage: "exhausted_empty",
      transport: "complete",
      payload: "complete",
      representation: "complete"
    };
  }
  return {
    schema_version: 1,
    logical_index: "complete",
    observed_coverage: "complete",
    transport: remaining > 0 ? "partial" : "complete",
    payload: remaining > 0 ? "partial" : "complete",
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
