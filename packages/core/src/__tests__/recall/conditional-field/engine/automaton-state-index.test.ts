import { describe, expect, it } from "vitest";
import type { QueryInterpretation, QueryProgram } from "@do-soul/alaya-protocol";
import {
  advancesFor, compileProgramAutomaton, programAutomatonCost
} from "../../../../recall/conditional-field/engine/program-automaton.js";
import {
  createAdjacencyEffectCursor, type CompiledAdjacencyEffect
} from "../../../../recall/conditional-field/engine/path-composition-adjacency.js";
import { defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const relation = (relation_kind = "p"): QueryProgram => ({
  schema_version: 1, kind: "relation", relation_kind, source_variable: "x", target_variable: "y",
  facet_mode: "same_path", threshold_milligrades: 0,
  guard: { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" }
});
const sequence: QueryProgram = {
  schema_version: 1, kind: "sequence", steps: [relation(), relation("q")]
};
const programs: ReadonlyArray<readonly [string, QueryProgram]> = [
  ["relation", relation()],
  ["sequence", sequence],
  ["alternative", { schema_version: 1, kind: "alternative", options: [sequence, relation("r")] }],
  ["repeat", { schema_version: 1, kind: "repeat", body: sequence, count: 3, local_variables: ["x", "y"] }],
  ["closure", { schema_version: 1, kind: "closure", body: sequence,
    product_state_sufficient: true, local_variables: ["x", "y"] }],
  ["hyperedge", { schema_version: 1, kind: "hyperedge", join: "and", premises: [sequence, relation("r")] }],
  ["empty", { schema_version: 1, kind: "empty" }],
  ["epsilon", { schema_version: 1, kind: "epsilon" }]
];

describe("ordered automaton state lookup", () => {
  it.each(programs)("matches exhaustive advance lookup for %s", (_name, program) => {
    const automaton = compileProgramAutomaton(program);
    const states = new Set(["missing", ...automaton.start, ...automaton.advances.flatMap((advance) =>
      [advance.from, ...advance.to])]);
    for (const state of states) {
      const reference = automaton.advances.filter((advance) => advance.from === state);
      expect(automaton.advancesByState.get(state) ?? []).toEqual(reference);
      expect(advancesFor(automaton, state, () => true)).toEqual(reference);
      expect(advancesFor(automaton, state, (candidate) => candidate.relation_kind !== "p"))
        .toEqual(reference.filter((advance) => advance.relation.relation_kind !== "p"));
    }
  });

  it("finishes forty independent demands without repeatedly inspecting unrelated control states", () => {
    const program: QueryProgram = { schema_version: 1, kind: "sequence",
      steps: Array.from({ length: 12 }, () => relation()) };
    const automaton = compileProgramAutomaton(program);
    const compilation = programAutomatonCost(program);
    // Twelve two-state relations used 324 work and 8704 bytes before indexing.
    // The bounded pass below includes the new index construction and retention.
    expect(compilation.work_units).toBeGreaterThan(324);
    expect(compilation.retained_bytes).toBeGreaterThan(8704);
    let fromComparisons = 0;
    for (const advance of automaton.advances) {
      const from = advance.from;
      Object.defineProperty(advance, "from", { get: () => { fromComparisons += 1; return from; } });
    }
    const interpretation: QueryInterpretation = {
      schema_version: 1, query_id: "ordered-demands", snapshot_id: SNAPSHOT_ID,
      status: "resolved", holes: [], hypotheses: [], program, view: defaultView()
    };
    const subjects = Array.from({ length: 40 }, (_, index) => `source-${index}`);
    const cursor = createAdjacencyEffectCursor([], {
      interpretation, asOf: "2026-09-07T00:00:00.000Z", overlay: {}, physicalKinds: ["p"],
      compiledAutomaton: automaton,
      liveStates: subjects.map((subject) => productKey(subject, "h0", "unbound", automaton.start[0]!))
    });
    const effects: CompiledAdjacencyEffect[] = [];
    let work = compilation.work_units, offset = 0, complete = false;
    for (let page = 0; page < 4 && work < 800 && !complete; page += 1) {
      const next = cursor.advance(offset, 800 - work, 1_000_000 - compilation.retained_bytes);
      work += next.work;
      offset = next.offset;
      effects.push(...next.effects);
      complete = next.status === "complete";
    }
    expect(complete).toBe(true);
    expect(work).toBeLessThan(800);
    expect(effects.map((effect) => effect.relation_demand))
      .toEqual(subjects.map((subject) => ({ subject, predicate: "p" })));
    expect(fromComparisons).toBe(0);
  });
});
