import {
  type CoverageRegion,
  type ObserverCursor,
  type ObserverOutcome,
  type ObserverStatus,
  type Witness
} from "@do-soul/alaya-protocol";

export {
  evaluateFacetPredicate,
  evaluateSamePathPredicate
} from "../engine/facet-predicates.js";

export type ObserverCoverage = Readonly<{
  readonly outcome: ObserverOutcome;
  readonly open_regions?: readonly CoverageRegion[];
}>;

export function aggregateObserverStatus(last: ObserverStatus | undefined, residuals: readonly CoverageRegion[]): ObserverStatus {
  const statuses = new Set([last, ...residuals.map((region) => region.status)]);
  for (const status of ["invalidated", "cancelled", "unavailable", "unknown", "not_applicable", "interrupted", "open"] as const) {
    if (statuses.has(status)) return status;
  }
  return last === "exhausted" ? "exhausted" : "open";
}

export type HyperedgePremise = Readonly<{
  readonly hypothesis_id: string;
  readonly binding_context: string;
  readonly time_state: string;
  readonly present: boolean;
}>;

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
