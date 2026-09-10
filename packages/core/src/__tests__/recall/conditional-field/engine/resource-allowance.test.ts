import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type QueryInterpretation
} from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import {
  createConditionalField,
  proposeFieldWork
} from "../../../../recall/conditional-field/engine/field-engine.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import {
  INTERPRETATION_CLOCK,
  QUERY_ID,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView,
  deploymentProgram,
  deploymentSeeds,
  deploymentTransitions,
  productKey
} from "../reference/deployment.fixture.js";

describe("request resource allowance", () => {
  it("reserves hydration, identity admission, and solver work before reading a seed page", () => {
    let pinReads = 0;
    let sourceReads = 0;
    const readers = {
      snapshotPin: () => { pinReads += 1; return { source_revision: "fixed" }; },
      lexical: () => ({ ids: ["memory-1"], nativeVisits: 1, nativeBytes: 1, rowsRead: 1, bytesRead: 1, truncated: true }),
      source: () => {
        sourceReads += 1;
        return { row: { object_id: "memory-1", sourceRevision: "source-1", content: "needle" },
          rowsRead: 3, bytesRead: 32, unavailable: false };
      }
    };
    const query = compileQuery("needle");
    const tiny = observeField(query, { workspace_id: "workspace-1", query_text: "needle", as_of: INTERPRETATION_CLOCK,
      budget: defaultBudget({ work_units: 2, finalization_reserve: 0, min_envelope: 0 }), readers });
    expect(pinReads).toBe(0);
    expect(tiny.remaining_exploration).toBe(2);
    expect(tiny.last_observer_status).toBe("interrupted");
    const completedAction = observeField(query, { workspace_id: "workspace-1", query_text: "needle", as_of: INTERPRETATION_CLOCK,
      budget: defaultBudget({ work_units: 13, finalization_reserve: 0, min_envelope: 0 }), readers });
    expect(pinReads).toBe(2);
    expect(sourceReads).toBe(1);
    expect(completedAction.remaining_exploration).toBe(0);
    expect(completedAction.retention_rejected).toBeUndefined();
    expect(completedAction.seeds).toHaveLength(1);
    expect(completedAction.closure.observation).not.toBe("exhausted");
  });

  it("does not retain a 12KB identity set when memory_bytes is 1", () => {
    let reads = 0;
    const query = compileQuery("needle");
    const state = observeField(query, {
      workspace_id: "workspace-1",
      query_text: "needle",
      budget: defaultBudget({ memory_bytes: 1, min_envelope: 1, work_units: 100, finalization_reserve: 8 }),
      as_of: INTERPRETATION_CLOCK,
      readers: {
        lexical: (input) => {
          reads += 1;
          const next = Number(input.afterObjectId ?? -1) + 1;
          return {
            ids: next < 10 ? [String(next)] : [],
            nativeVisits: 1,
            nativeBytes: 1,
            rowsRead: 1,
            bytesRead: 1,
            truncated: next < 9
          };
        },
        relation: () => ({
          observations: [],
          nativeVisits: 0,
          nativeBytes: 0,
          rowsRead: 0,
          bytesRead: 0,
          truncated: false
        })
      }
    });
    const retained = Buffer.byteLength(JSON.stringify({
      observations: state.observations,
      seeds: state.seeds,
      transitions: state.transitions,
      seen_identities: state.seen_identities,
      identity_spool: state.identity_spool
    }), "utf8");
    expect(reads).toBeLessThan(10);
    expect(state.seen_identities).toHaveLength(0);
    expect(state.identity_spool).toHaveLength(0);
    expect(state.observations).toHaveLength(0);
    expect(state.seeds).toHaveLength(0);
    expect(retained).toBeLessThan(12_000);
    expect(state.memory_exhausted).toBe(true);
    expect(state.closure.observation).not.toBe("exhausted");
    expect(state.closure.requested_index).not.toBe("complete");
    expect(proposeFieldWork(state).actions).toHaveLength(0);
  });

  it("spends remaining_reserve on the solver when exploration is gone", () => {
    const budget = defaultBudget({
      work_units: 5,
      finalization_reserve: 5,
      min_envelope: 0,
      memory_bytes: 1_000_000
    });
    const state = createConditionalField({
      interpretation: resolvedInterpretation(),
      budget,
      seeds: deploymentSeeds(),
      transitions: deploymentTransitions()
    });
    expect(state.remaining_reserve).toBeLessThan(budget.finalization_reserve);
    expect(state.binding.kind).toBe("bound");
    expect(state.remaining_reserve).toBeGreaterThanOrEqual(0);
  });

  it("does not keep nine chain identities in RAM when memory_bytes is 300", () => {
    const hops = Array.from({ length: 8 }, (_, index) => ({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      from: productKey(`n${index}`),
      to: productKey(`n${index + 1}`),
      relation_kind: "chain",
      strength_milligrades: 900,
      validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" },
      applicable: true
    }));
    const state = createConditionalField({
      interpretation: resolvedInterpretation(),
      budget: defaultBudget({ memory_bytes: 300, work_units: 50, finalization_reserve: 5, min_envelope: 1 }),
      seeds: [{
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        state: productKey("n0"),
        milligrades: 900
      }],
      transitions: hops
    });
    expect(state.memory_exhausted).toBe(true);
    expect(state.identity_spool).toHaveLength(0);
    expect(state.seen_identities.length).toBeLessThan(9);
    expect(state.remaining_memory_bytes).toBeLessThanOrEqual(300);
    expect(state.closure.requested_index).not.toBe("complete");
    expect(proposeFieldWork(state).actions).toHaveLength(0);
  });

  it("does not mark a projection complete when remaining_reserve cannot finish the walk", () => {
    const bound = createConditionalField({
      interpretation: resolvedInterpretation(),
      budget: defaultBudget(),
      seeds: deploymentSeeds(),
      transitions: deploymentTransitions()
    });
    if (bound.binding.kind !== "bound") throw new Error("expected bound field");
    const index = projectAcceptingIndex({
      snapshot: bound.binding.snapshot,
      view: defaultView(),
      query_id: bound.query_id,
      snapshot_id: bound.snapshot_id,
      result_version: "v1",
      budget: defaultBudget({ page_budget: 800 }),
      remaining_reserve: 0
    });
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(index.completeness.representation).not.toBe("complete");
    expect(index.entries).toEqual([]);
  });
});

function compileQuery(text: string): QueryInterpretation {
  return compileConditionalFieldQuery({
    source: "ordinary",
    text,
    snapshot_id: SNAPSHOT_ID,
    budget: defaultBudget({ memory_bytes: 1, min_envelope: 1 }),
    interpretation_clock: INTERPRETATION_CLOCK
  });
}

function resolvedInterpretation(): QueryInterpretation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: QUERY_ID,
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program: deploymentProgram(),
    view: defaultView(),
    holes: [],
    hypotheses: []
  };
}
