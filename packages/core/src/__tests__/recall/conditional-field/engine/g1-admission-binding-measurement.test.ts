import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type Guard,
  type QueryInterpretation,
  type QueryProgram,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { assessUnknownCause } from "../../../../recall/runtime/semantic-attribution.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { type ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import {
  encodeBindingContext,
  evaluateGuard,
  parseBindingContext
} from "../../../../recall/conditional-field/engine/binding-environment.js";
import { INTERPRETATION_CLOCK, SNAPSHOT_ID, defaultBudget, defaultView } from "../reference/deployment.fixture.js";

const VALIDITY: RelationValidity = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const AS_OF = "2026-09-07T00:00:00.000Z";

describe("G1 admission, binding, measurement, and evidence identities", () => {
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
    const target = state.seen_identities.find((identity) => identity.object_id === "fact" && identity.program_state === "accepting")!;
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
    query_id: "g1-probe",
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
): QueryProgram {
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
      ...(guard.interval === undefined ? {} : { interval: guard.interval })
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
    .filter((value) => value.accepting && value.milligrades > 0)
    .map((value) => value.state.object_id);
}

function grades(state: ReturnType<typeof observeField>, objectId: string): number {
  if (state.binding.kind !== "bound") return 0;
  return state.binding.snapshot.values.find((value) =>
    value.state.object_id === objectId && value.accepting
  )?.milligrades ?? 0;
}
