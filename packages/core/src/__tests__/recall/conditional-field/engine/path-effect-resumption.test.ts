import { describe, expect, it } from "vitest";
import { productSubjectId, type QueryInterpretation, type QueryProgram } from "@do-soul/alaya-protocol";
import { createAdjacencyEffectCursor, adjacencyEffectsForRows, seedProgramStates, composedFacetPathId, facetBelongsToOutput } from "../../../../recall/conditional-field/engine/path-composition.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { applyObserverPage, createConditionalField, type FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import type { ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const AS_OF = "2026-09-10T00:00:00.000Z";
const relation = (name: string, target = "y"): QueryProgram => ({ schema_version: 1, kind: "relation", relation_kind: name,
  source_variable: "x", target_variable: target, facet_mode: "same_path", threshold_milligrades: 0,
  guard: { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" } });
const query = (program: QueryProgram): QueryInterpretation => ({ schema_version: 1, query_id: "path-resumption", snapshot_id: SNAPSHOT_ID,
  status: "resolved", holes: [], hypotheses: [], program, view: defaultView() });
const row = (predicate: string, target: string, id: string) => ({ assertionId: id, sourceObjectId: "a", targetObjectId: target,
  resultObjectId: target, predicate, source_revision: "rev", validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" } });

function setup(program: QueryProgram) {
  const interpretation = query(program);
  const state = createConditionalField({ interpretation, budget: defaultBudget({ work_units: 10000, memory_bytes: 1000000 }),
    seeds: seedProgramStates(program).map((program_state) => ({ schema_version: 1, state: productKey("a", "h0", "unbound", program_state), milligrades: 1000 })) });
  return { interpretation, state };
}

describe("bounded path effect continuation", () => {
  it.each(["seed", "facet"])("re-fires an already observed row after a later %s changes its semantic input", (delta) => {
    const { interpretation, state } = setup(relation("p"));
    let nativeRows = 0;
    const readers: ObserverReaders = {
      lexical: () => ({ ids: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0, truncated: false }),
      source: ({ objectId }) => ({ row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active", scope_class: "project" },
        rowsRead: 1, bytesRead: 1, unavailable: false }),
      relation: ({ subject, predicate, afterAssertionId }) => {
        const rows = subject === "a" && predicate === "p" && afterAssertionId === null ? [row("p", "b", "old-edge")] : [];
        nativeRows += rows.length;
        return { observations: rows, nativeVisits: rows.length, nativeBytes: rows.length, rowsRead: rows.length,
          bytesRead: rows.length, truncated: false, committedThrough: rows.at(-1)?.assertionId ?? afterAssertionId };
      }
    };
    const request = { workspace_id: "workspace-1", query_text: "a", as_of: AS_OF, readers,
      budget: defaultBudget({ work_units: 10000, memory_bytes: 1000000 }) };
    const observed = observeField(interpretation, { ...request, resume_field: state });
    expect(observed.pending_path_effects).toBeUndefined();
    expect(nativeRows).toBe(1);
    const from = observed.seeds.at(0)!.state;
    const lateSeed = { schema_version: 1 as const, state: { ...from, hypothesis_id: "late-hypothesis" }, milligrades: 1000 };
    const changed = applyObserverPage({ ...observed, remaining_exploration: 10000 }, { page: {
      schema_version: 1, query_id: interpretation.query_id, snapshot_id: SNAPSHOT_ID, observations: [],
      cursor: { schema_version: 1, cursor_id: "late", region_id: "adjacency", query_id: interpretation.query_id,
        snapshot_id: SNAPSHOT_ID, position: null, committed_through: null },
      outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] },
      effects: [delta === "seed" ? { observation_id: "late", seed: lateSeed, admitted_seed: true }
        : { observation_id: "late", facet: { schema_version: 1, path_id: composedFacetPathId(from, "late-facet"),
          obligations: [{ obligation_id: "late-obligation", domain_id: "association" }], coordinates: [321] } }] });
    expect(changed.retention_rejected).toBeUndefined();
    const resumed = observeField(interpretation, { ...request, resume_field: changed });
    expect(nativeRows).toBe(1);
    expect(resumed.pending_path_effects).toBeUndefined();
    if (delta === "seed") expect(resumed.transitions.some((edge) => edge.to.hypothesis_id === "late-hypothesis"
      && productSubjectId(edge.to) === "b")).toBe(true);
    else {
      const target = resumed.transitions.find((edge) => productSubjectId(edge.to) === "b")!.to;
      expect(resumed.facets.some((facet) => facetBelongsToOutput(facet.path_id, target)
        && facet.coordinates.includes(321))).toBe(true);
    }
  });
  it.each([3, 4])("re-fires one retained self edge through %i local program occurrences", (count) => {
    const { interpretation, state } = setup({ schema_version: 1, kind: "repeat", count,
      local_variables: ["x", "y"], body: relation("p") });
    let nativeRows = 0;
    const edge = row("p", "a", "self");
    const readers: ObserverReaders = {
      lexical: () => ({ ids: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0, truncated: false }),
      source: ({ objectId }) => ({ row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active", scope_class: "project" },
        rowsRead: 1, bytesRead: 1, unavailable: false }),
      relation: ({ subject, predicate, afterAssertionId }) => {
        const rows = subject === "a" && predicate === "p" && afterAssertionId === null ? [edge] : [];
        nativeRows += rows.length;
        return { observations: rows, nativeVisits: rows.length, nativeBytes: rows.length, rowsRead: rows.length,
          bytesRead: rows.length, truncated: false, committedThrough: rows.at(-1)?.assertionId ?? afterAssertionId };
      }
    };
    let actual = state;
    for (let turn = 0; turn < 200; turn += 1) {
      actual = observeField(interpretation, { workspace_id: "workspace-1", query_text: "a", as_of: AS_OF, readers,
        resume_field: actual, budget: defaultBudget({ work_units: 100, finalization_reserve: 20, memory_bytes: 1000000 }) });
      if (actual.pending_path_effects === undefined && actual.closure.observation === "exhausted") break;
    }
    expect(nativeRows).toBe(1);
    expect(actual.pending_path_effects).toBeUndefined();
    expect(actual.binding.kind === "bound" && actual.binding.snapshot.values.some((value) =>
      value.accepting && productSubjectId(value.state) === "a" && value.milligrades === 1000)).toBe(true);
  });
  it("resumes distinct binding combinations and replays an old uncommitted offset", () => {
    const program: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [relation("p", "y"), relation("q", "z")] };
    const { state, interpretation } = setup(program);
    const rows = [row("p", "b1", "p1"), row("p", "b2", "p2"), row("q", "c1", "q1"), row("q", "c2", "q2")];
    const facts = new Map(["a", "b1", "b2", "c1", "c2"].map((object_id) => [object_id, { object_id, source_revision: "rev" }]));
    const input = { interpretation, asOf: AS_OF, liveStates: state.seen_identities, sourceFacts: facts, overlay: {} };
    const expected = adjacencyEffectsForRows(rows, input).filter((effect) => effect.hyperedge !== undefined);
    expect(expected).toHaveLength(4);
    const cursor = createAdjacencyEffectCursor(rows, input);
    const replacement = { ...input, sourceFacts: new Map(), liveStates: [...input.liveStates] };
    const replacementRows = [...rows, row("q", "polluted", "late-row")];
    expect(replacementRows).not.toBe(rows);
    expect(replacement.sourceFacts).not.toBe(input.sourceFacts);
    let offset = 0;
    const actual: string[] = [];
    let complete = false;
    for (let turn = 0; turn < 500 && !complete; turn += 1) {
      const page = cursor.advance(offset, 1, 1000000);
      expect(page.work).toBeLessThanOrEqual(1);
      actual.push(...page.effects.filter((effect) => effect.hyperedge !== undefined).map((effect) => effect.hyperedge!.to.binding_context));
      offset = page.offset;
      complete = page.status === "complete";
    }
    expect(complete).toBe(true);
    expect(actual.sort()).toEqual(expected.map((effect) => effect.hyperedge!.to.binding_context).sort());
    const replay = cursor.advance(0, 10000, 1000000);
    expect(replay.effects.filter((effect) => effect.hyperedge !== undefined)).toHaveLength(4);
  });

  it("keeps a generated effect after observer retention refusal and delivers it on a larger continuation", () => {
    const { interpretation, state } = setup(relation("p"));
    const edge = row("p", "b", "assertion-p");
    let nativeRows = 0;
    const readers: ObserverReaders = {
      lexical: () => ({ ids: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0, truncated: false }),
      source: ({ objectId }) => ({ row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active", scope_class: "project" },
        rowsRead: 1, bytesRead: 1, unavailable: false }),
      relation: ({ subject, predicate, afterAssertionId }) => {
        const rows = subject === "a" && predicate === "p" && afterAssertionId === null ? [edge] : [];
        nativeRows += rows.length;
        return { observations: rows, nativeVisits: rows.length, nativeBytes: rows.length, rowsRead: rows.length,
          bytesRead: rows.length, truncated: false, committedThrough: rows.at(-1)?.assertionId ?? afterAssertionId };
      }
    };
    const request = { workspace_id: "workspace-1", query_text: "a", as_of: AS_OF, readers };
    let failed: FieldEngineState | undefined;
    for (let memory = 8000; memory < 60000; memory += 200) {
      const candidate = observeField(interpretation, { ...request, resume_field: state,
        budget: defaultBudget({ work_units: 1000, finalization_reserve: 0, min_envelope: 0, memory_bytes: memory }) });
      if (candidate.retention_rejected !== undefined && candidate.pending_path_effects !== undefined) { failed = candidate; break; }
    }
    expect(failed?.pending_path_effects?.offset).toBe(0);
    expect(failed!.pending_path_effects!.completed_work).toBeGreaterThan(0);
    expect(failed!.remaining_memory_bytes).toBeGreaterThanOrEqual(0);
    expect(failed!.budget.memory_bytes - failed!.remaining_memory_bytes).toBeGreaterThanOrEqual(failed!.pending_path_effects!.retained_bytes);
    const readBeforeResume = nativeRows;
    const delivered = observeField(interpretation, { ...request, resume_field: failed,
      budget: defaultBudget({ work_units: 10000, memory_bytes: 1000000 }) });
    expect(delivered.pending_path_effects).toBeUndefined();
    if (delivered.binding.kind !== "bound") throw new Error("expected bound field");
    expect(delivered.binding.snapshot.values.some((value) => value.accepting && productSubjectId(value.state) === "b"
      && value.milligrades === 1000)).toBe(true);
    expect(nativeRows).toBe(readBeforeResume);
    expect(failed?.transitions).toHaveLength(0);
  });

  it("admits the source-fact snapshot and scratch before executing a step, and accounts a refused peek", () => {
    const { state, interpretation } = setup(relation("p"));
    const facts = new Map(["a", "b"].map((object_id) => [object_id, { object_id, source_revision: "rev" }]));
    const options = { interpretation, asOf: AS_OF, liveStates: state.seen_identities, sourceFacts: facts, overlay: {} };
    const rows = [row("p", "b", "p")];
    expect(createAdjacencyEffectCursor(rows, options, 100)).toBeUndefined();
    const cursor = createAdjacencyEffectCursor(rows, options);
    const initial = cursor.advance(0, 0, 1000000);
    expect(initial.work).toBe(0);
    expect(initial.retained_bytes).toBeGreaterThanOrEqual(8192);
    const refused = cursor.advance(0, 1, initial.retained_bytes);
    expect(refused.work).toBe(1);
    expect(refused.completed_work).toBe(1);
    expect(refused.status).toBe("memory_exhausted");
    expect(refused.retained_bytes).toBe(initial.retained_bytes);
    const waiting = cursor.advance(0, 1, initial.retained_bytes);
    expect(waiting.work).toBe(0);
    expect(waiting.completed_work).toBe(refused.completed_work);
    const resumed = cursor.advance(0, 10000, 1000000);
    expect(resumed.effects.some((effect) => effect.transition?.to.target.kind === "memory_entry" && effect.transition.to.target.object_id === "b")).toBe(true);
  });

  it("does not visit retained input elements before work admission", () => {
    const { state, interpretation } = setup(relation("p"));
    let visits = 0;
    const liveStates = new Proxy(Array.from({ length: 10000 }, () => state.seen_identities.at(0)!), {
      get(target, key, receiver) { if (typeof key === "string" && /^\d+$/u.test(key)) visits += 1;
        return Reflect.get(target, key, receiver); }
    });
    const cursor = createAdjacencyEffectCursor([], { interpretation, asOf: AS_OF, liveStates, overlay: {} });
    expect(cursor.advance(0, 0, 1000000).work).toBe(0);
    expect(visits).toBe(0);
    cursor.advance(0, 1, 1000000);
    expect(visits).toBe(0);
  });
});
