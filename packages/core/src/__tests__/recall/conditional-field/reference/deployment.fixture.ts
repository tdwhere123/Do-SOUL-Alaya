import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type Guard,
  type IndexRole,
  type ProductStateKey,
  type QueryProgram,
  type QueryView,
  type RequestBudget,
  type SeedActivation,
  type Transition
} from "@do-soul/alaya-protocol";

export const SNAPSHOT_ID = `sha256:${"c".repeat(64)}`;
export const QUERY_ID = "failed-deployment";
export const RESULT_VERSION = "v1";
export const YESTERDAY_START = "2026-09-05T00:00:00.000Z";
export const YESTERDAY_END = "2026-09-06T00:00:00.000Z";
export const YESTERDAY_INSTANT = "2026-09-05T12:00:00.000Z";
export const LAST_WEEK_INSTANT = "2026-08-30T12:00:00.000Z";
export const INTERPRETATION_CLOCK = "2026-09-06T00:00:00.000Z";
export const FAR_FUTURE_EXPIRY = "2099-01-01T00:00:00.000Z";
export const OBJECT_OBSERVED_AT: Readonly<Record<string, string>> = {
  r: YESTERDAY_INSTANT,
  c: LAST_WEEK_INSTANT
};

export const DEPLOYMENT_OBJECTS = ["r", "l", "c", "s", "h", "u"] as const;

export const DEPLOYMENT_ROLES: ReadonlyMap<string, IndexRole> = new Map([
  ["r", "requested"],
  ["l", "associated"],
  ["c", "associated"],
  ["s", "routing_only"],
  ["h", "associated"],
  ["u", "associated"]
]);

export function productKey(
  objectId: string,
  hypothesisId = "h0",
  bindingContext = "default",
  programState = "accepting"
): ProductStateKey {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    object_id: objectId,
    program_state: programState,
    hypothesis_id: hypothesisId,
    binding_context: bindingContext,
    time_state: "as_of"
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
    threshold_milligrades: 0
  };
}

export function deploymentSeeds(): readonly SeedActivation[] {
  return [{
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state: productKey("r"),
    milligrades: 1000
  }];
}

export function deploymentTransitions(): readonly Transition[] {
  return [
    edge("r", "l", "observed_log", 950, true),
    edge("l", "c", "config_via_log", 850, true),
    edge("r", "c", "config_direct", 800, true),
    edge("r", "s", "uses_service", 900, true),
    edge("s", "h", "service_history", 550, true),
    edge("r", "u", "unrelated", 1000, false)
  ];
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
          {
            schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
            kind: "relation",
            relation_kind: "associated_config",
            source_variable: "r",
            target_variable: "c",
            guard: {
              schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
              kind: "interval_relation",
              verdict: "true",
              variable: "c",
              time_scope: "none"
            },
            facet_mode: "same_path",
            threshold_milligrades: 0
          },
          {
            schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
            kind: "relation",
            relation_kind: "associated_history",
            source_variable: "s",
            target_variable: "h",
            guard: {
              schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
              kind: "query_predicate",
              verdict: "unresolved",
              variable: "h",
              time_scope: "none"
            },
            facet_mode: "same_path",
            threshold_milligrades: 0
          }
        ]
      }
    ]
  };
}

export function collectTimeScopedVariables(program: QueryProgram): readonly string[] {
  const scoped: string[] = [];
  visitProgram(program, (node) => {
    if (node.kind === "relation" && node.guard.time_scope === "anchor" && node.guard.variable) {
      scoped.push(node.guard.variable);
    }
  });
  return scoped;
}

function visitProgram(program: QueryProgram, visit: (node: QueryProgram) => void): void {
  visit(program);
  if (program.kind === "sequence") {
    for (const step of program.steps) visitProgram(step, visit);
  } else if (program.kind === "alternative") {
    for (const option of program.options) visitProgram(option, visit);
  } else if (program.kind === "repeat" || program.kind === "closure") {
    visitProgram(program.body, visit);
  } else if (program.kind === "hyperedge") {
    for (const premise of program.premises) visitProgram(premise, visit);
  }
}

function edge(
  from: string,
  to: string,
  relationKind: string,
  strength: number,
  applicable: boolean
): Transition {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    from: productKey(from),
    to: productKey(to),
    relation_kind: relationKind,
    strength_milligrades: strength,
    validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
    applicable
  };
}
