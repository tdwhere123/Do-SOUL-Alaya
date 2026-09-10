import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type ClaimState,
  type FacetVector,
  type Guard,
  type IndexRole,
  type QueryProgram,
  type QueryView,
  type RequestBudget,
  type Witness
} from "@do-soul/alaya-protocol";
import {
  productKey,
  type OracleEdge,
  type OracleSeed
} from "./enumerate-simple-paths.js";

export const SNAPSHOT_ID = `sha256:${"b".repeat(64)}`;
export const QUERY_ID = "failed-deployment";
export const RESULT_VERSION = "v1";
export const YESTERDAY_START = "2026-09-05T00:00:00.000Z";
export const YESTERDAY_END = "2026-09-06T00:00:00.000Z";
export const YESTERDAY_INSTANT = "2026-09-05T12:00:00.000Z";
export const LAST_WEEK_INSTANT = "2026-08-30T12:00:00.000Z";
export const INTERPRETATION_CLOCK = "2026-09-06T00:00:00.000Z";
export const FAR_FUTURE_EXPIRY = "2099-01-01T00:00:00.000Z";

export const DEPLOYMENT_MILLIGRADES: Readonly<Record<string, number>> = Object.freeze({
  r: 1000,
  l: 1000,
  c: 1000,
  s: 1000,
  h: 1000,
  u: 0
});

export const OBJECT_OBSERVED_AT: Readonly<Record<string, string>> = Object.freeze({
  r: YESTERDAY_INSTANT,
  c: LAST_WEEK_INSTANT
});

export const DEPLOYMENT_ROLES: ReadonlyMap<string, IndexRole> = new Map([
  ["r", "requested"],
  ["l", "associated"],
  ["c", "associated"],
  ["s", "routing_only"],
  ["h", "associated"],
  ["u", "associated"]
]);

export const DEPLOYMENT_CLAIMS: ReadonlyMap<string, ClaimState> = new Map([
  ["h", "unknown"],
  ["c", "unknown"]
]);

export type FiniteWorld = Readonly<{
  readonly id: string;
  readonly seeds: readonly OracleSeed[];
  readonly edges: readonly OracleEdge[];
  readonly facets: readonly FacetVector[];
  readonly roles: ReadonlyMap<string, IndexRole>;
  readonly claims: ReadonlyMap<string, ClaimState>;
}>;

export function defaultBudget(overrides: Partial<RequestBudget> = {}): RequestBudget {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    work_units: 10_000,
    memory_bytes: 1_000_000,
    page_budget: 800,
    finalization_reserve: 100,
    min_envelope: 10,
    ...overrides
  };
}

export function defaultView(includeRoutingOnly = false): QueryView {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    requested_roles: includeRoutingOnly
      ? ["requested", "associated", "routing_only"]
      : ["requested", "associated"],
    include_routing_only: includeRoutingOnly,
    facet_mode: "same_path",
    threshold_milligrades: 0,
    enumeration_policy: "canonical",
    result_kind_view: "mixed"
  };
}

export function yesterdayAnchorGuard(): Guard {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "interval_relation",
    verdict: "unresolved",
    variable: "r",
    time_scope: "anchor",
    interval: {
      start: YESTERDAY_START,
      end: YESTERDAY_END,
      time_domain: "calendar_day"
    }
  };
}

export function inGuardInterval(
  timestamp: string,
  interval: { readonly start: string; readonly end: string } | undefined
): boolean {
  if (interval === undefined) return false;
  return timestamp >= interval.start && timestamp < interval.end;
}

export function guardAppliesToVariable(guard: Guard, variable: string): boolean {
  if (guard.time_scope === "none" || guard.variable === undefined) return false;
  return guard.variable === variable;
}

export function deploymentWorld(): FiniteWorld {
  return {
    id: "deployment",
    seeds: [{ state: productKey("r"), milligrades: 1000 }],
    edges: [
      edge("r", "l", "observed_log", 1000, true, 50),
      edge("l", "c", "config_via_log", 1000, true, 150),
      edge("r", "c", "config_direct", 1000, true, 200),
      edge("r", "s", "uses_service", 1000, true, 100),
      edge("s", "h", "service_history", 1000, true, 450),
      edge("r", "u", "unrelated", 1000, false, 0)
    ],
    facets: [],
    roles: DEPLOYMENT_ROLES,
    claims: DEPLOYMENT_CLAIMS
  };
}

export function deploymentProgram(): QueryProgram {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "sequence",
    steps: [
      {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        kind: "relation",
        relation_kind: "failed_deployment",
        source_variable: "anchor",
        target_variable: "r",
        guard: yesterdayAnchorGuard(),
        facet_mode: "same_path",
        threshold_milligrades: 0
      },
      {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        kind: "alternative",
        options: [
          relation("associated_config", "r", "c", "none"),
          relation("associated_history", "s", "h", "none")
        ]
      }
    ]
  };
}

export function longChainWorld(hops: number, fanOut: number): FiniteWorld {
  const seeds: OracleSeed[] = [
    { state: productKey("n0"), milligrades: 900 },
    { state: productKey("s"), milligrades: 900 }
  ];
  const edges: OracleEdge[] = [];
  for (let index = 0; index < hops; index += 1) {
    edges.push(edge(`n${index}`, `n${index + 1}`, "chain", 900, true, 10));
  }
  const roles = new Map<string, IndexRole>([["n0", "requested"], ["s", "routing_only"]]);
  for (let index = 0; index < fanOut; index += 1) {
    edges.push(edge("s", `h${index}`, "service_history", 550, true, 450));
    roles.set(`h${index}`, "associated");
  }
  roles.set(`n${hops}`, "associated");
  return { id: "long-chain", seeds, edges, facets: [], roles, claims: new Map() };
}

export function cyclicWorld(): FiniteWorld {
  return {
    id: "cycle",
    seeds: [{ state: productKey("a"), milligrades: 1000 }],
    edges: [
      edge("a", "b", "loop", 900, true, 100),
      edge("b", "a", "loop", 900, true, 100),
      edge("a", "c", "branch", 800, true, 200)
    ],
    facets: [],
    roles: new Map([["a", "requested"], ["b", "associated"], ["c", "associated"]]),
    claims: new Map()
  };
}

export function samePathFacetVectors(): readonly FacetVector[] {
  return [
    { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, path_id: "p1", coordinates: [900, 200] },
    { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, path_id: "p2", coordinates: [200, 900] }
  ];
}

export function hypothesisWorld(): FiniteWorld {
  return {
    id: "hypotheses",
    seeds: [
      { state: productKey("c", "h1"), milligrades: 850 },
      { state: productKey("c", "h2"), milligrades: 400 },
      { state: productKey("c", "h1", "bind-b"), milligrades: 700 }
    ],
    edges: [],
    facets: [],
    roles: new Map([["c", "associated"]]),
    claims: new Map()
  };
}

export function cheapAlternateWitnesses(): readonly Witness[] {
  return [
    { schema_version: 1, witness_id: "expensive", premises: ["strong"], cost: 1200, complete: true },
    { schema_version: 1, witness_id: "cheap", premises: ["alternate"], cost: 400, complete: true },
    { schema_version: 1, witness_id: "partial", premises: ["partial"], cost: 100, complete: false }
  ];
}

export type NativeReaderPage = Readonly<{
  readonly ids: readonly string[];
  readonly truncated: boolean;
  readonly readerAvailable: boolean;
}>;

export type SourceRow = Readonly<{
  readonly object_id: string;
  readonly generation_id: string;
  readonly retention: "live" | "tombstoned";
  readonly source_revision: string;
  readonly observed_at: string;
}>;

export type SqliteSourceFixture = Readonly<{
  readonly id: string;
  readonly rows: readonly SourceRow[];
  readonly reader: NativeReaderPage;
  readonly worker: "running" | "cancelled";
  readonly provider_calls: number;
  readonly garden_enqueue: number;
}>;

export function sqliteInterruptedZero(): SqliteSourceFixture {
  return {
    id: "interrupted-zero",
    rows: liveDeploymentRows("gen-1"),
    reader: { ids: [], truncated: true, readerAvailable: true },
    worker: "running",
    provider_calls: 0,
    garden_enqueue: 0
  };
}

export function sqliteTombstoneRestart(): SqliteSourceFixture {
  return {
    id: "tombstone-restart",
    rows: [
      ...liveDeploymentRows("gen-1").filter((row) => row.object_id !== "u"),
      {
        object_id: "u",
        generation_id: "gen-1",
        retention: "tombstoned",
        source_revision: "src-u",
        observed_at: INTERPRETATION_CLOCK
      }
    ],
    reader: { ids: ["r", "l", "c", "s", "h"], truncated: false, readerAvailable: true },
    worker: "running",
    provider_calls: 0,
    garden_enqueue: 0
  };
}

export function sqliteMixedGeneration(): SqliteSourceFixture {
  return {
    id: "mixed-generation",
    rows: [
      ...liveDeploymentRows("gen-1").slice(0, 3),
      ...liveDeploymentRows("gen-2").slice(3)
    ],
    reader: { ids: ["r", "l", "c", "s", "h"], truncated: false, readerAvailable: true },
    worker: "running",
    provider_calls: 0,
    garden_enqueue: 0
  };
}

export function sqliteCancelledWorker(): SqliteSourceFixture {
  return {
    id: "cancelled-worker",
    rows: liveDeploymentRows("gen-1"),
    reader: { ids: [], truncated: true, readerAvailable: true },
    worker: "cancelled",
    provider_calls: 0,
    garden_enqueue: 0
  };
}

export function sqliteNormalEntryCounters(): SqliteSourceFixture {
  return {
    id: "normal-entry-counters",
    rows: liveDeploymentRows("gen-1"),
    reader: { ids: ["r", "l", "c"], truncated: false, readerAvailable: true },
    worker: "running",
    provider_calls: 0,
    garden_enqueue: 0
  };
}

function liveDeploymentRows(generationId: string): readonly SourceRow[] {
  return ["r", "l", "c", "s", "h", "u"].map((objectId) => ({
    object_id: objectId,
    generation_id: generationId,
    retention: "live" as const,
    source_revision: `src-${objectId}`,
    observed_at: OBJECT_OBSERVED_AT[objectId] ?? INTERPRETATION_CLOCK
  }));
}

function edge(
  from: string,
  to: string,
  relationKind: string,
  strength: number,
  applicable: boolean,
  cost: number
): OracleEdge {
  return {
    from: productKey(from),
    to: productKey(to),
    relation_kind: relationKind,
    strength_milligrades: strength,
    applicable,
    cost
  };
}

function relation(
  relationKind: string,
  source: string,
  target: string,
  timeScope: Guard["time_scope"]
): QueryProgram {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "relation",
    relation_kind: relationKind,
    source_variable: source,
    target_variable: target,
    guard: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: timeScope === "none" ? "query_predicate" : "interval_relation",
      verdict: "true",
      variable: target,
      time_scope: timeScope
    },
    facet_mode: "same_path",
    threshold_milligrades: 0
  };
}
