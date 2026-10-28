import { describe, expect, it } from "vitest";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { type Derivation, type SeedActivation, type Transition } from "@do-soul/alaya-protocol";
import { createConditionalField } from "../../../../recall/conditional-field/engine/field-engine.js";
import { groundedOutputDerivations, type GroundingProgress } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { ruleDerivationIdentity, seedDerivationIdentity } from "../../../../recall/conditional-field/engine/path-derivation.js";
import { transitionKey } from "../../../../recall/conditional-field/engine/path-composition.js";
import { traceDerivationForest } from "../../../../recall/conditional-field/engine/derivation-provenance.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const state = (id: string) => productKey(id);
const seed = { schema_version: 1 as const, state: state("s"), milligrades: 1000 };
const edge = (from: string, to: string, relation_kind: string, strength_milligrades: number): Transition => ({
  schema_version: 1, from: state(from), to: state(to), relation_kind, strength_milligrades,
  applicable: true, validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" }
});
const sToB = edge("s", "b", "direct", 900);
const sToC = edge("s", "c", "detour-start", 500);
const cToB = edge("c", "b", "detour-end", 900);
const seedId = seedDerivationIdentity(productStateNodeId(seed.state));
const ruleId = (row: Transition) => ruleDerivationIdentity(transitionKey(row));

function paths(root: string, rows: readonly Derivation[]): readonly string[] {
  const forest = new Map(rows.map((row) => [row.derivation_id, row]));
  const traced = traceDerivationForest({ forest, roots: [root] });
  expect(traced.complete).toBe(true);
  const expand = (id: string): readonly (readonly string[])[] => {
    const node = forest.get(id);
    if (node === undefined) throw new Error(`missing derivation ${id}`);
    if (node.kind === "leaf") return [[id]];
    if (node.kind === "or") return node.children.flatMap(expand);
    if (node.kind === "serial") {
      const [left, right] = node.children;
      if (left === undefined || right === undefined) throw new Error("incomplete serial proof");
      return expand(left).flatMap((prefix) => expand(right).map((suffix) => [...prefix, ...suffix]));
    }
    throw new Error(`unexpected proof kind ${node.kind}`);
  };
  return expand(root).map((path) => path.join(" -> ")).sort();
}

const expected = (direct: Transition, start: Transition, end: Transition) => [
  [seedId, ruleId(direct)].join(" -> "),
  [seedId, ruleId(start), ruleId(end)].join(" -> ")
].sort();

function project(transitions: readonly Transition[], grounding: ReturnType<typeof groundedOutputDerivations>,
  seeds: readonly SeedActivation[] = [seed], expectedGrade = 900, finalizationReserve = 100,
  expectExplanation = true) {
  const field = createConditionalField({ interpretation: { schema_version: 1, query_id: "proof-paths",
    snapshot_id: SNAPSHOT_ID, status: "resolved", program: { schema_version: 1, kind: "epsilon" },
    view: defaultView(), holes: [], hypotheses: [] }, budget: defaultBudget(), seeds, transitions });
  if (field.binding.kind !== "bound") throw new Error("field binding rejected");
  const index = projectAcceptingIndex({ snapshot: field.binding.snapshot, query_id: field.query_id,
    snapshot_id: SNAPSHOT_ID, result_version: "v1", view: defaultView(),
    budget: defaultBudget({ finalization_reserve: finalizationReserve }),
    derivations: grounding.derivations, output_derivations: grounding.roots, grounding_complete: grounding.complete });
  const entry = index.entries.find((candidate) => candidate.object_id === "b");
  if (entry === undefined) throw new Error("destination not delivered");
  expect(entry.association_milligrades).toBe(expectedGrade);
  if (expectExplanation) expect(entry.explanation_ids).toHaveLength(1);
  return { entry, index };
}

describe("output proof completion after numeric settlement", () => {
  it("refuses a resumed proof whose retained parent rule is missing", () => {
    const input = { seeds: [seed], transitions: [sToB, sToC, cToB], derivations: [], transition_derivations: {} };
    let progress: GroundingProgress | undefined;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = groundedOutputDerivations({ ...input, progress, allowance: 1 });
      progress = result.progress;
      if (progress.proof_frame?.parent !== undefined) break;
    }
    expect(progress?.proof_frame?.parent).toBeDefined();
    if (progress === undefined) throw new Error("expected retained grounding progress");
    const damaged: GroundingProgress = { ...progress, incoming: new PersistentStringMap() };
    let failure: unknown;
    try { groundedOutputDerivations({ ...input, progress: damaged, allowance: 1 }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: "CoreError", code: "OBLIGATION_VIOLATION", message: "missing retained proof rule" });
  });

  it.each([
    [sToB, sToC, cToB],
    [cToB, sToC, sToB],
    [sToC, sToB, cToB]
  ])("delivers both independent direct and delayed paths regardless of transition order", (...transitions) => {
    const grounding = groundedOutputDerivations({ seeds: [seed], transitions, derivations: [],
      transition_derivations: {}, allowance: 1000 });
    expect(grounding.complete).toBe(true);
    const { entry, index } = project(transitions, grounding);
    expect(paths(entry.explanation_ids[0]!, index.explanations ?? [])).toEqual(expected(sToB, sToC, cToB));
  });

  it("projects the completed explanation through the index-owned grounding entry", () => {
    const transitions = [sToB, sToC, cToB];
    const field = createConditionalField({ interpretation: { schema_version: 1, query_id: "proof-paths",
      snapshot_id: SNAPSHOT_ID, status: "resolved", program: { schema_version: 1, kind: "epsilon" },
      view: defaultView(), holes: [], hypotheses: [] }, budget: defaultBudget(), seeds: [seed], transitions });
    if (field.binding.kind !== "bound") throw new Error("field binding rejected");
    expect(field.binding.snapshot.retained_transitions).toHaveLength(3);
    const index = projectAcceptingIndex({ snapshot: field.binding.snapshot, query_id: field.query_id,
      snapshot_id: SNAPSHOT_ID, result_version: "v1", view: defaultView(),
      budget: defaultBudget({ finalization_reserve: 1000 }), transition_derivations: {} });
    const entry = index.entries.find((candidate) => candidate.object_id === "b");
    if (entry === undefined) throw new Error("grounded destination not delivered");
    expect(entry.association_milligrades).toBe(900);
    expect(entry.explanation_ids).toHaveLength(1);
    expect(paths(entry.explanation_ids[0]!, index.explanations ?? [])).toEqual(expected(sToB, sToC, cToB));
  });

  it("retains equal-grade alternatives in either arrival order", () => {
    const equal = edge("s", "c", "detour-start", 900);
    for (const transitions of [[sToB, equal, cToB], [cToB, equal, sToB]]) {
      const grounding = groundedOutputDerivations({ seeds: [seed], transitions, derivations: [],
        transition_derivations: {}, allowance: 1000 });
      expect(grounding.complete).toBe(true);
      const { entry, index } = project(transitions, grounding);
      expect(paths(entry.explanation_ids[0]!, index.explanations ?? [])).toEqual(expected(sToB, equal, cToB));
    }
  });

  it("charges interrupted proof work and resumes before declaring completion", () => {
    const transitions = [sToB, sToC, cToB];
    const input = { seeds: [seed], transitions, derivations: [], transition_derivations: {} };
    let progress: GroundingProgress | undefined;
    let complete: ReturnType<typeof groundedOutputDerivations> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const next = groundedOutputDerivations({ ...input, allowance: 1, progress });
      expect(next.work).toBe(1);
      expect(next.progress.completed_work).toBe((progress?.completed_work ?? 0) + 1);
      if (next.complete) { complete = next; break; }
      progress = next.progress;
    }
    if (complete === undefined) throw new Error("bounded proof did not complete");
    const { entry, index } = project(transitions, complete);
    expect(paths(entry.explanation_ids[0]!, index.explanations ?? [])).toEqual(expected(sToB, sToC, cToB));
  });

  it("keeps an acyclic exit alternative when an upstream seeded component contains a cycle", () => {
    const direct = edge("s", "b", "direct", 900);
    const enter = edge("s", "x", "enter", 900);
    const forward = edge("x", "y", "forward", 900);
    const back = edge("y", "x", "back", 900);
    const exit = edge("y", "b", "exit", 900);
    const transitions = [direct, enter, forward, back, exit];
    const grounded = groundedOutputDerivations({ seeds: [seed], transitions, derivations: [],
      transition_derivations: {}, allowance: 1000 });
    expect(grounded.complete).toBe(true);
    const { entry, index } = project(transitions, grounded);
    expect(paths(entry.explanation_ids[0]!, index.explanations ?? [])).toEqual([
      [seedId, ruleId(direct)].join(" -> "),
      [seedId, ruleId(enter), ruleId(forward), ruleId(exit)].join(" -> ")
    ].sort());
  });

  it("resumes a cyclic entry and exit path with one charged unit per page", () => {
    const transitions = [edge("s", "b", "direct", 900), edge("s", "x", "enter", 900),
      edge("x", "y", "forward", 900), edge("y", "x", "back", 900), edge("y", "b", "exit", 900)];
    const input = { seeds: [seed], transitions, derivations: [], transition_derivations: {} };
    let progress: GroundingProgress | undefined;
    let completed: ReturnType<typeof groundedOutputDerivations> | undefined;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const result = groundedOutputDerivations({ ...input, progress, allowance: 1 });
      expect(result.work).toBe(1);
      expect(result.progress.completed_work).toBe((progress?.completed_work ?? 0) + 1);
      if (result.complete) { completed = result; break; }
      progress = result.progress;
    }
    if (completed === undefined) throw new Error("cyclic grounded output did not complete");
    const { entry, index } = project(transitions, completed);
    expect(paths(entry.explanation_ids[0]!, index.explanations ?? [])).toEqual([
      [seedId, ruleId(transitions[0]!)].join(" -> "),
      [seedId, ruleId(transitions[1]!), ruleId(transitions[2]!), ruleId(transitions[4]!)].join(" -> ")
    ].sort());
  });

  it("leaves proof completion open after memory refusal and retries without phantom allocation", () => {
    const transitions = [sToB, sToC, cToB];
    const input = { seeds: [seed], transitions, derivations: [], transition_derivations: {} };
    const full = groundedOutputDerivations({ ...input, allowance: 1000, memory_bytes: 100_000 });
    expect(full.complete).toBe(true);
    const limited = groundedOutputDerivations({ ...input, allowance: 1000,
      memory_bytes: full.progress.retained_bytes - 1 });
    expect(limited.complete).toBe(false);
    expect(limited.progress.proof_offset).toBeLessThan(limited.progress.settled.size);
    const field = createConditionalField({ interpretation: { schema_version: 1, query_id: "proof-paths",
      snapshot_id: SNAPSHOT_ID, status: "resolved", program: { schema_version: 1, kind: "epsilon" },
      view: defaultView(), holes: [], hypotheses: [] }, budget: defaultBudget(), seeds: [seed], transitions });
    if (field.binding.kind !== "bound") throw new Error("field binding rejected");
    const partialIndex = projectAcceptingIndex({ snapshot: field.binding.snapshot, query_id: field.query_id,
      snapshot_id: SNAPSHOT_ID, result_version: "v1", view: defaultView(),
      budget: defaultBudget({ finalization_reserve: 1000 }), transition_derivations: {},
      remaining_memory_bytes: full.progress.retained_bytes - 1,
      expires_at: "2099-01-01T00:00:00.000Z",
      observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] } });
    expect(partialIndex.completeness.logical_index).toBe("open");
    expect(partialIndex.completeness.pending_computation).toBe("open");
    expect(partialIndex.continuation).not.toBeNull();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = groundedOutputDerivations({ ...input, allowance: 1000, memory_bytes: 0,
        progress: limited.progress });
      expect(retry.complete).toBe(false);
      expect(retry.admitted_bytes).toBe(0);
      expect(retry.progress.retained_bytes).toBe(limited.progress.retained_bytes);
    }
    const resumed = groundedOutputDerivations({ ...input, allowance: 1000, progress: limited.progress,
      memory_bytes: 100_000 - limited.progress.retained_bytes });
    expect(resumed.complete).toBe(true);
    expect(resumed.progress.retained_bytes).toBe(full.progress.retained_bytes);
    const { entry, index } = project(transitions, resumed);
    expect(paths(entry.explanation_ids[0]!, index.explanations ?? [])).toEqual(expected(sToB, sToC, cToB));
  });

  it("keeps externally founded paths entering different vertices of a cyclic component", () => {
    const extraSeed = { schema_version: 1 as const, state: state("z"), milligrades: 700 };
    const enter = edge("s", "x", "enter-s", 900);
    const other = edge("z", "y", "enter-z", 700);
    const xy = edge("x", "y", "xy", 900);
    const yx = edge("y", "x", "yx", 900);
    const exit = edge("y", "b", "exit", 900);
    const transitions = [enter, other, xy, yx, exit];
    const grounded = groundedOutputDerivations({ seeds: [seed, extraSeed], transitions, derivations: [],
      transition_derivations: {}, allowance: 1000 });
    expect(grounded.complete).toBe(true);
    const root = grounded.roots[productStateNodeId(state("b"))]?.[0];
    if (root === undefined) throw new Error("missing cyclic exit proof");
    expect(paths(root, grounded.derivations)).toEqual([
      [seedId, ruleId(enter), ruleId(xy), ruleId(exit)].join(" -> "),
      [seedDerivationIdentity(productStateNodeId(extraSeed.state)), ruleId(other), ruleId(exit)].join(" -> ")
    ].sort());
  });

  it("delivers both strong-source routes despite a preassembled weaker seed premise", () => {
    const weakSeed = { schema_version: 1 as const, state: state("a"), milligrades: 500 };
    const direct = edge("s", "b", "direct-strong", 1000);
    const via = edge("s", "a", "via-strong", 900);
    const exit = edge("a", "b", "exit-strong", 900);
    const transitions = [direct, via, exit];
    const seeds = [seed, weakSeed];
    const result = groundedOutputDerivations({ seeds, transitions, derivations: [],
      transition_derivations: {}, allowance: 1000 });
    expect(result.complete).toBe(true);
    expect(result.progress.proof_needed).toBe(true);
    const { entry, index } = project(transitions, result, seeds, 1000);
    const expectedPaths = [
      [seedId, ruleId(direct)].join(" -> "),
      [seedId, ruleId(via), ruleId(exit)].join(" -> "),
      [seedDerivationIdentity(productStateNodeId(weakSeed.state)), ruleId(exit)].join(" -> ")
    ].sort();
    expect(paths(entry.explanation_ids[0]!, index.explanations ?? [])).toEqual(expectedPaths);
    const input = { seeds, transitions, derivations: [], transition_derivations: {} };
    let progress: GroundingProgress | undefined;
    let resumed: ReturnType<typeof groundedOutputDerivations> | undefined;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const page = groundedOutputDerivations({ ...input, allowance: 1, progress });
      expect(page.work).toBe(1);
      if (page.complete) { resumed = page; break; }
      progress = page.progress;
    }
    if (resumed === undefined) throw new Error("seeded alternative did not complete under narrow pages");
    const delivered = project(transitions, resumed, seeds, 1000);
    expect(paths(delivered.entry.explanation_ids[0]!, delivered.index.explanations ?? [])).toEqual(expectedPaths);
  });

  it("excludes repeated-product walks when two seeded vertices share a cycle", () => {
    const second = { schema_version: 1 as const, state: state("y"), milligrades: 500 };
    const first = { schema_version: 1 as const, state: state("x"), milligrades: 1000 };
    const xy = edge("x", "y", "xy", 900);
    const yx = edge("y", "x", "yx", 900);
    const transitions = [xy, yx];
    const seeds = [first, second];
    const result = groundedOutputDerivations({ seeds, transitions, derivations: [],
      transition_derivations: {}, allowance: 1000 });
    expect(result.complete).toBe(true);
    expect(result.progress.proof_needed).toBe(true);
    const root = result.roots[productStateNodeId(second.state)]?.[0];
    if (root === undefined) throw new Error("missing second-seed proof");
    expect(paths(root, result.derivations)).toEqual([
      seedDerivationIdentity(productStateNodeId(second.state)),
      [seedDerivationIdentity(productStateNodeId(first.state)), ruleId(xy)].join(" -> ")
    ].sort());
    const self = edge("s", "s", "self", 1000);
    const own = groundedOutputDerivations({ seeds: [seed], transitions: [self, sToB],
      derivations: [], transition_derivations: {}, allowance: 1000 });
    expect(own.complete).toBe(true);
    const ownRoot = own.roots[productStateNodeId(seed.state)]?.[0];
    if (ownRoot === undefined) throw new Error("missing seeded self proof");
    expect(paths(ownRoot, own.derivations)).toEqual([seedId]);
    const { entry, index } = project([self, sToB], own);
    expect(paths(entry.explanation_ids[0]!, index.explanations ?? [])).toEqual([
      [seedId, ruleId(sToB)].join(" -> ")
    ]);
  });

  it("reserves the retained active-map stack and resumes after a depth memory refusal", () => {
    const ids = Array.from({ length: 10 }, (_, index) => `n${index}`);
    const transitions = [sToB, edge("s", ids[0]!, "start", 500),
      ...ids.slice(1).map((id, index) => edge(ids[index]!, id, `link-${index}`, 500)),
      edge(ids[ids.length - 1]!, "b", "exit", 500)];
    const input = { seeds: [seed], transitions, derivations: [], transition_derivations: {} };
    let progress: GroundingProgress | undefined;
    let beforeProofBytes: number | undefined;
    let depthEight: GroundingProgress | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = groundedOutputDerivations({ ...input, progress, allowance: 1 });
      if (result.progress.proof_needed && result.progress.proof_frame === undefined &&
        result.progress.current === undefined && result.progress.queue.size === 0 && beforeProofBytes === undefined) {
        beforeProofBytes = result.progress.retained_bytes;
      }
      progress = result.progress;
      if (progress.proof_frame?.depth === 8) { depthEight = progress; break; }
    }
    if (progress === undefined || depthEight === undefined || beforeProofBytes === undefined) {
      throw new Error("retained proof stack did not reach depth eight");
    }
    const ninth = groundedOutputDerivations({ ...input, progress: depthEight, allowance: 1 });
    const top = ninth.progress.proof_frame;
    if (top?.depth !== 9) throw new Error("ninth retained proof frame was not opened");
    type Avl = { left?: Avl; right?: Avl };
    const nodes = new Set<Avl>();
    let frames = 0;
    for (let frame: typeof top | undefined = top; frame !== undefined; frame = frame.parent) {
      frames += 1;
      const walk = (node: Avl | undefined): void => {
        if (node === undefined || nodes.has(node)) return;
        nodes.add(node);
        walk(node.left);
        walk(node.right);
      };
      walk((frame.active as unknown as { root?: Avl }).root);
    }
    expect(frames).toBe(9);
    expect(nodes.size).toBeGreaterThan(9);
    expect(ninth.progress.retained_bytes - beforeProofBytes).toBeGreaterThanOrEqual(
      frames * 96 + nodes.size * 64);
    const blocked = groundedOutputDerivations({ ...input, progress: depthEight,
      allowance: 1, memory_bytes: ninth.admitted_bytes - 1 });
    expect(blocked.complete).toBe(false);
    expect(blocked.admitted_bytes).toBe(0);
    expect(blocked.progress.proof_frame?.depth).toBe(8);
    const resumed = groundedOutputDerivations({ ...input, progress: blocked.progress,
      allowance: 1, memory_bytes: ninth.admitted_bytes });
    expect(resumed.progress.proof_frame?.depth).toBe(9);
    expect(resumed.admitted_bytes).toBe(ninth.admitted_bytes);
    const completed = groundedOutputDerivations({ ...input, progress: resumed.progress, allowance: 1000 });
    expect(completed.complete).toBe(true);
    const limited = project(transitions, completed, [seed], 900, 100, false);
    expect(limited.entry.explanation_ids).toEqual([]);
    expect(limited.index.completeness).toMatchObject({ logical_index: "open", payload: "partial", pending_computation: "open" });
    const { entry, index } = project(transitions, completed, [seed], 900, 1000);
    expect(paths(entry.explanation_ids[0]!, index.explanations ?? [])).toEqual([
      [seedId, ruleId(sToB)].join(" -> "),
      [seedId, ...transitions.slice(1).map(ruleId)].join(" -> ")
    ].sort());
  });

  it("does not construct cyclic proof references or invent an unseeded witness", () => {
    const ab = edge("s", "b", "ab", 900);
    const ba = edge("b", "s", "ba", 900);
    const grounded = groundedOutputDerivations({ seeds: [seed], transitions: [ab, ba], derivations: [],
      transition_derivations: {}, allowance: 1000 });
    expect(grounded.complete).toBe(true);
    for (const roots of Object.values(grounded.roots)) for (const root of roots) {
      expect(traceDerivationForest({ forest: grounded.progress.forest, roots: [root] }).complete).toBe(true);
    }
    const unseeded = groundedOutputDerivations({ seeds: [], transitions: [ab, ba], derivations: [],
      transition_derivations: {}, allowance: 1000 });
    expect(unseeded.complete).toBe(true);
    expect(unseeded.roots).toEqual({});
  });
});
