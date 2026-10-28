import { describe, expect, it } from "vitest";
import {
  productSubjectId, productStateKeyFromIndexEntry, type FieldSnapshot, type IndexEntry, type InformationIndex } from "@do-soul/alaya-protocol";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { groundedOutputDerivations, type GroundingProgress } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { ExplanationDelivery } from "../../../../recall/conditional-field/index/explanation-delivery.js";
import { projectPageExplanations } from "../../../../recall/conditional-field/index/project-page-explanations.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

describe("one allowance across grounding, projection, and payload", () => {
  it.each([0, 1])("releases a completed retained proof when %s selected members cannot coexist with the delivery ledger", count => {
    const source = snapshot(2);
    const ground = groundedOutputDerivations({ seeds: source.seeds, transitions: [], derivations: [],
      transition_derivations: {}, allowance: 100 });
    const input = { snapshot: source, query_id: "query", snapshot_id: SNAPSHOT_ID, result_version: "v1",
      view: defaultView(), budget: defaultBudget({ page_budget: 2 }), derivations: ground.derivations,
      output_derivations: ground.roots };
    const original = projectAcceptingIndex(input);
    expect(original.entries).toHaveLength(2);
    const prior = new ExplanationDelivery(original.entries, ground.derivations, undefined, 2);
    expect(prior.advance(100, 100_000).complete).toBe(true);
    let retained: ExplanationDelivery | undefined = prior;
    let delta = 0;
    const next = projectPageExplanations({ input: { ...input, explanation_progress: prior,
      delivery_retention: () => ({ required_bytes: 200, releasable_bytes: 0 }),
      on_explanation_progress: (cursor, bytes) => { retained = cursor; delta += bytes; } },
      members: original.entries.slice(0, count), updates: [], productUpdates: [], retractions: [],
      remaining: 1, available: 100, memory: 100, updatesFor: entry => [{ schema_version: 1,
        product: productStateKeyFromIndexEntry(entry), update_kind: "payload", revision: "next", previous_revision: "prior" }] });
    expect(retained).toBeUndefined();
    expect(delta).toBe(-prior.retainedBytes);
    expect(next.members).toHaveLength(count);
    expect(next.members.every(entry => entry.explanation_ids.length === 0)).toBe(true);
    expect(next.input.explanation_materialization_refused).toBe(true);
    expect(next.remaining).toBe(1);
  });

  it("does not advance past buffered outputs when supplied grounding is partial despite ample work", () => {
    const source = snapshot(7);
    const ground = (allowance: number) => groundedOutputDerivations({ seeds: source.seeds,
      transitions: [], derivations: [], transition_derivations: {}, allowance });
    const partial = ground(4);
    const complete = ground(20);
    const read = (prepared: ReturnType<typeof ground>, prior_continuation?: InformationIndex["continuation"]) =>
      projectAcceptingIndex({ snapshot: source, query_id: "query", snapshot_id: SNAPSHOT_ID,
        result_version: "v1", view: defaultView(), budget: defaultBudget({ work_units: 20,
          finalization_reserve: 20, min_envelope: 0, page_budget: 1 }),
        derivations: prepared.derivations, output_derivations: prepared.roots, grounding_complete: prepared.complete,
        prior_continuation, expires_at: "2099-01-01T00:00:00.000Z",
        observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] } });
    let page = read(partial);
    expect(page.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["memory-0"]);
    expect(page.continuation?.cursor).toMatch(/^p1/);
    const ids = page.entries.map((entry) => (entry.object_id ?? ""));
    for (let attempt = 0; page.continuation !== null && attempt < 10; attempt += 1) {
      page = read(complete, page.continuation);
      ids.push(...page.entries.map((entry) => (entry.object_id ?? "")));
    }
    expect(page.continuation).toBeNull();
    expect(page.completeness.logical_index).toBe("complete");
    expect(ids).toEqual(source.values.map((value) => productSubjectId(value.state)));
  });

  it("retains every accepting prerequisite when stateless grounding arrives in reverse order", () => {
    const original = snapshot(7);
    const source = { ...original, seeds: [...original.seeds].reverse() };
    let progress: GroundingProgress | undefined;
    let explanation: ExplanationDelivery | undefined;
    let continuation: InformationIndex["continuation"] = null;
    const ids: string[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const allowance = attempt < 7 ? 3 : 100;
      const priorWork = progress?.completed_work ?? 0;
      let remaining = -1, proofWork = 0;
      const index = projectAcceptingIndex({ snapshot: source, query_id: "query", snapshot_id: SNAPSHOT_ID,
        result_version: "v1", view: defaultView(), budget: defaultBudget({ work_units: allowance,
          finalization_reserve: allowance, min_envelope: 0, page_budget: 1 }),
        transition_derivations: {}, derivations: [], grounding_progress: progress, explanation_progress: explanation,
        prior_continuation: continuation, expires_at: "2099-01-01T00:00:00.000Z",
        observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] },
        on_grounding_progress: (next) => { progress = next; },
        on_explanation_progress: (next, _bytes, work) => { explanation = next; proofWork += work; },
        finalize_payload: (entries, available) => ({ remaining: available - entries.length, complete: true }),
        on_remaining_reserve: (next) => { remaining = next; }
      });
      const used = (progress?.completed_work ?? 0) - priorWork + proofWork + index.entries.length;
      expect(used).toBeLessThanOrEqual(allowance);
      expect(remaining).toBeGreaterThanOrEqual(0);
      expect(remaining).toBeLessThanOrEqual(allowance - used);
      expect(index.completeness.logical_index).not.toBe("invalidated");
      ids.push(...index.entries.map((entry) => (entry.object_id ?? "")));
      continuation = index.continuation;
      if (attempt < 6) {
        expect(index.entries).toEqual([]);
        expect(continuation?.cursor).toMatch(/^p0g/);
      }
      if (continuation === null) {
        expect(index.completeness.logical_index).toBe("complete");
        break;
      }
    }
    expect(continuation).toBeNull();
    expect(ids).toEqual(source.values.map((value) => productSubjectId(value.state)));
  });

  it("keeps a projection cursor at the end while nontransport work remains", () => {
    const source = snapshot(2);
    const first = projectStateless(source, 1, 1, undefined, "open");
    expect(first.index.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["memory-0"]);
    expect(first.index.continuation?.cursor).toMatch(/^p1/);
    const lastEntry = projectStateless(source, 1, 1, first.index.continuation, "open");
    expect(lastEntry.index.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["memory-1"]);
    expect(lastEntry.index.continuation?.cursor).toMatch(/^p2/);
    const completed = projectStateless(source, 1, 1, lastEntry.index.continuation);
    expect(completed.index.entries).toEqual([]);
    expect(completed.index.continuation).toBeNull();
    expect(completed.index.completeness.logical_index).toBe("complete");
  });

  it("invalidates when an emitted product identity disappears", () => {
    const source = snapshot(7);
    const first = projectStateless(source, 3, 1);
    expect(first.index.continuation?.cursor).toMatch(/^p1/);
    const original = source.values[0]!;
    const revised = { ...original, state: { ...original.state, object_id: "changed-first" } };
    const result = projectStateless({ ...source, values: [revised, ...source.values.slice(1)] },
      3, 1, first.index.continuation);
    expect(result.index.completeness.logical_index).toBe("invalidated");
    expect(result.index.entries).toEqual([]);
    expect(result.index.continuation).toBeNull();
  });

  it("records a grade change of an emitted product as a typed update", () => {
    const source = snapshot(7);
    const first = projectStateless(source, 3, 1);
    const original = source.values[0]!;
    const result = projectStateless({ ...source, values: [{ ...original, milligrades: 800 }] },
      3, 1, first.index.continuation);
    expect(result.index.completeness.logical_index).not.toBe("invalidated");
    expect(result.index.page_purpose).toBe("update");
    expect(result.index.product_updates).toHaveLength(1);
    expect(result.index.entries).toEqual([]);
    expect(result.index.product_updates?.[0]?.update_kind).toBe("proof");
  });

  it("does not replay a withdrawn product as a new membership slot", () => {
    const source = snapshot(7);
    const first = projectStateless(source, 3, 1);
    const original = source.values[0]!;
    const result = projectStateless({ ...source, values: [{ ...original, accepting: false }, ...source.values.slice(1)] },
      3, 1, first.index.continuation);
    expect(result.index.completeness.logical_index).not.toBe("invalidated");
    expect(result.index.entries).toEqual([]);
    expect(result.index.page_purpose).toBe("update");
    expect(result.index.product_updates?.map((update) => update.update_kind)).toEqual(["retraction"]);
    const later = projectStateless({ ...source, values: [{ ...original, accepting: false }, ...source.values.slice(1)] },
      3, 1, result.index.continuation);
    expect(later.index.entries.map((entry) => entry.object_id)).toEqual(["memory-1"]);
  });

  it("allows suffix growth behind an unchanged stateless prefix", () => {
    const first = projectStateless(snapshot(7), 3, 1);
    const second = projectStateless(snapshot(8), 3, 1, first.index.continuation);
    expect(second.index.completeness.logical_index).not.toBe("invalidated");
    expect(second.index.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["memory-1"]);
  });

  it("skips already-emitted products under a smaller budget instead of replaying the prefix", () => {
    const source = snapshot(7);
    const first = projectStateless(source, 20, 4);
    expect(first.index.completeness.logical_index).toBe("complete");
    expect(first.index.continuation?.emitted_revisions).toBeDefined();
    const small = projectStateless(source, 2, 1, first.index.continuation);
    expect(small.index.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["memory-4"]);
    const resumed = projectStateless(source, 20, 7, small.index.continuation);
    expect(resumed.index.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["memory-5", "memory-6"]);
    expect(resumed.index.continuation).toBeNull();
    expect(resumed.index.completeness.logical_index).toBe("complete");
  });

  it("does not advance a zero-width page over an undisplayed product", () => {
    const source = snapshot(7);
    const first = projectStateless(source, 3, 0);
    expect(first.remaining).toBe(3);
    expect(first.index.entries).toEqual([]);
    expect(first.index.continuation?.cursor).toMatch(/^p0/);
    const resumed = projectStateless(source, 3, 1, first.index.continuation);
    expect(resumed.index.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["memory-0"]);
  });

  it("keeps bounded progress after an offset prefix fits but the full snapshot no longer fits", () => {
    const source = snapshot(7);
    const first = projectStateless(source, 20, 4);
    const bounded = projectStateless(source, 5, 1, first.index.continuation);
    expect(bounded.index.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["memory-4"]);
    expect(bounded.index.continuation?.cursor).toMatch(/^p5/);
    const larger = projectStateless(source, 20, 1, bounded.index.continuation);
    expect(larger.index.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["memory-5"]);
    expect(larger.index.continuation?.cursor).toMatch(/^p6/);
    const last = projectStateless(source, 20, 1, larger.index.continuation);
    expect(last.index.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["memory-6"]);
    expect(last.index.continuation).toBeNull();
    expect(last.index.completeness.logical_index).toBe("complete");
  });

  it.each(["without-grounding", "supplied-derivations"].flatMap((mode) => [1, 7].flatMap((page_budget) =>
    [false, true].map((withPayload) => ({ mode, page_budget, withPayload })))))(
    "uses the declared reserve and retains every output: $mode, page=$page_budget, payload=$withPayload",
    ({ mode, page_budget, withPayload }) => {
      const source = snapshot(7);
      const ground = groundedOutputDerivations({ seeds: source.seeds, transitions: [], derivations: [],
        transition_derivations: {}, allowance: 100 });
      const suppliedRevision = `${ground.progress.input_digest}:${ground.progress.completed_work}`;
      const ids: string[] = [];
      let continuation: InformationIndex["continuation"] = null;
      let explanation: ExplanationDelivery | undefined;
      let scanOffset = 0;
      let deliveredProofs = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const allowance = mode === "supplied-derivations" && attempt >= 4 ? 500 : 3;
        let nextOffset = scanOffset;
        let payloadWork = 0, explanationWork = 0;
        let remaining = -1;
        const index = projectAcceptingIndex({ snapshot: source, query_id: "query", snapshot_id: SNAPSHOT_ID,
          result_version: "v1", view: defaultView(), budget: defaultBudget({ work_units: allowance,
            finalization_reserve: allowance, min_envelope: 0, page_budget }),
          ...(mode === "supplied-derivations" ? { transition_derivations: {},
            derivations: structuredClone(ground.derivations), output_derivations: ground.roots,
            explanation_source_revision: suppliedRevision } : {}),
          prior_continuation: continuation, expires_at: "2099-01-01T00:00:00.000Z",
          explanation_progress: explanation,
          observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] },
          on_projection_progress: (next) => { nextOffset = next; },
          on_explanation_progress: (next, _bytes, work) => { explanation = next; explanationWork += work; },
          ...(withPayload ? { finalize_payload: (entries: readonly IndexEntry[], available: number) => {
            payloadWork = entries.length;
            expect(available).toBeGreaterThanOrEqual(payloadWork);
            return { remaining: available - payloadWork, complete: true };
          } } : {}),
          on_remaining_reserve: (next) => { remaining = next; }
        });
        const used = Math.max(0, nextOffset - scanOffset) + payloadWork + explanationWork;
        expect(used).toBeLessThanOrEqual(allowance);
        expect(remaining).toBeLessThanOrEqual(allowance - used);
        expect(remaining).toBeGreaterThanOrEqual(0);
        ids.push(...index.entries.map((entry) => (entry.object_id ?? "")));
        deliveredProofs += index.explanations?.length ?? 0;
        continuation = index.continuation;
        scanOffset = nextOffset;
        if (continuation === null) {
          expect(index.completeness.logical_index).toBe("complete");
          break;
        }
      }
      expect(continuation).toBeNull();
      expect(ids).toEqual(source.values.map((value) => productSubjectId(value.state)));
      if (mode === "supplied-derivations") expect(deliveredProofs).toBeGreaterThanOrEqual(source.values.length);
    }
  );

  it.each([2, 3, 7, 20])("never spends more than a %i-unit allowance across the three phases", (allowance) => {
    const result = project(allowance, snapshot(40));
    const used = result.groundingWork + result.projectionWork + result.payloadWork + result.explanationWork;
    expect(used).toBeLessThanOrEqual(allowance);
    expect(result.remaining).toBe(allowance - used);
    expect(result.groundingWork).toBeGreaterThan(0);
    expect(result.index.completeness.logical_index).not.toBe("complete");
  });

  it("resumes a two-unit request after grounding without borrowing the next phase's work", () => {
    const source = snapshot(1);
    const first = project(2, source);
    expect(first.groundingWork).toBe(1);
    expect(first.index.entries).toEqual([]);
    expect(first.remaining).toBe(1);
    expect(first.index.continuation).not.toBeNull();
    expect(first.index.completeness.logical_index).not.toBe("complete");

    const second = project(2, source, first.progress, first.index.continuation, first.explanation);
    expect(second.groundingWork).toBe(0);
    expect(second.projectionWork).toBe(1);
    expect(second.payloadWork).toBe(1);
    expect(second.remaining).toBe(0);
    expect(second.index.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["memory-0"]);
    expect(second.index.continuation).not.toBeNull();
    let current = second;
    for (let attempt = 0; attempt < 20 && current.index.continuation !== null; attempt++) {
      const allowance = attempt < 1 ? 2 : 100;
      current = project(allowance, source, current.progress, current.index.continuation, current.explanation);
      expect(current.groundingWork + current.payloadWork + current.explanationWork).toBeLessThanOrEqual(allowance);
    }
    expect(current.index.continuation).toBeNull();
    expect(current.index.explanations?.length).toBeGreaterThan(0);
    expect(current.index.product_updates?.some(update => update.update_kind === "payload")).toBe(true);
  });
});

function projectStateless(source: FieldSnapshot, allowance: number, page_budget: number,
  prior_continuation?: InformationIndex["continuation"], resource_work?: "open") {
  let remaining = -1;
  const index = projectAcceptingIndex({ snapshot: source, query_id: "query", snapshot_id: SNAPSHOT_ID,
    result_version: "v1", view: defaultView(), budget: defaultBudget({ work_units: allowance,
      finalization_reserve: allowance, min_envelope: 0, page_budget }),
    prior_continuation, resource_work, expires_at: "2099-01-01T00:00:00.000Z",
    observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] },
    on_remaining_reserve: (next) => { remaining = next; }
  });
  return { index, remaining };
}

function project(allowance: number, source: FieldSnapshot, prior?: GroundingProgress,
  continuation?: InformationIndex["continuation"], priorExplanation?: ExplanationDelivery) {
  let progress: GroundingProgress | undefined;
  let explanation: ExplanationDelivery | undefined = priorExplanation, explanationWork = 0;
  let projectionWork = 0;
  let payloadWork = 0;
  let remaining = -1;
  const index = projectAcceptingIndex({ snapshot: source, query_id: "query", snapshot_id: SNAPSHOT_ID,
    result_version: "v1", view: defaultView(), transition_derivations: {}, derivations: [],
    budget: defaultBudget({ work_units: allowance, finalization_reserve: allowance, min_envelope: 0,
      page_budget: 5 }), remaining_reserve: allowance, grounding_progress: prior,
    prior_continuation: continuation, explanation_progress: priorExplanation, expires_at: "2099-01-01T00:00:00.000Z",
    observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] },
    on_grounding_progress: (next) => { progress = next; },
    on_explanation_progress: (next, _bytes, work) => { explanation = next; explanationWork += work; },
    on_projection_progress: (next) => { projectionWork = next; },
    finalize_payload: (entries, available) => {
      payloadWork = entries.length;
      return { remaining: available - payloadWork, complete: true };
    },
    on_remaining_reserve: (next) => { remaining = next; }
  });
  return { index, progress, groundingWork: (progress?.completed_work ?? 0) - (prior?.completed_work ?? 0),
    projectionWork, payloadWork, explanation, explanationWork, remaining };
}

function snapshot(count: number): FieldSnapshot {
  const values = Array.from({ length: count }, (_, index) => ({ schema_version: 1 as const,
    state: { schema_version: 1 as const, target: { kind: "memory_entry" as const, workspace_id: "ws", object_id: `memory-${index}`, source_revision: "rev" }, program_state: "accepting",
      hypothesis_id: "h0", binding_context: "unbound", time_state: "as_of" },
    milligrades: 1000, accepting: true }));
  return { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID, values,
    has_incomparable_activations: false,
    seeds: values.map(({ state, milligrades }) => ({ schema_version: 1, state, milligrades })),
    retained_transitions: [], facets: [] };
}
