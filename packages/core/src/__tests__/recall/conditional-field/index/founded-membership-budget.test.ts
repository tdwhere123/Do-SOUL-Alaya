import { describe, expect, it, vi } from "vitest";
import { DerivationSchema, InformationIndexSchema, type FieldSnapshot, type IndexEntry, type InformationIndex } from "@do-soul/alaya-protocol";
import { continueAcceptingIndex, projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { groundedOutputDerivations } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { ExplanationDelivery } from "../../../../recall/conditional-field/index/explanation-delivery.js";
import type { SeedProofIndex } from "../../../../recall/conditional-field/index/seed-proof-index.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

describe("founded membership under an exhausted explanation allowance", () => {
  it("delivers the member before spending the remaining reserve on payload", () => {
    const state = productKey("member");
    const snapshot: FieldSnapshot = { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID,
      values: [{ schema_version: 1, state, milligrades: 1000, accepting: true }],
      seeds: [{ schema_version: 1, state, milligrades: 1000 }], retained_transitions: [], facets: [] };
    let canonical: readonly IndexEntry[] = [];
    let remaining = -1;
    let proofWork = 0;
    const result = projectAcceptingIndex({ snapshot, query_id: "query", snapshot_id: SNAPSHOT_ID, result_version: "v1",
      view: defaultView(), budget: defaultBudget({ work_units: 4, finalization_reserve: 4, min_envelope: 0, page_budget: 1 }),
      grounding_complete: true, remaining_reserve: 4, remaining_memory_bytes: 1_000_000,
      expires_at: "2099-01-01T00:00:00.000Z",
      observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] },
      on_semantic_entries: (entries) => { canonical = entries; },
      on_explanation_progress: (_progress, _bytes, work) => { proofWork += work; },
      finalize_payload: (entries, available) => ({ remaining: available - entries.length, complete: true }),
      on_remaining_reserve: (available) => { remaining = available; }
    });
    expect(result.entries.map((entry) => entry.object_id)).toEqual(["member"]);
    expect(canonical.map((entry) => entry.object_id)).toEqual(["member"]);
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(1 + proofWork + result.entries.length + remaining).toBe(4);
  });

  it.each(["retained", "supplied"] as const)("charges and resumes a %s forest without withholding founded membership", mode => {
    const state = productKey("member");
    const snapshot: FieldSnapshot = { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID,
      values: [{ schema_version: 1, state, milligrades: 1000, accepting: true }],
      seeds: [{ schema_version: 1, state, milligrades: 1000 }], retained_transitions: [], facets: [] };
    const leaf = DerivationSchema.parse({ schema_version: 1, derivation_id: "leaf", kind: "leaf", children: [],
      observation_ids: ["member"], leaf_ids: ["member"], source_revisions: [] });
    const middle = DerivationSchema.parse({ ...leaf, derivation_id: "middle", kind: "serial", children: ["leaf"] });
    const root = DerivationSchema.parse({ ...leaf, derivation_id: "root", kind: "serial", children: ["middle"] });
    const forest = new Map([leaf, middle, root].map(node => [node.derivation_id, node]));
    let progress: ExplanationDelivery | undefined, page: InformationIndex | undefined, calls = 0, work = 0;
    const base = { snapshot, view: defaultView(), budget: defaultBudget({ work_units: 3, finalization_reserve: 3,
      min_envelope: 0, page_budget: 1, memory_bytes: 1_000_000 }), grounding_complete: true,
      ...(mode === "retained" ? { derivation_forest: forest, output_derivation_roots: new Map([[productStateNodeId(state), ["root"]]]) }
        : { derivations: [leaf, middle, root], output_derivations: { [productStateNodeId(state)]: ["root"] } }),
      remaining_reserve: 3, remaining_memory_bytes: 1_000_000, expires_at: "2099-01-01T00:00:00.000Z",
      observer: { outcome: { schema_version: 1 as const, status: "exhausted" as const }, open_regions: [] },
      on_explanation_progress: (next: ExplanationDelivery | undefined, _bytes: number, spent: number) => {
        progress = next; work += spent;
      } };
    for (; calls < 20; calls++) {
      const before = work;
      const allowance = calls < 2 ? 3 : 100;
      const input = { ...base, budget: { ...base.budget, work_units: allowance, finalization_reserve: allowance },
        remaining_reserve: allowance, explanation_progress: progress };
      page = page === undefined ? projectAcceptingIndex({ ...input, query_id: "query", snapshot_id: SNAPSHOT_ID, result_version: "v1" })
        : continueAcceptingIndex(page, input);
      expect(work - before).toBeLessThanOrEqual(allowance);
      expect(InformationIndexSchema.safeParse(page).success).toBe(true);
      if (calls === 0) {
        expect(page.entries.map(entry => entry.object_id)).toEqual(["member"]);
        expect(page.entries[0]?.explanation_ids).toEqual([]);
        expect(page.explanations).toEqual([]);
        expect(progress).toBeDefined();
        expect(page.continuation).not.toBeNull();
      }
      if (page.explanations?.length === 3) break;
    }
    expect(calls).toBeGreaterThan(0);
    expect(page?.explanations?.map(node => node.derivation_id).sort()).toEqual(["leaf", "middle", "root"]);
    expect(page?.product_updates?.some(update => update.update_kind === "payload")).toBe(true);
  });

  it("defers an affordable proof copy after preparation and refuses a copy below the fresh allowance", () => {
    const state = productKey("member");
    const snapshot: FieldSnapshot = { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID,
      values: [{ schema_version: 1, state, milligrades: 1000, accepting: true }],
      seeds: [{ schema_version: 1, state, milligrades: 1000 }], retained_transitions: [], facets: [] };
    const leaf = DerivationSchema.parse({ schema_version: 1, derivation_id: "leaf", kind: "leaf", children: [],
      observation_ids: ["member"], leaf_ids: ["member"], source_revisions: [] });
    const middle = DerivationSchema.parse({ ...leaf, derivation_id: "middle", kind: "serial", children: ["leaf"] });
    const root = DerivationSchema.parse({ ...leaf, derivation_id: "root", kind: "serial", children: ["middle"] });
    const forest = new Map([leaf, middle, root].map(node => [node.derivation_id, node]));
    const materialize = vi.spyOn(ExplanationDelivery.prototype, "explanations", "get");
    let cursor: ExplanationDelivery | undefined, spent = 0;
    const make = (allowance: number, selected: FieldSnapshot = snapshot, previous?: InformationIndex,
      retained?: ExplanationDelivery) => {
      const input = { snapshot: selected, view: defaultView(), budget: defaultBudget({ work_units: allowance,
        finalization_reserve: allowance, min_envelope: 0, page_budget: 1 }), remaining_reserve: allowance,
      grounding_complete: true, derivation_forest: forest, explanation_progress: retained,
      output_derivation_roots: new Map([[productStateNodeId(state), ["root"]]]),
      claims: new Map([[productStateNodeId(state), "supported" as const]]),
      observer: { outcome: { schema_version: 1 as const, status: "exhausted" as const }, open_regions: [] },
      expires_at: "2099-01-01T00:00:00.000Z",
      on_explanation_progress: (next: ExplanationDelivery | undefined, _bytes: number, work: number) => { cursor = next; spent += work; } };
      return previous === undefined ? projectAcceptingIndex({ ...input, query_id: "query", snapshot_id: SNAPSHOT_ID,
        result_version: "v1" }) : continueAcceptingIndex(previous, input);
    };
    try {
      const preparing = make(16);
      expect(preparing.entries[0]).toMatchObject({ object_id: "member", claim: "supported", explanation_ids: [] });
      expect(preparing.completeness.payload).toBe("partial");
      expect(preparing.continuation).not.toBeNull();
      const completed = cursor;
      expect(completed?.advance(0, 0).complete).toBe(true);
      expect(spent).toBeLessThanOrEqual(16);
      expect(materialize).not.toHaveBeenCalled();
      const beforeCopy = spent;
      const delivered = make(16, snapshot, preparing, completed);
      expect(delivered.entries).toEqual([]);
      expect(delivered.product_updates?.some(update => update.update_kind === "payload")).toBe(true);
      expect(delivered.explanations?.map(node => node.derivation_id).sort()).toEqual(["leaf", "middle", "root"]);
      expect(delivered.completeness.payload).toBe("complete");
      expect(delivered.continuation).toBeNull();
      expect(spent - beforeCopy).toBeGreaterThanOrEqual(7);
      expect(spent - beforeCopy).toBeLessThanOrEqual(16);
      expect(materialize).toHaveBeenCalledOnce();
      materialize.mockClear();
      const beforeRefusal = spent;
      const small = make(6, snapshot, undefined, completed);
      expect(small.entries).toHaveLength(1);
      expect(small.entries[0]).toMatchObject({ object_id: "member", claim: "supported", explanation_ids: [] });
      expect(small.completeness.payload).toBe("resource_rejected");
      expect(small.continuation).toBeNull();
      expect(small.explanations).toEqual([]);
      expect(cursor).toBeUndefined();
      expect(spent - beforeRefusal).toBeLessThanOrEqual(6);
      expect(materialize).not.toHaveBeenCalled();
      const second = productKey("second");
      const pending = make(6, { ...snapshot,
        values: [...snapshot.values, { schema_version: 1, state: second, milligrades: 1000, accepting: true }],
        seeds: [...snapshot.seeds, { schema_version: 1, state: second, milligrades: 1000 }] }, undefined, completed);
      expect(pending.entries.map(entry => entry.object_id)).toEqual(["member"]);
      expect(pending.completeness).toMatchObject({ logical_index: "resource_rejected", payload: "resource_rejected",
        transport: "resource_rejected" });
      expect(pending.continuation).toBeNull();
      expect(materialize).not.toHaveBeenCalled();
      const before = spent;
      const enough = make(100);
      expect(enough.explanations?.map(node => node.derivation_id).sort()).toEqual(["leaf", "middle", "root"]);
      expect(enough.entries[0]?.explanation_ids).toEqual(["root"]);
      expect(spent - before).toBeGreaterThanOrEqual(7);
      expect(spent - before).toBeLessThanOrEqual(100);
      expect(materialize).toHaveBeenCalledOnce();
    } finally { materialize.mockRestore(); }
  });

  it("does not inspect a retained forest when a page has no explanation roots", () => {
    const forest = new Map<string, ReturnType<typeof DerivationSchema.parse>>();
    const get = vi.spyOn(forest, "get");
    const progress = vi.fn();
    const snapshot: FieldSnapshot = { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID,
      values: [], seeds: [], retained_transitions: [], facets: [] };
    const result = projectAcceptingIndex({ snapshot, query_id: "query", snapshot_id: SNAPSHOT_ID, result_version: "v1",
      view: defaultView(), budget: defaultBudget({ work_units: 1, finalization_reserve: 1, min_envelope: 0, page_budget: 0 }),
      derivation_forest: forest, output_derivation_roots: new Map(), on_explanation_progress: progress,
      grounding_complete: true, expires_at: "2099-01-01T00:00:00.000Z" });
    expect(result.entries).toEqual([]);
    expect(result.explanations).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });

  it("indexes a supplied incomplete forest across small continuations before admitting its seed", () => {
    const state = productKey("member");
    const snapshot: FieldSnapshot = { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID,
      values: [{ schema_version: 1, state, milligrades: 1000, accepting: true }],
      seeds: [{ schema_version: 1, state, milligrades: 1000 }], retained_transitions: [], facets: [] };
    const leaf = (id: string) => DerivationSchema.parse({ schema_version: 1, derivation_id: id, kind: "leaf", children: [],
      observation_ids: [id === "root" ? "member" : id], leaf_ids: [id], source_revisions: [], association_milligrades: 1000 });
    const derivations = [leaf("unrelated-1"), leaf("unrelated-2"), leaf("unrelated-3"), leaf("root")];
    let owner: SeedProofIndex | undefined, continuation: InformationIndex["continuation"] = null, admitted = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      let spent = 0;
      const index = projectAcceptingIndex({ snapshot, query_id: "query", snapshot_id: SNAPSHOT_ID, result_version: "v1",
        view: defaultView(), budget: defaultBudget({ work_units: 2, finalization_reserve: 2, min_envelope: 0, page_budget: 1 }),
        derivations: structuredClone(derivations), explanation_source_revision: "forest:1",
        output_derivations: { [productStateNodeId(state)]: ["root"] }, grounding_complete: false,
        seed_proof_index: owner, on_seed_proof_index: (next, _bytes, work) => { owner = next; spent += work; },
        prior_continuation: continuation, expires_at: "2099-01-01T00:00:00.000Z" });
      expect(spent).toBeLessThanOrEqual(2);
      if (attempt === 0) expect(index.entries).toEqual([]);
      if (index.entries.some(entry => entry.object_id === "member")) { admitted = true; break; }
      expect(index.continuation).not.toBeNull();
      continuation = index.continuation;
    }
    expect(admitted).toBe(true);
  });

  it("rechecks witness feasibility when an unissued page is retried at a smaller width", () => {
    const state = productKey("member");
    const snapshot: FieldSnapshot = { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID,
      values: [{ schema_version: 1, state, milligrades: 1000, accepting: true }],
      seeds: [{ schema_version: 1, state, milligrades: 1000 }], retained_transitions: [], facets: [] };
    const root = DerivationSchema.parse({ schema_version: 1, derivation_id: "root", kind: "leaf", children: [],
      observation_ids: ["member"], leaf_ids: ["member"], source_revisions: [], witness_id: "costly" });
    let progress: ExplanationDelivery | undefined;
    const base = { snapshot, query_id: "query", snapshot_id: SNAPSHOT_ID, result_version: "v1", view: defaultView(),
      grounding_complete: true, derivation_forest: new Map([["root", root]]),
      output_derivation_roots: new Map([[productStateNodeId(state), ["root"]]]),
      support: [{ schema_version: 1 as const, proposition_id: "member", claim: "unknown" as const,
        witnesses: [{ schema_version: 1 as const, witness_id: "costly", premises: [], cost: 2, complete: true }] }],
      expires_at: "2099-01-01T00:00:00.000Z",
      on_explanation_progress: (next: ExplanationDelivery | undefined) => { progress = next; } };
    const wide = projectAcceptingIndex({ ...base, budget: defaultBudget({ page_budget: 3 }), remaining_reserve: 2 });
    expect(wide.entries[0]?.explanation_ids).toEqual([]);
    expect(progress).toBeDefined();
    const narrow = projectAcceptingIndex({ ...base, explanation_progress: progress,
      budget: defaultBudget({ page_budget: 1 }), remaining_reserve: 100 });
    expect(narrow.entries[0]?.explanation_ids).toEqual([]);
    expect(narrow.explanations).toEqual([]);
    expect(narrow.completeness.payload).toBe("partial");
  });

  it("discards a pending proof when the same root has a different witness or forest", () => {
    const state = productKey("member");
    const snapshot: FieldSnapshot = { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID,
      values: [{ schema_version: 1, state, milligrades: 1000, accepting: true }],
      seeds: [{ schema_version: 1, state, milligrades: 1000 }], retained_transitions: [], facets: [] };
    const leaf = (leafId: string) => DerivationSchema.parse({ schema_version: 1, derivation_id: "root", kind: "leaf", children: [],
      observation_ids: ["member"], leaf_ids: [leafId], source_revisions: [], witness_id: "witness" });
    const witness = (cost: number) => [{ schema_version: 1 as const, proposition_id: "member", claim: "unknown" as const,
      witnesses: [{ schema_version: 1 as const, witness_id: "witness", premises: [], cost, complete: true }] }];
    const oldForest = new Map([["root", leaf("old")]]), support = witness(1);
    let cursor: ExplanationDelivery | undefined, released = 0;
    const base = { snapshot, query_id: "query", snapshot_id: SNAPSHOT_ID, result_version: "v1", view: defaultView(),
      budget: defaultBudget({ page_budget: 1 }), grounding_complete: true,
      output_derivation_roots: new Map([[productStateNodeId(state), ["root"]]]),
      expires_at: "2099-01-01T00:00:00.000Z", on_explanation_progress: (next: ExplanationDelivery | undefined, bytes: number) => {
        cursor = next; if (bytes < 0) released -= bytes;
      } };
    projectAcceptingIndex({ ...base, derivation_forest: oldForest, support, explanation_source_revision: "source:1", remaining_reserve: 2 });
    const prior = cursor!;
    expect(prior).toBeDefined();
    const changedWitness = projectAcceptingIndex({ ...base, derivation_forest: oldForest, support: witness(2),
      explanation_source_revision: "source:2", explanation_progress: prior, remaining_reserve: 100 });
    expect(released).toBeGreaterThanOrEqual(prior.retainedBytes);
    expect(changedWitness.entries[0]?.explanation_ids).toEqual([]);
    expect(changedWitness.explanations).toEqual([]);
    expect(changedWitness.completeness.payload).toBe("partial");

    cursor = undefined; released = 0;
    projectAcceptingIndex({ ...base, derivation_forest: oldForest, support, explanation_source_revision: "source:1", remaining_reserve: 2 });
    const nextPrior = cursor!;
    const changedForest = projectAcceptingIndex({ ...base, derivation_forest: new Map([["root", leaf("new")]]), support,
      explanation_source_revision: "source:2", explanation_progress: nextPrior, remaining_reserve: 100 });
    expect(released).toBeGreaterThanOrEqual(nextPrior.retainedBytes);
    expect(changedForest.explanations?.[0]?.leaf_ids).toEqual(["new"]);
    expect(nextPrior.completedWork).toBe(prior.completedWork);
  });

  it("includes grounding progress in a supplied source revision", () => {
    const state = productKey("member"), other = productKey("other");
    const snapshot: FieldSnapshot = { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID,
      values: [{ schema_version: 1, state, milligrades: 1000, accepting: true }],
      seeds: [{ schema_version: 1, state, milligrades: 1000 }, { schema_version: 1, state: other, milligrades: 1000 }],
      retained_transitions: [], facets: [] };
    const derivations: readonly ReturnType<typeof DerivationSchema.parse>[] = [], roots = {};
    const ground = groundedOutputDerivations({ seeds: snapshot.seeds, transitions: snapshot.retained_transitions,
      derivations, transition_derivations: roots, allowance: 1 });
    const previous = new ExplanationDelivery([], ground.progress.forest, undefined, 1, 100,
      JSON.stringify(["inputs:1", ground.progress.input_digest, ground.progress.completed_work]));
    let progressWork = ground.progress.completed_work, released = 0;
    projectAcceptingIndex({ snapshot, query_id: "query", snapshot_id: SNAPSHOT_ID, result_version: "v1",
      view: defaultView(), budget: defaultBudget({ work_units: 3, finalization_reserve: 3, min_envelope: 0, page_budget: 1 }),
      transition_derivations: roots, grounding_progress: ground.progress, grounding_input_revision: ground.progress.input_digest,
      grounding_derivations: derivations, explanation_progress: previous, explanation_source_revision: "inputs:1",
      on_grounding_progress: next => { progressWork = next.completed_work; },
      on_explanation_progress: (_next, bytes) => { if (bytes < 0) released -= bytes; },
      expires_at: "2099-01-01T00:00:00.000Z" });
    expect(progressWork).toBeGreaterThan(ground.progress.completed_work);
    expect(released).toBeGreaterThanOrEqual(previous.retainedBytes);
  });

  it.each(["missing", "cycle", "oversized"] as const)("terminates a %s proof with an explicit refusal", kind => {
    const state = productKey("member");
    const snapshot: FieldSnapshot = { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID,
      values: [{ schema_version: 1, state, milligrades: 1000, accepting: true }],
      seeds: [{ schema_version: 1, state, milligrades: 1000 }], retained_transitions: [], facets: [] };
    const leaf = (id: string) => DerivationSchema.parse({ schema_version: 1, derivation_id: id, kind: "leaf", children: [],
      observation_ids: [id], leaf_ids: [id], source_revisions: [] });
    const leaves = Array.from({ length: 1_000 }, (_, index) => leaf(`leaf-${index}`));
    const root = kind === "missing" ? leaf("root") : DerivationSchema.parse({ ...leaf("root"), kind: "serial",
      children: kind === "cycle" ? ["root"] : leaves.map(row => row.derivation_id) });
    const forest = new Map((kind === "missing" ? [] : [root, ...(kind === "oversized" ? leaves : [])])
      .map(node => [node.derivation_id, node]));
    let cursor: ExplanationDelivery | undefined, admitted = 0;
    const index = projectAcceptingIndex({ snapshot, query_id: "query", snapshot_id: SNAPSHOT_ID, result_version: "v1",
      view: defaultView(), budget: defaultBudget({ work_units: 10_000, finalization_reserve: 10_000,
        page_budget: 1, memory_bytes: 2_000_000, min_envelope: 0 }), remaining_reserve: 10_000, grounding_complete: true,
      derivation_forest: forest, output_derivation_roots: new Map([[productStateNodeId(state), ["root"]]]),
      expires_at: "2099-01-01T00:00:00.000Z", observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] },
      on_explanation_progress: (next, _bytes, _work, allocated) => { cursor = next; admitted += allocated ?? 0; } });
    expect(index.entries).toEqual([]);
    expect(index.continuation).toBeNull();
    expect(index.completeness.logical_index).toBe(kind === "oversized" ? "resource_rejected" : "invalidated");
    expect(cursor).toBeUndefined();
    expect(admitted).toBeGreaterThan(0);
  });
});
