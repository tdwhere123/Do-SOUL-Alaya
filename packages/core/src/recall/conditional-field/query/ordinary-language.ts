import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type FacetMode,
  type Guard,
  type QueryProgram,
  type QueryTimeWindow
} from "@do-soul/alaya-protocol";

export const SUPPORTED_FAILED_DEPLOYMENT_QUERY_ID = "failed-deployment";

export type OpenRelationCapture = Readonly<{
  readonly relation_kind: string;
  readonly source_variable: string;
  readonly target_variable: string;
  readonly guard?: Guard;
  readonly facet_mode?: FacetMode;
  readonly threshold_milligrades?: number;
}>;

export type OrdinaryRequestClass =
  | { readonly kind: "supported" }
  | { readonly kind: "partial"; readonly missing: "time" }
  | { readonly kind: "hypotheses" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "malformed" };

const YESTERDAY_PATTERN = /\b(?:yesterday|previous day|last day)\b/u;
const FAILED_PATTERN = /\b(?:failed|failure|unsuccessful)\b/u;
const DEPLOY_PATTERN = /\bdeploy(?:ed|ment|s)?\b/u;

export function normalizeOrdinaryText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

export function calendarYesterdayWindow(clockIso: string): QueryTimeWindow | undefined {
  const clock = new Date(clockIso);
  if (Number.isNaN(clock.getTime())) return undefined;
  const endMs = Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate());
  return {
    start: new Date(endMs - 86_400_000).toISOString(),
    end: new Date(endMs).toISOString()
  };
}

export function classifyOrdinaryRequest(text: string): OrdinaryRequestClass {
  const normalized = normalizeOrdinaryText(text);
  if (normalized.length === 0) return { kind: "malformed" };
  const hasYesterday = YESTERDAY_PATTERN.test(normalized);
  const hasFailed = FAILED_PATTERN.test(normalized);
  const hasDeploy = DEPLOY_PATTERN.test(normalized);
  if (hasFailed && hasDeploy) {
    return hasYesterday ? { kind: "supported" } : { kind: "partial", missing: "time" };
  }
  if (hasYesterday && hasFailed) return { kind: "hypotheses" };
  return { kind: "unsupported" };
}

// Yesterday is an event-variable interval. Applying it to associated items drops last-week config.
export function yesterdayAnchorGuard(window: QueryTimeWindow, variable = "r"): Guard {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "interval_relation",
    verdict: "unresolved",
    variable,
    time_scope: "anchor",
    interval: {
      start: window.start,
      end: window.end,
      time_domain: "calendar_day"
    }
  };
}

export function openAnchorTimeGuard(variable = "r"): Guard {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "interval_relation",
    verdict: "unresolved",
    variable,
    time_scope: "anchor"
  };
}

export function associatedItemGuard(variable: string): Guard {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "query_predicate",
    verdict: "unresolved",
    variable,
    time_scope: "none"
  };
}

export function supportedFailedDeploymentProgram(anchorGuard: Guard): QueryProgram {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "sequence",
    steps: [
      relationProgram("failed_deployment", "anchor", "r", anchorGuard),
      {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        kind: "alternative",
        options: [
          relationProgram("associated_config", "r", "c", associatedItemGuard("c")),
          relationProgram("associated_history", "s", "h", associatedItemGuard("h"))
        ]
      }
    ]
  };
}

export function programFromOpenRelations(
  relations: readonly OpenRelationCapture[],
  anchorGuard?: Guard
): QueryProgram | undefined {
  if (relations.length === 0) return undefined;
  const nodes = relations.map((item, index) => relationProgram(
    item.relation_kind,
    item.source_variable,
    item.target_variable,
    guardForOpenRelation(item, index, anchorGuard),
    item.facet_mode ?? "same_path",
    item.threshold_milligrades ?? 0
  ));
  const first = nodes[0];
  if (first === undefined) return undefined;
  if (nodes.length === 1) return first;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "sequence",
    steps: nodes
  };
}

function guardForOpenRelation(
  item: OpenRelationCapture,
  index: number,
  anchorGuard: Guard | undefined
): Guard {
  if (item.guard !== undefined) return item.guard;
  if (index === 0 && anchorGuard !== undefined) {
    return { ...anchorGuard, variable: item.target_variable };
  }
  return associatedItemGuard(item.target_variable);
}

function relationProgram(
  relationKind: string,
  source: string,
  target: string,
  guard: Guard,
  facetMode: FacetMode = "same_path",
  thresholdMilligrades = 0
): QueryProgram {
  // relation_kind is caller data; this compiler has no keyword catalog of names.
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "relation",
    relation_kind: relationKind,
    source_variable: source,
    target_variable: target,
    guard,
    facet_mode: facetMode,
    threshold_milligrades: thresholdMilligrades
  };
}
