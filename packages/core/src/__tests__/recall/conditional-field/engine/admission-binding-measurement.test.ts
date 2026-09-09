import { describe, expect, it } from "vitest";
import {
  fieldActivationOf,
  memoryProductStateKey,
  memoryRecallTarget,
  productSubjectId,
  RawMeasurementSchema,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type Guard,
  type QueryInterpretation,
  type QueryProgram,
  type RelationValidity,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { assessUnknownCause } from "../../../../recall/runtime/semantic-attribution.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { buildTypedObservation } from "../../../../recall/conditional-field/observers/observation-admission.js";
import {
  startObserverCursor,
  type ObserverReaders,
  type SourceRootObserverRow
} from "../../../../recall/conditional-field/observers/observe.js";
import {
  seedActivationsForObservation,
  seedFromObservation
} from "../../../../recall/conditional-field/engine/path-composition.js";
import {
  encodeBindingContext,
  evaluateGuard,
  parseBindingContext
} from "../../../../recall/conditional-field/engine/binding-environment.js";
import { evaluateFrozenSourcePredicate } from "../../../../recall/conditional-field/query/source-predicates.js";
import { INTERPRETATION_CLOCK, SNAPSHOT_ID, defaultBudget, defaultView } from "../reference/deployment.fixture.js";

const VALIDITY: RelationValidity = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const AS_OF = "2026-09-07T00:00:00.000Z";

describe("admission, binding, measurement, and evidence identities", () => {
  it("rejects equality, hypothesis, and associated-time negatives", () => {
    expect(acceptedIds(observeProgram(
      relation("a", "x", "y", {
        kind: "equality",
        variable: "y",
        equals_variable: "x",
        time_scope: "none"
      }),
      [edge("seed", "other", "a")]
    ))).not.toContain("other");

    expect(acceptedIds(observeProgram(
      relation("a", "x", "y"),
      [edge("seed", "other", "a")],
      {
        hypotheses: [{
          schema_version: 1,
          hypothesis_id: "h1",
          bindings: [{ schema_version: 1, variable: "y", value: "wanted" }]
        }]
      }
    ))).not.toContain("other");

    expect(acceptedIds(observeProgram(
      relation("a", "x", "y", {
        kind: "interval_relation",
        variable: "y",
        time_scope: "associated",
        interval: {
          start: "2026-09-06T00:00:00.000Z",
          end: "2026-09-07T00:00:00.000Z",
          time_domain: "calendar_day"
        }
      }),
      [edge("seed", "last-week", "a")],
      { times: { "last-week": "2026-08-31T12:00:00.000Z" } }
    ))).not.toContain("last-week");
  });

  it("changes membership when the same interval moves from anchor to associated", () => {
    const edges = [edge("seed", "last-week", "config_direct")];
    const times = { "last-week": "2026-08-31T12:00:00.000Z", seed: "2026-09-06T12:00:00.000Z" };
    const interval = {
      start: "2026-09-06T00:00:00.000Z",
      end: "2026-09-07T00:00:00.000Z",
      time_domain: "calendar_day"
    };
    const anchor = acceptedIds(observeProgram(
      relation("config_direct", "x", "y", {
        kind: "interval_relation",
        variable: "x",
        time_scope: "anchor",
        interval
      }),
      edges,
      { times }
    ));
    const associated = acceptedIds(observeProgram(
      relation("config_direct", "x", "y", {
        kind: "interval_relation",
        variable: "y",
        time_scope: "associated",
        interval
      }),
      edges,
      { times }
    ));
    expect(anchor).not.toEqual(associated);
    expect(associated).not.toContain("last-week");
  });

  it("does not manufacture association degree from a query threshold", () => {
    const edges = [edge("seed", "fact", "novel_relation")];
    const low = grades(observeProgram(
      { ...relation("novel_relation", "x", "y"), threshold_milligrades: 200 },
      edges
    ), "fact");
    const high = grades(observeProgram(
      { ...relation("novel_relation", "x", "y"), threshold_milligrades: 800 },
      edges
    ), "fact");
    expect(high).toBe(low);
    expect(high).not.toBe(800);
    expect(low).not.toBe(200);
  });

  it("threads distinct evidence identities into a supported claim", () => {
    const request = input([edge("seed", "fact", "observed_log", "assert-supports")], {});
    const state = assessUnknownCause(
      observeField(interpretation(relation("observed_log", "x", "y")), request),
      request
    );
    const target = state.seen_identities.find((identity) => productSubjectId(identity) === "fact" && identity.program_state === "accepting")!;
    const key = productStateNodeId(target);
    const record = state.support.find((row) => row.proposition_id === state.claim_propositions?.get(key)?.proposition_id);
    expect(record?.claim).toBe("supported");
    expect(record?.witnesses.some((witness) => witness.complete && witness.witness_id.includes("evidence-assert-supports"))).toBe(true);
    expect(state.claims.get(key)).toBe("supported");
  });

  it("does not treat unresolved authorization as true", () => {
    const guard = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "authorization" as const,
      verdict: "unresolved" as const,
      authorization_scope: "project",
      variable: "y"
    };
    const env = new Map([["y", "fact"]]);
    expect(evaluateGuard(guard, env, new Map())).toBe("unresolved");
    expect(evaluateGuard(guard, env, new Map([["fact", { object_id: "fact", scope_class: "personal" }]])))
      .toBe("false");
    expect(evaluateGuard(guard, env, new Map([["fact", { object_id: "fact", scope_class: "project" }]])))
      .toBe("true");
  });

  it("recovers a hashed binding context", () => {
    const env = new Map([
      ["alpha", "a".repeat(90)],
      ["beta", "b".repeat(90)],
      ["gamma", "c".repeat(90)]
    ]);
    const encoded = encodeBindingContext(env);
    expect(encoded.startsWith("sha256:")).toBe(true);
    expect(parseBindingContext(encoded).get("alpha")).toBe("a".repeat(90));
    expect(parseBindingContext(encoded).get("gamma")).toBe("c".repeat(90));
  });

  it("compiles yesterday failed deployment as the supported program", () => {
    const compiled = compileConditionalFieldQuery({
      source: "ordinary",
      text: "Tell me about yesterday failed deployment",
      interpretation_clock: INTERPRETATION_CLOCK,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget()
    });
    expect(compiled.status).toBe("resolved");
    expect(compiled.program.kind).toBe("alternative");
  });

  it("keeps missing measurement distinct from reachable zero", () => {
    const missing = observeProgram(relation("novel_relation", "x", "y"), [edge("seed", "fact", "novel_relation")]);
    const fact = missing.binding.kind === "bound"
      ? missing.binding.snapshot.values.find((value) => productSubjectId(value.state) === "fact")
      : undefined;
    expect(fact).toBeUndefined();
    expect(fieldActivationOf({})).toEqual({ kind: "unreachable" });
    expect(fieldActivationOf({ milligrades: 0 })).toEqual({ kind: "reachable", milligrades: 0 });
    expect(RawMeasurementSchema.parse({ status: "missing" }).status).toBe("missing");
    expect(RawMeasurementSchema.parse({
      status: "measured",
      producer_id: "p",
      model_id: "m",
      domain: "d",
      normalization: "n",
      referent: memoryRecallTarget({ workspace_id: "ws", object_id: "fact", source_revision: "rev" }),
      source_revision: "rev",
      query_digest: SNAPSHOT_ID,
      raw: 0
    }).raw).toBe(0);
  });

  it("does not promote unresolved or epsilon discovery seeds onto the guaranteed list", () => {
    const state = memoryProductStateKey({
      workspace_id: "ws",
      object_id: "seed",
      source_revision: "rev",
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "unbound",
      time_state: "as_of"
    });
    const unresolved: TypedObservation = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      observation_id: "seed:seed",
      object_id: "seed",
      source_revision: "rev",
      applicability: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        kind: "query_predicate",
        verdict: "unresolved",
        predicate_name: "source.role.v1"
      },
      association_milligrades: 850
    };
    expect(seedFromObservation(unresolved, state)).toBeUndefined();
    const admittedZero: TypedObservation = {
      ...unresolved,
      applicability: { ...unresolved.applicability, verdict: "true", predicate_name: "source.identity.v1" },
      association_milligrades: 0
    };
    expect(seedFromObservation(admittedZero, state)?.milligrades).toBe(0);
    expect(seedActivationsForObservation(unresolved, interpretation(relation("observed_log", "x", "y")), AS_OF))
      .toEqual([]);
    expect(seedActivationsForObservation(admittedZero, interpretation({ schema_version: 1, kind: "empty" }), AS_OF))
      .toEqual([]);
    const roleQuery = interpretation(relation("observed_log", "x", "y", {
      kind: "query_predicate",
      predicate_name: "source.role.v1",
      variable: "y",
      time_scope: "none"
    }));
    const observed = observeField(roleQuery, input([edge("seed", "fact", "observed_log")], {}));
    expect(observed.guaranteed_seeds).toEqual([]);
  });

  it("does not guaranteed-seed a lexical hit under an unknown query_predicate", () => {
    const observed = observeProgram(
      relation("observed_log", "x", "y", {
        kind: "query_predicate",
        predicate_name: "source.not_a_frozen_predicate.v1",
        variable: "y",
        time_scope: "none"
      }),
      [edge("seed", "fact", "observed_log")]
    );
    expect(observed.guaranteed_seeds).toEqual([]);
    expect(observed.seeds.every((seed) => seed.milligrades !== undefined)).toBe(true);
  });

  it("evaluates frozen source predicates without using created_at or packing filters", () => {
    const interval = {
      start: "2026-09-06T00:00:00.000Z",
      end: "2026-09-07T00:00:00.000Z",
      time_domain: "event_time"
    };
    const guard = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "query_predicate" as const,
      verdict: "unresolved" as const,
      predicate_name: "source.event_time.interval.v1",
      interval
    };
    expect(evaluateFrozenSourcePredicate("source.event_time.interval.v1", guard, {
      created_at: "2026-09-06T12:00:00.000Z",
      last_used_at: "2026-09-06T12:00:00.000Z"
    })).toBe("unresolved");
    expect(evaluateFrozenSourcePredicate("source.event_time.interval.v1", guard, {
      event_time: "2026-09-06T12:00:00.000Z"
    })).toBe("true");
    expect(evaluateFrozenSourcePredicate("source.literal.nfc.v1", {
      ...guard,
      predicate_name: "source.literal.nfc.v1",
      entity_id: "\uFB00"
    }, { content: "\uFB00 ligature" })).toBe("true");
    expect(evaluateFrozenSourcePredicate("source.literal.nfc.v1", {
      ...guard,
      predicate_name: "source.literal.nfc.v1",
      entity_id: "\uFB00"
    }, { content: "ff ligature" })).toBe("false");
    const unknownRole = buildTypedObservation(observeInput(relation("observed_log", "x", "y", {
      kind: "query_predicate",
      predicate_name: "source.role.v1",
      variable: "y"
    })), {
      objectId: "root-1",
      sourceRevision: "rev-1",
      observationKey: "root-1",
      sourceRoot: sourceRoot({ role: undefined }),
      identityKind: "object"
    });
    expect(unknownRole?.applicability.verdict).toBe("unresolved");
    expect(unknownRole?.applicability.verdict).not.toBe("false");
    const linked = buildTypedObservation(observeInput(relation("observed_log", "x", "y", {
      kind: "query_predicate",
      predicate_name: "source.evidence_link.v1",
      variable: "y"
    })), {
      objectId: "root-1",
      sourceRevision: "rev-1",
      observationKey: "root-1",
      sourceRoot: sourceRoot({ evidence_object_id: null }),
      identityKind: "object"
    });
    expect(linked).toBeNull();
    const missingVector = observeField(interpretation(relation("observed_log", "x", "y")), input([], {}));
    expect(missingVector.last_observer_status === undefined
      || missingVector.last_observer_status === "exhausted"
      || missingVector.last_observer_status === "unavailable"
      || missingVector.last_observer_status === "not_applicable"
      || missingVector.last_observer_status === "unknown").toBe(true);
  });
});

function observeProgram(
  program: QueryProgram,
  edges: readonly ReturnType<typeof edge>[],
  options: {
    readonly times?: Readonly<Record<string, string>>;
    readonly hypotheses?: QueryInterpretation["hypotheses"];
  } = {}
) {
  return observeField(interpretation(program, options.hypotheses), input(edges, options.times ?? {}));
}

function interpretation(
  program: QueryProgram,
  hypotheses: QueryInterpretation["hypotheses"] = []
): QueryInterpretation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "admission-probe",
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program,
    view: defaultView(),
    holes: [],
    hypotheses
  };
}

function relation(
  relationKind: string,
  source: string,
  target: string,
  guard: Partial<Guard> = {}
): Extract<QueryProgram, { readonly kind: "relation" }> {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "relation",
    relation_kind: relationKind,
    source_variable: source,
    target_variable: target,
    guard: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: guard.kind ?? "query_predicate",
      verdict: "unresolved",
      variable: guard.variable ?? target,
      time_scope: guard.time_scope ?? "none",
      ...(guard.equals_variable === undefined ? {} : { equals_variable: guard.equals_variable }),
      ...(guard.interval === undefined ? {} : { interval: guard.interval }),
      ...(guard.predicate_name === undefined ? {} : { predicate_name: guard.predicate_name }),
      ...(guard.entity_id === undefined ? {} : { entity_id: guard.entity_id })
    },
    facet_mode: "same_path",
    threshold_milligrades: 0
  };
}

function edge(
  sourceObjectId: string,
  targetObjectId: string,
  predicate: string,
  assertionId = predicate
) {
  return {
    sourceObjectId,
    targetObjectId,
    predicate,
    assertionId,
    resultObjectId: targetObjectId,
    validity: VALIDITY,
    evidenceRefs: [`evidence-${assertionId}`],
    evidenceReceipts: [{ evidenceId: `evidence-${assertionId}`, eventId: `event-${assertionId}`, eventType: "relation.evidence", occurredAt: AS_OF }]
  };
}

function input(
  edges: readonly ReturnType<typeof edge>[],
  times: Readonly<Record<string, string>>
) {
  const readers: ObserverReaders = {
    lexical: () => ({
      ids: ["seed"],
      nativeVisits: 1,
      nativeBytes: 1,
      rowsRead: 1,
      bytesRead: 1,
      truncated: false
    }),
    source: ({ objectId }) => ({
      row: {
        object_id: objectId,
        sourceRevision: "rev",
        lifecycle_state: "active",
        scope_class: "project",
        observed_at: times[objectId] ?? "2026-09-06T12:00:00.000Z"
      },
      rowsRead: 1,
      bytesRead: 1,
      unavailable: false
    }),
    relation: ({ subject, predicate }) => {
      const observations = edges.filter((item) =>
        item.sourceObjectId === subject && item.predicate === predicate
      );
      return {
        observations,
        nativeVisits: observations.length,
        nativeBytes: 1,
        rowsRead: observations.length,
        bytesRead: 1,
        truncated: false
      };
    }
  };
  return {
    workspace_id: "ws",
    query_text: "seed",
    budget: defaultBudget(),
    as_of: AS_OF,
    readers
  };
}

function acceptedIds(state: ReturnType<typeof observeField>): readonly string[] {
  if (state.binding.kind !== "bound") return [];
  return state.binding.snapshot.values
    .filter((value) => value.accepting && (value.milligrades ?? 0) > 0)
    .map((value) => productSubjectId(value.state));
}

function grades(state: ReturnType<typeof observeField>, objectId: string): number {
  if (state.binding.kind !== "bound") return 0;
  return state.binding.snapshot.values.find((value) =>
    productSubjectId(value.state) === objectId && value.accepting
  )?.milligrades ?? 0;
}

function observeInput(program: QueryProgram) {
  return {
    lease: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      lease_id: "lease",
      snapshot_id: SNAPSHOT_ID,
      query_id: "admission-probe",
      status: "active" as const
    },
    action: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      action: "seed" as const,
      region_id: "seed",
      work_limit: 16
    },
    cursor: startObserverCursor({
      cursor_id: "seed",
      snapshot_id: SNAPSHOT_ID,
      query_id: "admission-probe",
      region_id: "seed"
    }),
    query: interpretation(program),
    workspace_id: "ws",
    readers: {},
    seed_query: "needle"
  };
}

function sourceRoot(
  overrides: Partial<SourceRootObserverRow> = {}
): SourceRootObserverRow {
  return {
    kind: "source_record",
    workspace_id: "ws",
    root_id: "root-1",
    revision: "rev-1",
    digest: SNAPSHOT_ID,
    evidence_object_id: "capsule-1",
    ...overrides
  };
}
