import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  compareUtcInstants,
  GuardSchema,
  IsoDatetimeStringSchema,
  type FacetMode,
  type Guard,
  type QueryHole,
  type QueryProgram,
  type QueryTimeWindow
} from "@do-soul/alaya-protocol";
import { failedDeploymentVerdict } from "./source-event.js";

export type OpenRelationCapture = Readonly<{
  readonly relation_kind: string;
  readonly source_variable: string;
  readonly target_variable: string;
  readonly guard?: Guard;
  readonly facet_mode?: FacetMode;
  readonly threshold_milligrades?: number;
}>;

export function normalizeOrdinaryText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// An explicit event-variable interval is distinct from a global source filter.
export function anchorTimeGuard(window: QueryTimeWindow, variable = ANCHOR_EVENT_VARIABLE): Guard {
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

export const STORED_RELATION_KIND = "stored_relation";
export const SOURCE_FILTER_PREDICATE = "source.filters";
export const UNINTERPRETED_HOLE_ID = "hole.query.uninterpreted";
export const ANCHOR_EVENT_VARIABLE = "r";
export const SERVICE_VARIABLE = "s";
export const USES_SERVICE_RELATION = "uses_service";
export const UNBOUND_BINDING_CONTEXT = "unbound";

export type OrdinarySourceFilters = Readonly<{
  readonly event_kind?: "failed_deployment";
  readonly dimension_filter?: readonly string[];
  readonly domain_tag_filter?: readonly string[];
  readonly time_field?: "created_at" | "last_used_at";
  readonly since?: string;
  readonly until?: string;
}>;

export class SourceFilterCapacityError extends RangeError {}

// Supported ordinary steps name query roles; planted freeze edges keep stored predicates.
export const SUPPORTED_RELATION_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  failed_deployment: Object.freeze(["observed_log"]),
  associated_config: Object.freeze(["config_via_log", "config_direct"]),
  associated_history: Object.freeze(["service_history"])
});

export function uninterpretedQueryHole(): QueryHole {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    hole_id: UNINTERPRETED_HOLE_ID,
    variable: "q",
    status: "unresolved"
  };
}

export function encodeSourceFilters(filters: OrdinarySourceFilters): string | undefined {
  const entries = Object.entries(filters).filter(([, value]) => value !== undefined
    && (!Array.isArray(value) || value.length > 0));
  if (entries.length === 0) return undefined;
  const packed = `${SOURCE_FILTER_PREDICATE}:${JSON.stringify(Object.fromEntries(entries))}`;
  if (!sourceFilterPredicateFits(packed)) {
    throw new SourceFilterCapacityError("Source filters exceed the conditional-field predicate capacity");
  }
  return packed;
}

export function decodeSourceFilters(predicateName: string | undefined): OrdinarySourceFilters | undefined {
  const prefix = `${SOURCE_FILTER_PREDICATE}:`;
  if (predicateName === undefined || !predicateName.startsWith(SOURCE_FILTER_PREDICATE)) {
    return undefined;
  }
  if (!predicateName.startsWith(prefix) || !sourceFilterPredicateFits(predicateName)) {
    throw new TypeError("Invalid conditional-field source filter predicate");
  }
  const parsed: unknown = JSON.parse(predicateName.slice(prefix.length));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new TypeError("Invalid conditional-field source filters");
  }
  for (const [key, value] of Object.entries(parsed)) {
    const valid = key === "dimension_filter" || key === "domain_tag_filter"
      ? Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)
      : key === "event_kind" ? value === "failed_deployment"
      : key === "time_field" ? value === "created_at" || value === "last_used_at"
      : (key === "since" || key === "until") && IsoDatetimeStringSchema.safeParse(value).success;
    if (!valid) throw new TypeError("Invalid conditional-field source filters");
  }
  return parsed as OrdinarySourceFilters;
}

function sourceFilterPredicateFits(predicate_name: string): boolean {
  return GuardSchema.safeParse({ schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "query_predicate", predicate_name }).success;
}

export function attachSourceFilters(program: QueryProgram, filters: OrdinarySourceFilters): QueryProgram {
  const encoded = encodeSourceFilters(filters);
  if (encoded === undefined) return program;
  return mapProgramGuards(program, (guard) => (
    guard.predicate_name === undefined || guard.predicate_name.startsWith(SOURCE_FILTER_PREDICATE)
      ? { ...guard, predicate_name: encodeSourceFilters({ ...decodeSourceFilters(guard.predicate_name), ...filters }) }
      : guard
  ));
}

export function sourceFactsSatisfyFilters(
  filters: OrdinarySourceFilters,
  facts: Readonly<{
    readonly dimension?: string;
    readonly domain_tags?: readonly string[];
    readonly created_at?: string;
    readonly last_used_at?: string | null;
    readonly observed_at?: string;
    readonly content?: string;
    readonly content_complete?: boolean;
    readonly root_kind?: string;
    readonly original_complete?: boolean;
    readonly content_start?: number;
    readonly event_time?: string | null;
  }> | undefined
): "true" | "false" | "unresolved" {
  if (facts === undefined) return "unresolved";
  let unresolved = false;
  const root = facts.root_kind !== undefined;
  if (filters.event_kind === "failed_deployment") {
    // Governed memory reads are whole rows; native roots must prove both the
    // original context and the current read complete, not merely an excerpt.
    const complete = root ? facts.original_complete === true && facts.content_complete === true &&
      (facts.content_start ?? 0) === 0 : facts.content_complete;
    const verdict = failedDeploymentVerdict(facts.content, complete);
    if (verdict === "false") return "false";
    unresolved ||= verdict === "unresolved";
  }
  if (filters.dimension_filter !== undefined && filters.dimension_filter.length > 0) {
    if (root || facts.dimension === undefined) unresolved = true;
    else if (!filters.dimension_filter.includes(facts.dimension)) return "false";
  }
  if (filters.domain_tag_filter !== undefined && filters.domain_tag_filter.length > 0) {
    const tags = facts.domain_tags ?? [];
    if (root) unresolved = true;
    else if (!filters.domain_tag_filter.some((tag) => tags.includes(tag))) return "false";
  }
  const stamp = timestampForSourceFilters(facts, filters);
  if (filters.since !== undefined || filters.until !== undefined) {
    const sinceOrder = filters.since === undefined ? 0 : stamp === undefined ? undefined : compareUtcInstants(stamp, filters.since);
    const untilOrder = filters.until === undefined ? 0 : stamp === undefined ? undefined : compareUtcInstants(stamp, filters.until);
    if ((sinceOrder !== undefined && sinceOrder < 0) || (untilOrder !== undefined && untilOrder > 0)) return "false";
    unresolved ||= stamp === undefined || sinceOrder === undefined || untilOrder === undefined;
  }
  return unresolved ? "unresolved" : "true";
}

function timestampForSourceFilters(
  facts: Readonly<{
    readonly created_at?: string;
    readonly last_used_at?: string | null;
    readonly observed_at?: string;
    readonly root_kind?: string;
    readonly event_time?: string | null;
  }>,
  filters: OrdinarySourceFilters
): string | undefined {
  if (facts.root_kind !== undefined) return filters.time_field === undefined ? facts.event_time ?? undefined : undefined;
  if (filters.time_field === "last_used_at") return facts.last_used_at ?? undefined;
  if (filters.time_field === "created_at") return facts.created_at;
  return facts.observed_at;
}

function mapProgramGuards(program: QueryProgram, map: (guard: Guard) => Guard): QueryProgram {
  if (program.kind === "relation") return { ...program, guard: map(program.guard) };
  if (program.kind === "sequence") {
    return { ...program, steps: program.steps.map((step) => mapProgramGuards(step, map)) };
  }
  if (program.kind === "alternative") {
    return { ...program, options: program.options.map((option) => mapProgramGuards(option, map)) };
  }
  if (program.kind === "repeat" || program.kind === "closure") {
    return { ...program, body: mapProgramGuards(program.body, map) };
  }
  if (program.kind === "hyperedge") {
    return { ...program, premises: program.premises.map((premise) => mapProgramGuards(premise, map)) };
  }
  return program;
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

export function sourceBoundEntityGuard(variable: string, entityId?: string): Guard {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "source_bound_entity",
    verdict: "unresolved",
    variable,
    time_scope: "none",
    ...(entityId === undefined ? {} : { entity_id: entityId })
  };
}

export function proposeOrdinaryRelations(text: string): readonly OpenRelationCapture[] {
  const match = /^\s*(?:find|show)\s+([\p{L}\p{N}_-]+)\s+from\s+([\p{L}\p{N}_-]+)\s+to\s+([\p{L}\p{N}_-]+)\s*$/iu.exec(text);
  return match === null ? [] : [{ relation_kind: match[1]!, source_variable: match[2]!, target_variable: match[3]! }];
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
