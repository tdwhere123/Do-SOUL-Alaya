import { describe, expect, it, vi } from "vitest";
import { productSubjectId, type QueryProgram } from "@do-soul/alaya-protocol";
import { ObservedRelations } from "../../../../recall/conditional-field/engine/observed-relations.js";
import * as observedRelations from "../../../../recall/conditional-field/engine/observed-relations.js";
import { withdrawDerivationLeaves, type FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { RequestCostLedger } from "../../../../recall/runtime/request-cost-ledger.js";
import { ObservedSourceFacts } from "../../../../recall/runtime/observed-source-facts.js";
import type { ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { defaultBudget } from "../reference/deployment.fixture.js";
import { AS_OF, OPEN_GUARD, AUTH_GUARD, relation, query, edge, project, sequenceHyperedge, storedFacts } from "./relation-grounding.fixture.js";

describe("observed relation pages", () => {
  const program: QueryProgram = { schema_version: 1, kind: "alternative", options: [relation("p", "y", AUTH_GUARD), relation("q")] };

  function run(rows: readonly ReturnType<typeof edge>[], options: Readonly<{
    lexicalIds?: readonly string[];
    unavailable?: ReadonlySet<string>;
    scopes?: Readonly<Record<string, string>>;
    resume?: FieldEngineState;
    cost?: RequestCostLedger;
    work?: number;
    memory?: number;
    program?: QueryProgram;
    pageSize?: number;
    readers?: Partial<ObserverReaders>;
  }> = {}) {
    const readers: ObserverReaders = {
      lexical: () => ({ ids: options.lexicalIds ?? ["a"], nativeVisits: 1, nativeBytes: 1, rowsRead: 1, bytesRead: 1, truncated: false }),
      source: ({ objectId }) => options.unavailable?.has(objectId) === true
        ? { row: null, rowsRead: 0, bytesRead: 0, unavailable: true }
        : { row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active", scope_class: options.scopes?.[objectId] ?? "project" },
          rowsRead: 1, bytesRead: 32, unavailable: false },
      relation: ({ subject, predicate, afterAssertionId, limit, nativeLimit }) => {
        const remaining = rows.filter((row) => row.sourceObjectId === subject && row.predicate === predicate
          && row.assertionId > (afterAssertionId ?? "")).sort((left, right) => left.assertionId.localeCompare(right.assertionId));
        const observations = remaining.slice(0, Math.min(limit, nativeLimit, options.pageSize ?? Infinity));
        return { observations, nativeVisits: observations.length, nativeBytes: observations.length, rowsRead: observations.length,
          bytesRead: observations.length, truncated: observations.length < remaining.length,
          committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
      },
      ...options.readers
    };
    const state = observeField(query(options.program ?? program, { hypotheses: [{ schema_version: 1, hypothesis_id: "h",
      bindings: [{ schema_version: 1, variable: "c", value: "x" }] }] }), {
      workspace_id: "workspace-1", query_text: "a", as_of: AS_OF, readers, authorized_scopes: null,
      ...(options.resume === undefined ? {} : { resume_field: options.resume }),
      ...(options.cost === undefined ? {} : { cost: options.cost }),
      budget: defaultBudget({ work_units: options.work ?? 200_000, memory_bytes: options.memory ?? 2_000_000, finalization_reserve: 0, min_envelope: 0 })
    });
    const accepted = state.binding.kind === "bound" ? state.binding.snapshot.values
      .filter((value) => value.accepting && (value.milligrades ?? 0) > 0).map((value) => productSubjectId(value.state)).sort() : [];
    return { state, accepted };
  }

  it("preserves independent endpoint additions with less work than the full-replay fallback", () => {
    const rows = Array.from({ length: 32 }, (_, index) => {
      const id = String(index).padStart(2, "0");
      return edge("p", "a", `target-${id}`, `p-${id}`);
    });
    const options = { program: relation("p"), pageSize: 1, work: 50_000, memory: 20_000_000 };
    const observed = run(rows, options);
    const fallback = vi.spyOn(observedRelations, "checkRetainedRelationFacts")
      .mockReturnValue({ unaffected: false, work: 0, admitted_bytes: 0 });
    let conservative: ReturnType<typeof run>;
    try { conservative = run(rows, options); }
    finally { fallback.mockRestore(); }
    expect(observed.accepted).toEqual(rows.map((row) => row.targetObjectId));
    expect(conservative.accepted).toEqual(rows.map((row) => row.targetObjectId));
    expect(project(observed.state)).toEqual(project(conservative.state));
    expect(observed.state.remaining_exploration).toBeGreaterThan(conservative.state.remaining_exploration);
    expect(observed.state.remaining_exploration).toBeGreaterThan(0);
    expect(observed.state.pending_path_effects).toBeUndefined();
    expect(observed.state.observation_gaps?.guards).not.toBe(true);
  });

  it("keeps changed endpoint identities and nested bound-variable guards on the conservative path", () => {
    const rows = new ObservedRelations().with(edge("p", "a", "b", "retained"));
    const before = storedFacts(["a", "b"]), after = before.with("new", { object_id: "new", source_revision: "rev" });
    const check = (program: QueryProgram, facts = after, work = 100) => observedRelations.checkRetainedRelationFacts({
      rows, program, before, after: facts, work_limit: work, memory_limit: 1024
    });
    expect(check(relation("p")).unaffected).toBe(true);
    expect(check(relation("p", "y", { ...OPEN_GUARD, predicate_name: "named-predicate" })).unaffected).toBe(false);
    expect(check(sequenceHyperedge([relation("p", "y", AUTH_GUARD)])).unaffected).toBe(false);
    expect(check(relation("p"), after.with("a", { object_id: "a", source_revision: "new-revision" })).unaffected).toBe(false);
    expect(check(relation("p"), after.with("b", { object_id: "b", source_revision: "rev",
      interpretation_node: { packet_id: "new-packet", hypothesis_id: "h", node_id: "b" } })).unaffected).toBe(false);
    expect(check(relation("p"), after, 1)).toMatchObject({ unaffected: false, work: 1 });
  });

  it("resumes charged endpoint pages without losing rows or proof alternatives", () => {
    const rows = Array.from({ length: 8 }, (_, index) => edge("p", "a", `target-${index}`, `p-${index}`));
    const options = { program: relation("p"), pageSize: 1, memory: 20_000_000 };
    const fresh = run(rows, options);
    const interrupted = run(rows, { ...options, work: 180 });
    expect(interrupted.state.last_observer_status).toBe("interrupted");
    expect(interrupted.state.remaining_exploration).toBeGreaterThanOrEqual(0);
    expect(interrupted.state.observed_relations).toBeInstanceOf(ObservedRelations);
    expect((interrupted.state.observed_relations as ObservedRelations).index_work).toBeGreaterThan(0);
    const resumed = run(rows, { ...options, resume: interrupted.state });
    expect(resumed.accepted).toEqual(rows.map((row) => row.targetObjectId));
    expect(project(resumed.state)).toEqual(project(fresh.state));
    expect(resumed.state.observed_relation_bytes).toBe((resumed.state.observed_relations as ObservedRelations).bytes);
  });

  it("restores withdrawn arrays without treating a newly added page as a complete endpoint index", () => {
    const rows = [edge("p", "a", "b", "p-0"), edge("p", "a", "c", "p-1")];
    const options = { program: relation("p"), memory: 20_000_000 };
    const first = run(rows, options);
    const withdrawn = withdrawDerivationLeaves(first.state, "p-1");
    expect(withdrawn.observed_relations).toBeInstanceOf(Array);
    const reopened = { ...withdrawn,
      residuals: withdrawn.residuals.map((region) => region.kind === "seed" ? { ...region, status: "open" as const } : region),
      resume_cursors: { ...withdrawn.resume_cursors, seed: null } };
    const restored = run([...rows, edge("p", "d", "e", "p-2")], { ...options, resume: reopened, lexicalIds: ["d"] });
    expect(restored.accepted).toEqual(["b", "e"]);
    const retained = restored.state.observed_relations as ObservedRelations;
    expect(retained).toBeInstanceOf(ObservedRelations);
    expect(retained.index_work).toBe(0);
    expect(retained.hasEndpoint("a")).toBeUndefined();
    expect(retained.hasEndpoint("e")).toBeUndefined();
    expect([...retained].map((row) => row.assertionId)).toEqual(["p-0", "p-2"]);
  });

  it("rejects oversized endpoint facts and index retention before advancing the page, then resumes", () => {
    const rows = Array.from({ length: 16 }, (_, index) => edge("p", "a",
      `target-${String(index).padStart(2, "0")}-${"x".repeat(220)}`, `p-${String(index).padStart(2, "0")}`));
    const options = { program: relation("p"), pageSize: 16 };
    const retention = vi.spyOn(ObservedRelations.prototype, "with");
    let limited: ReturnType<typeof run>;
    try {
      limited = run(rows, { ...options, memory: 40_000 });
      expect(retention.mock.calls.some(([row]) => row.assertionId === "p-00"), JSON.stringify({
        exhausted: limited.state.memory_exhausted, remaining: limited.state.remaining_memory_bytes,
        work: limited.state.remaining_exploration, rows: limited.state.observed_relations?.length
      })).toBe(true);
    } finally { retention.mockRestore(); }
    expect(limited.state.memory_exhausted).toBe(true);
    expect(limited.state.observed_relations?.length ?? 0).toBe(0);
    expect(limited.state.source_facts?.has(rows[0]!.targetObjectId)).not.toBe(true);
    expect(limited.state.pair_progress.get("a\0p")).not.toBe("p-15");
    expect(limited.state.remaining_exploration).toBeGreaterThanOrEqual(0);
    const resumed = run(rows, { ...options, memory: 20_000_000, resume: limited.state });
    const fresh = run(rows, { ...options, memory: 20_000_000 });
    expect(resumed.accepted).toEqual(rows.map((row) => row.targetObjectId));
    expect(project(resumed.state)).toEqual(project(fresh.state));
    expect(resumed.state.observed_relations?.length).toBe(16);
  });

  it("captures facts learned from a row filtered by withdrawal before choosing the page delta", () => {
    const old = edge("p", "a", "prior-target", "old");
    let release = false;
    const source: NonNullable<ObserverReaders["source"]> = ({ objectId }) => objectId === "b" && !release
      ? { row: null, rowsRead: 0, bytesRead: 0, unavailable: true }
      : { row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active", scope_class: "project" },
        rowsRead: 1, bytesRead: 32, unavailable: false };
    const options = { program: relation("p"), memory: 20_000_000 };
    const first = run([old], { ...options, readers: { source } });
    expect(first.state.source_facts?.has("b")).toBe(false);
    const withdrawn = withdrawDerivationLeaves(first.state, "withdrawn");
    const reopened = { ...withdrawn,
      residuals: withdrawn.residuals.map((region) => region.kind === "seed" ? { ...region, status: "open" as const } : region),
      resume_cursors: { ...withdrawn.resume_cursors, seed: null } };
    const incoming = [edge("p", "c", "d", "kept"), edge("p", "c", "b", "withdrawn")];
    const capture = vi.spyOn(ObservedSourceFacts.prototype, "captureChanges");
    let resumed: ReturnType<typeof run>;
    try {
      resumed = run([old, ...incoming], { ...options, lexicalIds: ["c"], resume: reopened, readers: {
        source,
        relation: ({ subject, predicate, afterAssertionId }) => {
          const observations = incoming.filter((row) => row.sourceObjectId === subject && row.predicate === predicate
            && row.assertionId > (afterAssertionId ?? ""));
          if (observations.some((row) => row.assertionId === "withdrawn")) release = true;
          return { observations, nativeVisits: observations.length, nativeBytes: observations.length,
            rowsRead: observations.length, bytesRead: observations.length, truncated: false,
            committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
        }
      } });
      expect(capture.mock.results.some((result) => result.type === "return"
        && !result.value.changes.before.has("b") && result.value.changes.after.has("b"))).toBe(true);
    } finally { capture.mockRestore(); }
    expect(resumed.state.source_facts?.has("b")).toBe(true);
    expect([...resumed.state.observed_relations ?? []].map((row) => row.assertionId).sort()).toEqual(["kept", "old"]);
    expect(resumed.accepted).toEqual(["d", "prior-target"]);
  });

  it("keeps an unknown from an earlier page when later pages arrive", () => {
    const guarded = edge("p", "a", "b", "p-row");
    const plain = Array.from({ length: 20 }, (_, index) => edge("q", "a", `q-${String(index).padStart(2, "0")}`, `q-${String(index).padStart(2, "0")}`));
    const cost = new RequestCostLedger();
    const observed = run([guarded, ...plain], { unavailable: new Set(["x"]), cost });
    expect(observed.state.observation_gaps?.guards).toBe(true);
    expect(observed.accepted).toEqual(plain.map((row) => row.targetObjectId));
    expect(cost.snapshot().phases.adjacency.joins).toBeGreaterThan(0);
    const reopened = { ...observed.state,
      residuals: observed.state.residuals.map((region) => region.kind === "seed" ? { ...region, status: "open" as const } : region),
      resume_cursors: { ...observed.state.resume_cursors, seed: null } };
    const known = run([guarded, ...plain], { resume: reopened, lexicalIds: ["x"], scopes: { x: "project" }, memory: 20_000_000 });
    expect(known.state.observation_gaps?.guards).toBe(false);
    expect(known.accepted).toEqual(["b", ...plain.map((row) => row.targetObjectId)].sort());
    const unrelated = run([guarded, ...plain], { unavailable: new Set(["x"]), resume: reopened, lexicalIds: ["other"], memory: 20_000_000 });
    expect(unrelated.state.source_facts?.has("other")).toBe(true);
    expect(unrelated.state.observation_gaps?.guards).toBe(true);
    expect(unrelated.accepted).toEqual(observed.accepted);
  });

  it("rechecks an old row when a later page learns its endpoint fact", () => {
    const early = edge("p", "a", "b", "p-00");
    const fillers = Array.from({ length: 15 }, (_, index) => edge("p", "a", `t-${String(index).padStart(2, "0")}`, `p-${String(index + 1).padStart(2, "0")}`));
    const later = edge("p", "a", "x", "p-16");
    let release = false;
    const readers: ObserverReaders = {
      lexical: () => ({ ids: ["a"], nativeVisits: 1, nativeBytes: 1, rowsRead: 1, bytesRead: 1, truncated: false }),
      source: ({ objectId }) => objectId === "x" && !release
        ? { row: null, rowsRead: 0, bytesRead: 0, unavailable: true }
        : { row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active", scope_class: "project" },
          rowsRead: 1, bytesRead: 32, unavailable: false },
      relation: ({ subject, predicate, afterAssertionId, limit, nativeLimit }) => {
        const pool = release ? [early, ...fillers, later] : [early, ...fillers];
        const remaining = pool.filter((row) => row.sourceObjectId === subject && row.predicate === predicate
          && row.assertionId > (afterAssertionId ?? "")).sort((left, right) => left.assertionId.localeCompare(right.assertionId));
        const observations = remaining.slice(0, Math.min(limit, nativeLimit));
        const hidden = !release && subject === "a" && predicate === "p";
        return { observations, nativeVisits: observations.length, nativeBytes: observations.length, rowsRead: observations.length,
          bytesRead: observations.length, truncated: hidden || observations.length < remaining.length,
          committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
      }
    };
    const interpretation = query(program, { hypotheses: [{ schema_version: 1, hypothesis_id: "h",
      bindings: [{ schema_version: 1, variable: "c", value: "x" }] }] });
    const request = { workspace_id: "workspace-1", query_text: "a", as_of: AS_OF, readers, authorized_scopes: null,
      budget: defaultBudget({ work_units: 200_000, memory_bytes: 20_000_000, finalization_reserve: 0, min_envelope: 0 }) };
    const held = observeField(interpretation, request);
    expect(held.transitions.some((row) => row.instance_id === "p-00")).toBe(false);
    expect(held.observation_gaps?.guards).toBe(true);
    release = true;
    const learned = observeField(interpretation, { ...request, resume_field: held });
    expect(learned.transitions.some((row) => row.instance_id === "p-00")).toBe(true);
    expect(learned.observation_gaps?.guards).toBe(false);
  });
});
