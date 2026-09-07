import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  QueryInterpretationSchema,
  type Guard,
  type QueryHypothesis,
  type QueryProgram,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import {
  collectRelations,
  compileConditionalFieldQuery,
  interpretationIdentity,
  SUPPORTED_FAILED_DEPLOYMENT_QUERY_ID,
  type QueryMemoryPort
} from "../../../../recall/conditional-field/query/compile-query.js";
import {
  completenessForInterpretationStatus,
  guardAppliesToVariable,
  interpretationCoverageFor,
  interpretationMayEmitCompleteEmpty
} from "../../../../recall/conditional-field/reference/interpret-query.js";
import {
  INTERPRETATION_CLOCK,
  LAST_WEEK_INSTANT,
  SNAPSHOT_ID,
  YESTERDAY_END,
  YESTERDAY_INSTANT,
  YESTERDAY_START,
  defaultBudget,
  defaultView,
  deploymentProgram,
  yesterdayAnchorGuard
} from "../reference/deployment.fixture.js";

const SUPPORTED_PARAPHRASES = [
  "yesterday's failed deployment",
  "failed deployment yesterday",
  "yesterday failed deploy",
  "complete information index of yesterday's failed deployment",
  "yesterday's unsuccessful deployment",
  "yesterday failed deployment of checkout",
  "yesterday's failed deployment and last week's configuration",
  "prior same-service failure around yesterday's failed deployment"
] as const;

describe("conditional-field query compiler", () => {
  it("preserves unhandled service and exclusion meaning as distinct open interpretations", () => {
    const interpretations = ["of checkout", "of payments", "with shared-provider history", "but exclude previous failures"]
      .map((tail) => compileOrdinary(`yesterday failed deployment ${tail}`));
    expect(new Set(interpretations.map((item) => item.query_id)).size).toBe(4);
    for (const interpretation of interpretations) {
      expect(interpretation.status).toBe("partial");
      expect(interpretation.holes.some((hole) => hole.status === "unresolved")).toBe(true);
    }
  });

  it("admits an ordinary open relation proposal without a relation-name catalog", () => {
    const interpretation = compileOrdinary("find depends_on_build_agent from deployment to build");
    expect(interpretation.status).toBe("resolved");
    expect(collectRelations(interpretation.program).map((relation) => relation.relation_kind)).toEqual(["depends_on_build_agent"]);
    expect(collectRelations(interpretation.program)[0]?.source_variable).toBe("deployment");
  });
  it("A01 keeps yesterday on the anchor and admits last-week associated config", () => {
    const interpretation = compileOrdinary("yesterday's failed deployment");
    expect(interpretation.status).toBe("resolved");
    expect(interpretation.query_id).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(interpretation.query_id).not.toBe(SUPPORTED_FAILED_DEPLOYMENT_QUERY_ID);
    expect(interpretation.time_window).toEqual({ start: YESTERDAY_START, end: YESTERDAY_END });
    const relations = collectRelations(interpretation.program);
    const anchor = relations.find((relation) => relation.relation_kind === "observed_log");
    const config = relations.find((relation) => relation.relation_kind === "config_via_log");
    const history = relations.find((relation) => relation.relation_kind === "associated_history");
    expect(anchor).toBeDefined();
    expect(config).toBeDefined();
    expect(history).toBeDefined();
    if (anchor === undefined || config === undefined || history === undefined) return;
    expect(anchor.guard.kind).toBe("interval_relation");
    expect(anchor.guard.time_scope).toBe("anchor");
    expect(anchor.guard.variable).toBe("r");
    expect(anchor.guard.interval).toEqual({
      start: YESTERDAY_START,
      end: YESTERDAY_END,
      time_domain: "calendar_day"
    });
    expect(config.guard.time_scope).toBe("none");
    expect(config.guard.interval).toBeUndefined();
    expect(history.guard.time_scope).toBe("none");
    expect(guardAppliesToVariable(anchor.guard, "r")).toBe(true);
    expect(guardAppliesToVariable(anchor.guard, "c")).toBe(false);
    expect(inGuardInterval(YESTERDAY_INSTANT, anchor.guard.interval)).toBe(true);
    expect(inGuardInterval(LAST_WEEK_INSTANT, anchor.guard.interval)).toBe(false);
    const moved = compileConditionalFieldQuery({
      source: "typed",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      program: moveAnchorGuardToAssociated(interpretation.program),
      interpretation_clock: INTERPRETATION_CLOCK
    });
    const movedConfig = collectRelations(moved.program)
      .find((relation) => relation.relation_kind === "config_via_log");
    expect(movedConfig?.guard.variable).toBe("c");
    expect(movedConfig?.guard.time_scope).toBe("anchor");
    expect(inGuardInterval(LAST_WEEK_INSTANT, movedConfig?.guard.interval)).toBe(false);
    expect(moved.program).not.toEqual(interpretation.program);
  });

  it.each(SUPPORTED_PARAPHRASES)("A01 close paraphrase compiles the supported program: %s", (text) => {
    const interpretation = compileOrdinary(text);
    expect(interpretation.status).toBe(/complete information|of checkout|last week|prior same/u.test(text) ? "partial" : "resolved");
    const relations = collectRelations(interpretation.program);
    expect(relations.find((relation) => relation.guard.time_scope === "anchor")?.guard.variable)
      .toBe("r");
    expect(relations.find((relation) => relation.relation_kind === "config_via_log")?.guard.time_scope)
      .toBe("none");
  });

  it("does not compile owner or channel phrasing as a relation catalog", () => {
    const owns = compileOrdinary("who owns this channel");
    expect(owns.status).toBe("partial");
    expect(owns.program.kind).not.toBe("epsilon");
    expect(collectRelations(owns.program).every((relation) => relation.relation_kind === "lexical_observation"))
      .toBe(true);
    const wrapped = compileOrdinary("who owns yesterday's failed deployment");
    expect(wrapped.status).toBe("partial");
    expect(collectRelations(wrapped.program).map((relation) => relation.relation_kind).sort())
      .toEqual(["associated_history", "config_direct", "config_via_log", "observed_log", "uses_service"]);
  });

  it("keeps unseen ordinary language partial instead of false-resolved epsilon", () => {
    for (const text of ["deployment rules", "pnpm workspace commands", "xyzzy unrelated request"]) {
      const interpretation = compileOrdinary(text);
      expect(interpretation.status).toBe("partial");
      expect(interpretation.program.kind).not.toBe("epsilon");
      expect(interpretation.holes.some((hole) => hole.status !== "bound")).toBe(true);
      expect(interpretation.query_id).not.toBe("unsupported");
    }
    expect(compileOrdinary("deployment rules").query_id)
      .not.toBe(compileOrdinary("pnpm workspace commands").query_id);
  });

  it("binds query_id to interpretation clock so midnight cannot reuse an identity", () => {
    const evening = compileConditionalFieldQuery({
      source: "ordinary",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      text: "yesterday failed deployment",
      interpretation_clock: "2026-09-06T23:59:59.000Z"
    });
    const morning = compileConditionalFieldQuery({
      source: "ordinary",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      text: "yesterday failed deployment",
      interpretation_clock: "2026-09-07T00:00:01.000Z"
    });
    expect(evening.query_id).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(morning.query_id).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(evening.query_id).not.toBe(morning.query_id);
    expect(evening.time_window).not.toEqual(morning.time_window);
    const explicit = compileConditionalFieldQuery({
      source: "ordinary",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      text: "yesterday failed deployment",
      interpretation_clock: "2026-09-07T00:00:01.000Z",
      query_id: "caller-query"
    });
    expect(explicit.query_id).toBe("caller-query");
    const noon = compileConditionalFieldQuery({
      source: "ordinary",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      text: "yesterday failed deployment",
      interpretation_clock: "2026-09-06T12:00:00.000Z"
    });
    const dusk = compileConditionalFieldQuery({
      source: "ordinary",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      text: "yesterday failed deployment",
      interpretation_clock: "2026-09-06T18:00:00.000Z"
    });
    expect(noon.time_window).toEqual(dusk.time_window);
    expect(noon.query_id).not.toBe(dusk.query_id);
    expect(interpretationIdentity({ interpretation_clock: noon.interpretation_clock }))
      .not.toBe(interpretationIdentity({ interpretation_clock: dusk.interpretation_clock }));
    expect(interpretationIdentity({
      interpretation_clock: noon.interpretation_clock,
      model_id: "model-a"
    })).not.toBe(interpretationIdentity({
      interpretation_clock: noon.interpretation_clock,
      model_id: "model-b"
    }));
  });

  it("A03 keeps epsilon distinct from empty and does not rewrite grammar", () => {
    const epsilon = compileTyped({ schema_version: 1, kind: "epsilon" });
    const empty = compileTyped({ schema_version: 1, kind: "empty" });
    expect(epsilon.program.kind).toBe("epsilon");
    expect(empty.program.kind).toBe("empty");
    expect(epsilon.program.kind).not.toBe(empty.program.kind);
    const sequence = compileTyped({
      schema_version: 1,
      kind: "sequence",
      steps: [{ schema_version: 1, kind: "epsilon" }, relation("keep", "a", "b")]
    });
    expect(sequence.program).toEqual({
      schema_version: 1,
      kind: "sequence",
      steps: [{ schema_version: 1, kind: "epsilon" }, relation("keep", "a", "b")]
    });
    const hyperedge = compileTyped({
      schema_version: 1,
      kind: "hyperedge",
      join: "and",
      premises: [relation("p1", "a", "b"), relation("p2", "b", "c")]
    });
    expect(hyperedge.program).toMatchObject({ kind: "hyperedge", join: "and" });
    expect(hyperedge.program.kind === "hyperedge" ? hyperedge.program.join : undefined)
      .not.toBe("or");
  });

  it("A03 keeps holes and hypotheses as separate identities", () => {
    const first = hypothesis("h1", "event", "failed_deployment");
    const second = hypothesis("h2", "event", "outage");
    const interpretation = compileConditionalFieldQuery({
      source: "typed",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      program: deploymentProgram(),
      holes: [
        { schema_version: 1, hole_id: "hole.r", variable: "r", status: "open" },
        { schema_version: 1, hole_id: "hole.c", variable: "c", status: "unresolved" }
      ],
      hypotheses: [first, second]
    });
    expect(interpretation.status).toBe("hypotheses");
    expect(interpretation.holes.map((hole) => hole.hole_id)).toEqual(["hole.r", "hole.c"]);
    expect(interpretation.hypotheses.map((row) => row.hypothesis_id)).toEqual(["h1", "h2"]);
    expect(interpretation.hypotheses[0]?.bindings).toEqual(first.bindings);
    expect(interpretation.hypotheses[1]?.bindings).toEqual(second.bindings);
    expect(interpretation.hypotheses).toHaveLength(2);
    const ambiguous = compileOrdinary("yesterday's failure");
    expect(ambiguous.status).toBe("hypotheses");
    expect(ambiguous.hypotheses.map((row) => row.hypothesis_id).sort())
      .toEqual(["h-failed-deployment", "h-unresolved-event"]);
    expect(new Set(ambiguous.hypotheses.flatMap((row) => row.bindings.map((binding) => binding.value))).size)
      .toBeGreaterThan(1);
  });

  it("A06 defaults same_path and does not rewrite it to independent", () => {
    const ordinary = compileOrdinary("yesterday's failed deployment");
    expect(ordinary.view.facet_mode).toBe("same_path");
    expect(collectRelations(ordinary.program).every((relation) => relation.facet_mode === "same_path"))
      .toBe(true);
    const independent = compileTyped(relation("custom.unseen.v1", "r", "c", {
      schema_version: 1,
      kind: "query_predicate",
      verdict: "unresolved",
      variable: "c",
      time_scope: "none"
    }, "independent"), {
      view: {
        schema_version: 1,
        requested_roles: ["requested", "associated"],
        include_routing_only: false,
        facet_mode: "independent",
        threshold_milligrades: 800
      }
    });
    expect(independent.view.facet_mode).toBe("independent");
    expect(collectRelations(independent.program)[0]?.facet_mode).toBe("independent");
    expect(ordinary.view.facet_mode).not.toBe("independent");
  });

  it("admits RequestBudget before memory-dependent reads", () => {
    const reads: string[] = [];
    const memory = recordingMemory(reads);
    const rejected = compileConditionalFieldQuery({
      source: "typed",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget({ work_units: 100, finalization_reserve: 20, min_envelope: 90 }),
      program: sourceBoundProgram(),
      memory
    });
    expect(rejected.status).toBe("resource_rejected");
    expect(reads).toEqual([]);
    expect(interpretationMayEmitCompleteEmpty(rejected.status)).toBe(false);
    expect(completenessForInterpretationStatus(rejected.status)?.logical_index)
      .toBe("resource_rejected");
    expect(completenessForInterpretationStatus(rejected.status)?.logical_index)
      .not.toBe("complete");
    expect(completenessForInterpretationStatus(rejected.status)?.observed_coverage)
      .not.toBe("exhausted_empty");
    const admitted = compileConditionalFieldQuery({
      source: "typed",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget({ page_budget: 2, min_envelope: 10 }),
      program: sourceBoundProgram(),
      memory
    });
    expect(admitted.status).toBe("resolved");
    expect(reads).toEqual([SNAPSHOT_ID]);
    const ordinary = compileConditionalFieldQuery({
      source: "ordinary",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      text: "yesterday's failed deployment",
      interpretation_clock: INTERPRETATION_CLOCK,
      memory
    });
    expect(ordinary.status).toBe("resolved");
    expect(reads).toEqual([SNAPSHOT_ID]);
  });

  it("keeps unseen relation names as data through the typed grammar", () => {
    const interpretation = compileTyped(relation("custom.unseen.relation.v1", "x", "y"));
    expect(interpretation.status).toBe("resolved");
    expect(collectRelations(interpretation.program)[0]?.relation_kind)
      .toBe("custom.unseen.relation.v1");
    const open = compileConditionalFieldQuery({
      source: "ordinary",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      text: "yesterday's failed deployment",
      interpretation_clock: INTERPRETATION_CLOCK,
      relations: [{
        relation_kind: "custom.unseen.relation.v1",
        source_variable: "anchor",
        target_variable: "r"
      }, {
        relation_kind: "also.unseen.v1",
        source_variable: "r",
        target_variable: "c"
      }]
    });
    expect(open.status).toBe("resolved");
    expect(collectRelations(open.program).map((relation) => relation.relation_kind))
      .toEqual(["custom.unseen.relation.v1", "also.unseen.v1"]);
    expect(collectRelations(open.program)[0]?.guard.time_scope).toBe("anchor");
    expect(collectRelations(open.program)[1]?.guard.time_scope).toBe("none");
  });

  it("distinguishes malformed, unsupported, partial, and resource-rejected from empty", () => {
    expect(compileOrdinary("").status).toBe("malformed");
    expect(compileOrdinary("xyzzy unrelated request").status).toBe("partial");
    const partial = compileOrdinary("failed deployment of checkout");
    expect(partial.status).toBe("partial");
    expect(partial.holes).toContainEqual({
      schema_version: 1,
      hole_id: "hole.anchor.time",
      variable: "r",
      status: "open"
    });
    const hinted = compileConditionalFieldQuery({
      source: "ordinary",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      text: "failed deployment of checkout",
      interpretation_clock: INTERPRETATION_CLOCK,
      since: YESTERDAY_START,
      until: YESTERDAY_END
    });
    expect(hinted.status).toBe("partial");
    expect(collectRelations(hinted.program)[0]?.guard.time_scope).toBe("anchor");
    expect(collectRelations(hinted.program).find((relation) => relation.relation_kind === "config_via_log")
      ?.guard.time_scope).toBe("none");
    for (const status of ["malformed", "unsupported", "partial", "resource_rejected"] as const) {
      expect(interpretationMayEmitCompleteEmpty(status)).toBe(false);
    }
    expect(compileTyped({
      schema_version: 1,
      kind: "sequence",
      steps: []
    }).status).toBe("malformed");
    const typed = compileTyped(deploymentProgram(), {
      time_window: { start: YESTERDAY_START, end: YESTERDAY_END },
      interpretation_clock: INTERPRETATION_CLOCK
    });
    expect(typed.status).toBe("resolved");
    expect(QueryInterpretationSchema.parse(typed).query_id.length).toBeGreaterThan(0);
    expect(typed.view).toEqual(defaultView());
  });

  it("does not treat Chinese ordinary text as malformed via ASCII stripping", () => {
    const interpretation = compileOrdinary("昨天失败的部署相关配置");
    expect(interpretation.status).not.toBe("malformed");
    expect(interpretation.program.kind).not.toBe("empty");
  });

  it("keeps unseen relational language partial rather than resolved epsilon", () => {
    const interpretation = compileOrdinary("Which database migration caused the outage last Tuesday?");
    expect(interpretation.status).toBe("partial");
    expect(interpretation.program.kind).not.toBe("epsilon");
  });

  it("maps one-sided since to partial with an open hole instead of malformed", () => {
    const interpretation = compileConditionalFieldQuery({
      source: "ordinary",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      text: "deployment rules",
      interpretation_clock: INTERPRETATION_CLOCK,
      since: YESTERDAY_START
    });
    expect(interpretation.status).toBe("partial");
    expect(interpretation.status).not.toBe("malformed");
    expect(interpretation.holes.some((hole) => hole.hole_id === "hole.time.until")).toBe(true);
    expect(interpretation.time_window).toBeUndefined();
  });

  it("hashes public dimension, domain_tags, and time_field into query identity", () => {
    const base = compileConditionalFieldQuery({
      source: "ordinary",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      text: "deployment rules",
      interpretation_clock: INTERPRETATION_CLOCK
    });
    const filtered = compileConditionalFieldQuery({
      source: "ordinary",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      text: "deployment rules",
      interpretation_clock: INTERPRETATION_CLOCK,
      dimension_filter: ["episode"],
      domain_tag_filter: ["absent-tag"],
      time_field: "created_at"
    });
    expect(filtered.query_id).not.toBe(base.query_id);
    expect(filtered.status).toBe("partial");
    expect(collectRelations(filtered.program).some((relation) => (
      relation.guard.predicate_name?.includes("dimension=episode") === true
      && relation.guard.predicate_name.includes("tag=absent-tag")
      && relation.guard.predicate_name.includes("time_field=created_at")
    ))).toBe(true);
    expect(interpretationCoverageFor(filtered.status, filtered)).toBe("open");
    expect(interpretationCoverageFor(filtered.status, filtered)).not.toBe("complete");
  });
});

function compileOrdinary(text: string, budget: RequestBudget = defaultBudget()) {
  return compileConditionalFieldQuery({
    source: "ordinary",
    snapshot_id: SNAPSHOT_ID,
    budget,
    text,
    interpretation_clock: INTERPRETATION_CLOCK
  });
}

function compileTyped(
  program: QueryProgram,
  extra: {
    readonly view?: ReturnType<typeof defaultView>;
    readonly time_window?: { readonly start: string; readonly end: string };
    readonly interpretation_clock?: string;
  } = {}
) {
  return compileConditionalFieldQuery({
    source: "typed",
    snapshot_id: SNAPSHOT_ID,
    budget: defaultBudget(),
    program,
    ...extra
  });
}

function relation(
  relationKind: string,
  source: string,
  target: string,
  guard: Guard = {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "query_predicate",
    verdict: "unresolved",
    variable: target,
    time_scope: "none"
  },
  facetMode: "same_path" | "independent" = "same_path"
): QueryProgram {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "relation",
    relation_kind: relationKind,
    source_variable: source,
    target_variable: target,
    guard,
    facet_mode: facetMode,
    threshold_milligrades: 0
  };
}

function sourceBoundProgram(): QueryProgram {
  return relation("bound", "anchor", "r", {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "source_bound_entity",
    verdict: "unresolved",
    variable: "r",
    time_scope: "none",
    entity_id: "svc-checkout"
  });
}

function hypothesis(id: string, variable: string, value: string): QueryHypothesis {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    hypothesis_id: id,
    bindings: [{
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      variable,
      value
    }]
  };
}

function recordingMemory(reads: string[]): QueryMemoryPort {
  return {
    readAuthorizedSnapshot(input) {
      reads.push(input.snapshot_id);
    }
  };
}

function moveAnchorGuardToAssociated(program: QueryProgram): QueryProgram {
  const yesterday = yesterdayAnchorGuard();
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "sequence",
    steps: collectRelations(program).map((item) => (
      item.relation_kind === "config_via_log"
        ? {
            ...item,
            guard: { ...yesterday, variable: "c", time_scope: "anchor" as const }
          }
        : item
    ))
  };
}

function inGuardInterval(
  timestamp: string,
  interval: { readonly start: string; readonly end: string } | undefined
): boolean {
  if (interval === undefined) return false;
  return timestamp >= interval.start && timestamp < interval.end;
}
