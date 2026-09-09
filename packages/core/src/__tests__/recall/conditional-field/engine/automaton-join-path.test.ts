import { describe, expect, it } from "vitest";
import { solveMaxMinField } from "@do-soul/alaya-graph-algorithms";
import {
  productSubjectId,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type QueryInterpretation,
  type QueryProgram,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { type ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { SNAPSHOT_ID, defaultBudget, defaultView } from "../reference/deployment.fixture.js";
import { composedFacetPathId } from "../../../../recall/conditional-field/engine/path-composition.js";

const VALIDITY: RelationValidity = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const AS_OF = "2026-09-07T00:00:00.000Z";

describe("automaton, compatible join, and composed path identity", () => {
  it("rejects a reused persistent source variable while preserving an explicit chain", () => {
    const rows = [edge("seed", "middle", "observed_log"), edge("middle", "end", "config_direct")];
    expect(acceptedIds(observeProgram(seq(rel("observed_log", "service", "provider"), rel("config_direct", "service", "history")), rows))).not.toContain("end");
    expect(acceptedIds(observeProgram(seq(rel("observed_log", "service", "provider"), rel("config_direct", "provider", "history")), rows))).toContain("end");
  });

  it("incoming reciprocal edges preserve every independently admitted anchor", () => {
    const program: QueryProgram = { schema_version: 1, kind: "closure", product_state_sufficient: true,
      local_variables: ["s", "t"], body: rel("observed_log") };
    const request = input([edge("seed", "middle", "observed_log", "out"), edge("middle", "seed", "observed_log", "back")]);
    const state = observeField(interpretation(program), { ...request, readers: { ...request.readers,
      lexical: ({ afterObjectId, limit, nativeLimit }) => {
        const candidates = ["seed", "middle"];
        const remaining = candidates.slice(afterObjectId === null ? 0 : candidates.indexOf(afterObjectId) + 1);
        const ids = remaining.slice(0, Math.min(limit, nativeLimit));
        return { ids, nativeVisits: ids.length, nativeBytes: 1, rowsRead: ids.length, bytesRead: 1,
          truncated: remaining.length > ids.length, committedThrough: ids.at(-1) ?? afterObjectId };
      } } });
    expect(state.closure.observation).toBe("exhausted");
    expect(new Set(state.seeds.map((seed) => productSubjectId(seed.state)))).toEqual(new Set(["seed", "middle"]));
    expect(acceptedIds(state)).toEqual(expect.arrayContaining(["seed", "middle"]));
  });
  it("keeps a flat sequence control that reaches end", () => {
    expect(acceptedIds(observeProgram(
      seq(rel("observed_log", "x", "y"), rel("config_direct", "y", "z")),
      [edge("seed", "middle", "observed_log"), edge("middle", "end", "config_direct")]
    ))).toContain("end");
  });

  it("nested sequence reaches the outer endpoint", () => {
    expect(acceptedIds(observeProgram(
      seq(
        seq(rel("observed_log", "x", "y"), rel("config_via_log", "y", "z")),
        rel("config_direct", "z", "out")
      ),
      [
        edge("seed", "m1", "observed_log"),
        edge("m1", "m2", "config_via_log"),
        edge("m2", "end", "config_direct")
      ]
    ))).toContain("end");
  });

  it("alternative of a sequence reaches the inner endpoint", () => {
    expect(acceptedIds(observeProgram(
      alt(
        seq(rel("observed_log", "x", "y"), rel("config_direct", "y", "z")),
        rel("uses_service", "x", "w")
      ),
      [edge("seed", "middle", "observed_log"), edge("middle", "end", "config_direct")]
    ))).toContain("end");
  });

  it("closure re-enters and accepts seed, middle, and end of a two-edge chain", () => {
    const ids = acceptedIds(observeProgram(
      {
        schema_version: 1,
        kind: "closure",
        product_state_sufficient: true,
        local_variables: ["s", "t"],
        body: rel("observed_log")
      },
      [
        edge("seed", "middle", "observed_log", "a1"),
        edge("middle", "end", "observed_log", "a2")
      ]
    ));
    expect(ids).toEqual(expect.arrayContaining(["seed", "middle", "end"]));
  });

  it("bounded repeat keeps distinct control states and reaches the second edge", () => {
    expect(acceptedIds(observeProgram(
      { schema_version: 1, kind: "repeat", count: 2, local_variables: ["s", "t"], body: rel("observed_log") },
      [
        edge("seed", "middle", "observed_log", "a1"),
        edge("middle", "end", "observed_log", "a2")
      ]
    ))).toContain("end");
  });

  it("AND with the same target variable and incompatible targets rejects", () => {
    expect(acceptedIds(observeProgram(
      {
        schema_version: 1,
        kind: "hyperedge",
        join: "and",
        premises: [rel("observed_log", "x", "y"), rel("service_history", "x", "y")]
      },
      [edge("seed", "left", "observed_log"), edge("seed", "right", "service_history")]
    ))).toEqual([]);
  });

  it("OR preserves a complete one-branch witness", () => {
    expect(acceptedIds(observeProgram(
      {
        schema_version: 1,
        kind: "hyperedge",
        join: "or",
        premises: [rel("observed_log", "x", "y"), rel("service_history", "x", "y")]
      },
      [edge("seed", "left", "observed_log")]
    ))).toContain("left");
  });

  it("AND of a nested sequence and a compatible relation accepts the shared endpoint", () => {
    expect(acceptedIds(observeProgram(
      {
        schema_version: 1,
        kind: "hyperedge",
        join: "and",
        premises: [
          seq(rel("observed_log", "x", "y"), rel("config_direct", "y", "z")),
          rel("uses_service", "x", "z")
        ]
      },
      [
        edge("seed", "mid", "observed_log"),
        edge("mid", "end", "config_direct"),
        edge("seed", "end", "uses_service")
      ]
    ))).toContain("end");
  });

  it("AND of a nested sequence and an incompatible target rejects", () => {
    expect(acceptedIds(observeProgram(
      {
        schema_version: 1,
        kind: "hyperedge",
        join: "and",
        premises: [
          seq(rel("observed_log", "x", "y"), rel("config_direct", "y", "z")),
          rel("uses_service", "x", "z")
        ]
      },
      [
        edge("seed", "mid", "observed_log"),
        edge("mid", "end", "config_direct"),
        edge("seed", "other", "uses_service")
      ]
    ))).toEqual([]);
  });

  it("OR preserves a complete nested sequence branch", () => {
    expect(acceptedIds(observeProgram(
      {
        schema_version: 1,
        kind: "hyperedge",
        join: "or",
        premises: [
          seq(rel("observed_log", "x", "y"), rel("config_direct", "y", "z")),
          rel("uses_service", "x", "w")
        ]
      },
      [edge("seed", "mid", "observed_log"), edge("mid", "end", "config_direct")]
    ))).toContain("end");
  });

  it("nested hyperedge inside a sequence reaches the outer endpoint", () => {
    expect(acceptedIds(observeProgram(
      seq(
        {
          schema_version: 1,
          kind: "hyperedge",
          join: "and",
          premises: [rel("observed_log", "x", "y"), rel("uses_service", "x", "y")]
        },
        rel("config_direct", "y", "z")
      ),
      [
        edge("seed", "mid", "observed_log"),
        edge("seed", "mid", "uses_service"),
        edge("mid", "end", "config_direct")
      ]
    ))).toContain("end");
  });

  it("ordinary retained transitions emit distinct same_path facets", () => {
    const state = observeProgram(
      alt(rel("config_direct", "x", "y"), rel("config_via_log", "x", "y")),
      [edge("seed", "config", "config_direct"), edge("seed", "config", "config_via_log")]
    );
    if (state.binding.kind !== "bound") throw new Error("expected bound field");
    const pathIds = state.facets.map((vector) => vector.path_id);
    expect(new Set(pathIds).size).toBeGreaterThan(1);
    expect(state.facets.some((vector) => vector.coordinates.includes(800))).toBe(true);
    expect(state.facets.some((vector) => vector.coordinates.includes(850))).toBe(true);
    expect(state.facets.some((vector) => vector.coordinates[0] === 850 && vector.coordinates[1] === 800)).toBe(false);
  });

  it.each(["config", "x".repeat(180)])("alternative discovery order preserves same_path membership at 825 for %s", (objectId) => {
    const orders = [
      ["config_direct", "config_via_log"],
      ["config_via_log", "config_direct"]
    ] as const;
    const outputs = orders.map((order) => {
      const state = observeProgram(
        alt(...order.map((kind) => rel(kind, "x", "y"))),
        order.map((kind) => edge("seed", objectId, kind))
      );
      if (state.binding.kind !== "bound") return [];
      const index = projectAcceptingIndex({
        snapshot: state.binding.snapshot,
        view: { ...state.interpretation.view, threshold_milligrades: 825 },
        query_id: "probe",
        snapshot_id: state.snapshot_id,
        result_version: "v1",
        budget: defaultBudget()
      });
      return index.entries.map((entry) => entry.object_id);
    });
    expect(outputs[0]).toEqual(outputs[1]);
    expect(outputs[0]).toContain(objectId);
  });

  it("does not mint a joint same_path witness from incompatible coordinates", () => {
    const state = observeProgram(
      alt(rel("config_direct", "x", "y"), rel("config_via_log", "x", "y")),
      [edge("seed", "config", "config_direct"), edge("seed", "config", "config_via_log")]
    );
    if (state.binding.kind !== "bound") throw new Error("expected bound field");
    const config = state.binding.snapshot.values.find((value) =>
      productSubjectId(value.state) === "config" && value.accepting
    );
    if (config === undefined) throw new Error("expected accepting config");
    const index = projectAcceptingIndex({
      snapshot: {
        ...state.binding.snapshot,
        facets: [
          { schema_version: 1, path_id: composedFacetPathId(config.state, "weak"), coordinates: [900, 200] },
          { schema_version: 1, path_id: composedFacetPathId(config.state, "strong"), coordinates: [200, 900] }
        ]
      },
      view: { ...state.interpretation.view, threshold_milligrades: 800 },
      query_id: "probe",
      snapshot_id: state.snapshot_id,
      result_version: "v1",
      budget: defaultBudget()
    });
    expect(index.entries.map((entry) => entry.object_id)).not.toContain("config");
  });

  it("does not copy program state for unmatched routing_only overlay", () => {
    const base = [
      edge("seed", "middle", "observed_log"),
      edge("middle", "end", "config_direct")
    ];
    const extras = [
      edge("end", "routed", "uses_service"),
      edge("end", "routed", "uses_service", "dup-uses"),
      edge("routed", "end", "uses_service", "rev-uses")
    ];
    const program = alt(
      seq(rel("observed_log", "x", "y"), rel("config_direct", "y", "z")),
      seq(rel("uses_service", "x", "s"), rel("associated_history", "s", "h"))
    );
    const members = (edges: readonly ReturnType<typeof edge>[]) => {
      const state = observeProgram(program, edges);
      return {
        accepted: [...acceptedIds(state)].sort(),
        claims: state.binding.kind === "bound"
          ? state.binding.snapshot.values.filter((value) => value.accepting).map((value) =>
            `${productSubjectId(value.state)}:${value.milligrades ?? 0}`).sort()
          : [],
        identities: state.seen_identities.map((identity) =>
          `${productSubjectId(identity)}:${identity.program_state}`).sort()
      };
    };
    expect(members([...base, ...extras])).toEqual(members(base));
    expect(members([...base, ...extras]).accepted).toContain("end");
    expect(members([...base, ...extras]).accepted).not.toContain("routed");
    const solver = solveMaxMinField({
      nodeIds: ["seed", "middle", "end", "routed"],
      seeds: new Map([["seed", 1000]]),
      transitions: [
        { from: "seed", to: "middle", strength: 950 },
        { from: "middle", to: "end", strength: 800 }
      ],
      bottom: 0,
      top: 1000
    });
    expect(solver.values.get("end")).toBe(800);
    expect(solver.values.get("routed")).toBe(0);
  });

  it("admitted uses_service still binds same-service history", () => {
    const state = observeProgram(
      seq(rel("uses_service", "x", "s"), rel("associated_history", "s", "h")),
      [edge("seed", "svc", "uses_service"), edge("svc", "hist", "service_history")]
    );
    expect(acceptedIds(state)).toContain("hist");
    expect(acceptedIds(state)).not.toContain("svc");
    expect(state.transitions.some((row) => row.relation_kind === "uses_service"
      && productSubjectId(row.to) === "svc")).toBe(true);
  });

  it("tiny budget leaves routing discovery residual unknown", () => {
    const state = observeField(
      interpretation(alt(
        seq(rel("observed_log", "x", "y"), rel("config_direct", "y", "z")),
        seq(rel("uses_service", "x", "s"), rel("associated_history", "s", "h"))
      )),
      {
        ...input([
          edge("seed", "middle", "observed_log"),
          edge("middle", "end", "config_direct"),
          edge("end", "routed", "uses_service")
        ]),
        budget: defaultBudget({ work_units: 16, finalization_reserve: 6, min_envelope: 2 })
      }
    );
    expect(["interrupted", "open", "unknown"]).toContain(state.closure.observation);
    expect(state.residuals.some((region) => region.status !== "exhausted")).toBe(true);
  });
});

function observeProgram(
  program: QueryProgram,
  edges: readonly ReturnType<typeof edge>[]
) {
  return observeField(interpretation(program), input(edges));
}

function interpretation(program: QueryProgram): QueryInterpretation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "join-path-probe",
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program,
    view: defaultView(),
    holes: [],
    hypotheses: []
  };
}

function rel(
  relationKind: string,
  source = "s",
  target = "t"
): QueryProgram {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "relation",
    relation_kind: relationKind,
    source_variable: source,
    target_variable: target,
    guard: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "query_predicate",
      verdict: "unresolved",
      time_scope: "none"
    },
    facet_mode: "same_path",
    threshold_milligrades: 0
  };
}

function seq(...steps: QueryProgram[]): QueryProgram {
  return { schema_version: 1, kind: "sequence", steps };
}

function alt(...options: QueryProgram[]): QueryProgram {
  return { schema_version: 1, kind: "alternative", options };
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
    evidenceRefs: [`evidence-${assertionId}`]
  };
}

function input(edges: readonly ReturnType<typeof edge>[]) {
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
        observed_at: "2026-09-06T12:00:00.000Z"
      },
      rowsRead: 1,
      bytesRead: 1,
      unavailable: false
    }),
    relation: ({ subject, predicate, afterAssertionId, limit, nativeLimit }) => {
      const remaining = edges.filter((item) =>
        item.sourceObjectId === subject && item.predicate === predicate && item.assertionId > (afterAssertionId ?? "")
      ).sort((left, right) => left.assertionId.localeCompare(right.assertionId));
      const observations = remaining.slice(0, Math.min(limit, nativeLimit));
      return {
        observations,
        nativeVisits: observations.length,
        nativeBytes: 1,
        rowsRead: observations.length,
        bytesRead: 1,
        truncated: remaining.length > observations.length,
        committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId
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
