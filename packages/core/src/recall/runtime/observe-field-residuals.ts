import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type CoverageRegion,
  type ObserverAction,
  type ObserverCursor,
  type ObserverStatus,
  type QueryInterpretation
} from "@do-soul/alaya-protocol";
import { startObserverCursor } from "../conditional-field/observers/observe.js";
import { applyObserverPage, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { hasOpenPairs } from "../conditional-field/engine/path-composition.js";

const INCOMPLETE_OBSERVER: ReadonlySet<ObserverStatus> = new Set([
  "cancelled",
  "unavailable",
  "interrupted",
  "unknown",
  "not_applicable",
  "invalidated"
]);

export function openResiduals(includeBinding: boolean, includeGuard: boolean): readonly CoverageRegion[] {
  const residuals: CoverageRegion[] = [
    residual("seed", "seed"),
    residual("adjacency", "adjacency"),
    residual("discovery", "discovery")
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
    || hasOpenPairs(subjects, predicates, pairProgress, state.discoveries);
  const status = state.memory_exhausted || adjacency?.status === "interrupted" || state.last_observer_status === "interrupted"
    ? "interrupted"
    : busy ? "open" : "exhausted";
  return closeDiscovery(state, interpretation, cursors, status);
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
    || status === "unknown"
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
  status: ObserverStatus
): FieldEngineState {
  return applyObserverPage(state, {
    page: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      query_id: interpretation.query_id,
      snapshot_id: interpretation.snapshot_id,
      cursor: cursorOf(cursors, interpretation, regionId),
      observations: [],
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status },
      open_regions: [{
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        region_id: regionId,
        kind,
        status
      }]
    },
    effects: []
  });
}

function residual(id: string, kind: CoverageRegion["kind"]): CoverageRegion {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    region_id: id,
    kind,
    status: "open"
  };
}
