import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_TOP,
  type CoverageRegion,
  type ObserverAction,
  type ObserverCursor,
  type ObserverStatus,
  type QueryInterpretation,
  type ResultKindView
} from "@do-soul/alaya-protocol";
import { startObserverCursor } from "../conditional-field/observers/observe.js";
import { applyObserverPage, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { isPhysicalRegionKind } from "../conditional-field/engine/field-update.js";
import { hasOpenPairs } from "../conditional-field/engine/path-composition.js";

const INCOMPLETE_OBSERVER: ReadonlySet<ObserverStatus> = new Set([
  "cancelled",
  "unavailable",
  "interrupted",
  "not_applicable",
  "invalidated"
]);

export type SourceDomainCoverage = Readonly<{
  readonly resultKindView?: ResultKindView;
  readonly hasSourceReader?: boolean;
  readonly truncated?: boolean;
  readonly unavailable?: boolean;
  readonly settled?: boolean;
  readonly hypothesisId?: string;
  readonly programBranch?: string;
}>;

export function openResiduals(
  includeBinding: boolean,
  includeGuard: boolean,
  coverage?: SourceDomainCoverage
): readonly CoverageRegion[] {
  const residuals: CoverageRegion[] = [
    residual("seed", "seed"),
    residual("adjacency", "adjacency"),
    residual("discovery", "discovery"),
    sourceDomainRegion(coverage)
  ];
  if (includeGuard) residuals.push(residual("guard", "guard"));
  if (includeBinding) residuals.push(residual("binding", "binding"));
  return residuals;
}

export function closeAdjacency(
  state: FieldEngineState,
  interpretation: QueryInterpretation,
  action: ObserverAction,
  cursors: Map<string, ObserverCursor>,
  kindsOpen: boolean
): FieldEngineState {
  if (incompleteObserver(state.last_observer_status)) return state;
  const status = kindsOpen ? "open" : "exhausted";
  return closeDiscovery(
    closeRegion(state, interpretation, action, cursors, status),
    interpretation,
    cursors,
    status
  );
}

export function settleDiscoveryResidual(
  state: FieldEngineState,
  interpretation: QueryInterpretation,
  cursors: Map<string, ObserverCursor>,
  subjects: ReadonlySet<string>,
  predicates: readonly string[],
  pairProgress: ReadonlyMap<string, string | null>
): FieldEngineState {
  if (incompleteObserver(state.last_observer_status) || terminalObserver(state.last_observer_status)) {
    return state;
  }
  const adjacency = state.residuals.find((region) => region.kind === "adjacency");
  const busy = adjacency?.status === "open"
    || adjacency?.status === "interrupted"
    || hasOpenPairs(subjects, predicates, pairProgress, [], state.pair_completed_count);
  const status = state.memory_exhausted || adjacency?.status === "interrupted" || state.last_observer_status === "interrupted"
    ? "interrupted"
    : busy ? "open" : "exhausted";
  return closeDiscovery(state, interpretation, cursors, status);
}

export function settleSourceDomainResidual(
  state: FieldEngineState,
  interpretation: QueryInterpretation,
  cursors: Map<string, ObserverCursor>,
  coverage: SourceDomainCoverage
): FieldEngineState {
  if (state.last_observer_status === "cancelled" || state.last_observer_status === "invalidated") {
    return state;
  }
  const region = sourceDomainRegion({
    ...coverage,
    settled: true,
    hypothesisId: coverage.hypothesisId ?? interpretation.hypotheses[0]?.hypothesis_id ?? "h0",
    programBranch: coverage.programBranch ?? "accepting"
  });
  const current = state.residuals.find((row) => row.kind === "source_domain");
  if (current !== undefined && current.status === region.status) return state;
  return applyCoverage(
    state,
    interpretation,
    cursors,
    region.region_id,
    "source_domain",
    region.status,
    region
  );
}

export function closeRegion(
  state: FieldEngineState,
  interpretation: QueryInterpretation,
  action: ObserverAction,
  cursors: Map<string, ObserverCursor>,
  status: ObserverStatus
): FieldEngineState {
  const kind = action.action === "seed"
    ? "seed"
    : action.action === "measurement"
      ? "binding"
      : "adjacency";
  return applyCoverage(state, interpretation, cursors, action.region_id, kind, status);
}

export function cursorOf(
  cursors: Map<string, ObserverCursor>,
  interpretation: QueryInterpretation,
  regionId: string
): ObserverCursor {
  const existing = cursors.get(regionId);
  if (existing !== undefined) return existing;
  const created = startObserverCursor({
    cursor_id: regionId,
    snapshot_id: interpretation.snapshot_id,
    query_id: interpretation.query_id,
    region_id: regionId
  });
  cursors.set(regionId, created);
  return created;
}

export function incompleteObserver(status: ObserverStatus | undefined): boolean {
  return status !== undefined && INCOMPLETE_OBSERVER.has(status);
}

export function terminalObserver(status: ObserverStatus | undefined): boolean {
  return status === "cancelled"
    || status === "unavailable"
    || status === "not_applicable"
    || status === "invalidated";
}

function closeDiscovery(
  state: FieldEngineState,
  interpretation: QueryInterpretation,
  cursors: Map<string, ObserverCursor>,
  status: ObserverStatus
): FieldEngineState {
  const current = state.residuals.find((region) => region.kind === "discovery");
  if (current === undefined || current.status === status) return state;
  return applyCoverage(state, interpretation, cursors, "discovery", "discovery", status);
}

function applyCoverage(
  state: FieldEngineState,
  interpretation: QueryInterpretation,
  cursors: Map<string, ObserverCursor>,
  regionId: string,
  kind: CoverageRegion["kind"],
  status: ObserverStatus,
  overlay?: CoverageRegion
): FieldEngineState {
  return applyObserverPage(state, {
    page: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      query_id: interpretation.query_id,
      snapshot_id: interpretation.snapshot_id,
      cursor: cursorOf(cursors, interpretation, regionId),
      observations: [],
      // Semantic coverage annotates native progress; it is not another native observation.
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        status: isPhysicalRegionKind(kind) ? status : state.last_observer_status ?? "open" },
      open_regions: [overlay ?? residual(regionId, kind, status)]
    },
    effects: []
  });
}

function sourceDomainRegion(coverage?: SourceDomainCoverage): CoverageRegion {
  const status = sourceDomainStatus(coverage);
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    region_id: "source_domain",
    kind: "source_domain",
    status,
    cursor_id: "source_domain",
    coverage_role: "required",
    source_domain: "source_evidence",
    hypothesis_id: coverage?.hypothesisId ?? "h0",
    program_branch: coverage?.programBranch ?? "accepting",
    output_obligations: ["membership"],
    semantic_effects: ["membership", "grade_bound"],
    ...(status === "not_applicable" ? {} : { conservative_bound_milligrades: MILLIGRADE_TOP })
  };
}

function sourceDomainStatus(coverage?: SourceDomainCoverage): ObserverStatus {
  const view = coverage?.resultKindView ?? "mixed";
  if (view === "memory_only") return "not_applicable";
  if (coverage?.unavailable === true) return "unavailable";
  if (coverage?.hasSourceReader !== true) return view === "source_only" ? "unavailable" : "unknown";
  if (coverage.truncated === true) return "open";
  if (coverage.settled === true) return "exhausted";
  return "open";
}

function residual(
  id: string,
  kind: CoverageRegion["kind"],
  status: ObserverStatus = "open"
): CoverageRegion {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    region_id: id,
    kind,
    status,
    cursor_id: id,
    coverage_role: kind === "discovery" ? "optional_accelerator" : "required",
    ...(kind === "discovery" ? { source_domain: "source_evidence" } : {})
  };
}
