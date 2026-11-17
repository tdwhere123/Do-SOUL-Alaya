import { describe, expect, it } from "vitest";
import { productEndpointId, type QueryProgram } from "@do-soul/alaya-protocol";
import { hyperedgeEffectSteps, type HyperedgeEffect } from "../../../../recall/conditional-field/engine/path-hyperedge.js";
import { PathEffectCursor, type PathComputationStep } from "../../../../recall/conditional-field/engine/path-effect-cursor.js";
import { compileProgramAutomaton } from "../../../../recall/conditional-field/engine/program-automaton.js";
import { seedActivationDerivationId } from "../../../../recall/conditional-field/engine/path-derivation.js";
import { forkSequenceReachOwner, readSequenceReach, sequenceReachAccountBytes, sequenceReachKey } from "../../../../recall/conditional-field/engine/sequence-reach.js";
import type { AdjacencyRow } from "../../../../recall/conditional-field/engine/path-matching.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { productKey } from "../reference/deployment.fixture.js";
import { hardIdentityCapContractId } from "../../../../recall/conditional-field/cap-contract.js";

const AS_OF = "2026-09-10T00:00:00.000Z";
const FROM = productKey("a", "h0", "unbound", "entry");
const EPSILON = { schema_version: 1, kind: "epsilon" } as const;
type Hyperedge = Extract<QueryProgram, { kind: "hyperedge" }>;

function hop(kind: string, source: string, target: string): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source, target_variable: target,
    facet_mode: "same_path", threshold_milligrades: 0,
    guard: { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" } };
}

function edge(predicate: string, source: string, target: string, id: string): AdjacencyRow {
  return { assertionId: id, sourceObjectId: source, targetObjectId: target, predicate, source_revision: "rev",
    validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" } };
}

function input(ids = ["a", "m", "y"]) {
  return { asOf: AS_OF, query_id: "hyperedge-resumption", liveStates: [FROM], overlay: {},
    sourceFacts: new Map(ids.map((object_id) => [object_id, { object_id, source_revision: "rev" }])) };
}

function sequenceProgram() {
  const inner: Hyperedge = { schema_version: 1, kind: "hyperedge", join: "or", premises: [hop("p", "x", "m")] };
  const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps: [inner, hop("q", "m", "y")] };
  const program: Hyperedge = { schema_version: 1, kind: "hyperedge", join: "and", premises: [sequence] };
  return { program, sequence, compiledPremises: new Map([[sequence, compileProgramAutomaton(sequence)]]) };
}

function drain(cursor: PathEffectCursor, allowance: number, memory = 1_000_000) {
  let offset = 0;
  const effects: HyperedgeEffect[] = [];
  for (let page = 0; page < 10_000; page += 1) {
    const result = cursor.advance(offset, allowance, memory);
    effects.push(...result.effects);
    offset = result.offset;
    expect(result.status).not.toBe("memory_exhausted");
    if (result.status === "complete") return { effects, work: result.completed_work, bytes: result.retained_bytes };
  }
  throw new Error("Hyperedge cursor did not complete");
}

function leaves(effects: readonly HyperedgeEffect[]): string[] {
  return [...new Set(effects.flatMap((effect) => effect.derivations?.flatMap((row) => row.leaf_ids) ?? []))].sort();
}

function expectSequenceProof(effects: readonly HyperedgeEffect[], starts: readonly string[], assertions: readonly string[]) {
  // Compiled premises run relative to identity seeds at their automaton starts.
  // These are proof dependencies as well as the declared relation assertions.
  const seedIds = starts.map((program_state) => seedActivationDerivationId({ state: { ...FROM, program_state }, cap_contract_id: hardIdentityCapContractId() }));
  const expectedLeaves = [...assertions, ...seedIds].sort();
  const expectedNodes = [
    ...assertions.map((id) => ({ derivation_id: `leaf:${id}`, observation_ids: [id], leaf_ids: [id] })),
    ...seedIds.map((id) => ({ derivation_id: id, observation_ids: ["a"], leaf_ids: [id] }))
  ].map((node) => ({ ...node, schema_version: 1, kind: "leaf", provenance_layout: "local_leaves.v1",
    children: [], source_revisions: ["rev"], association_milligrades: 1000 }))
    .sort((left, right) => left.derivation_id.localeCompare(right.derivation_id));
  expect(leaves(effects)).toEqual(expectedLeaves);
  const completed = effects.filter((effect) => effect.hyperedge !== undefined);
  expect(completed).toHaveLength(1);
  for (const effect of completed) {
    expect(effect.derivation).toBeDefined();
    expect(effect.derivations?.filter((row) => row.kind === "leaf")
      .sort((left, right) => left.derivation_id.localeCompare(right.derivation_id))).toEqual(expectedNodes);
    const forest = new Map(effect.derivations?.map((row) => [row.derivation_id, row]));
    const pending = [effect.derivation!.derivation_id];
    const visited = new Set<string>();
    const reachableLeaves = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = forest.get(id);
      expect(node, `Missing proof dependency ${id}`).toBeDefined();
      for (const leaf of node!.leaf_ids) reachableLeaves.add(leaf);
      pending.push(...node!.children);
    }
    expect([...reachableLeaves].sort()).toEqual(expectedLeaves);
  }
}

function completions(effects: readonly HyperedgeEffect[]) {
  return effects.flatMap((effect) => effect.hyperedge === undefined ? [] : [{
    target: productEndpointId(effect.hyperedge.to), program: effect.hyperedge.to.program_state,
    join: effect.hyperedge.join, grade: effect.hyperedge.strength_milligrades
  }]);
}

describe("hyperedge completion and resumable sequence steps", () => {
  it.each(["and", "or"] as const)("preserves %s completion reservations, deduplication and destination order", (join) => {
    const program: Hyperedge = { schema_version: 1, kind: "hyperedge", join, premises: [EPSILON, EPSILON] };
    const makeSteps = () => hyperedgeEffectSteps([], program, { ...input(), toProgramStates: ["left", "right"] });
    const steps = [...makeSteps()];
    const keyBytes = Buffer.byteLength(JSON.stringify(["h0", "unbound", "as_of", "a", { kind: "query_snapshot", as_of: AS_OF }, hardIdentityCapContractId()]), "utf8");
    const roleWork = [96 + keyBytes, 328, 0, 8];
    const completionWork = join === "and" ? [0, 2464, 72, 72, 8, 8] : [2256, 72, 8];
    expect(steps.filter((step) => step.kind === "work").map((step) => step.retained_bytes ?? 0))
      .toEqual([0, ...roleWork, ...roleWork, ...completionWork]);
    const effects = steps.flatMap((step) => step.kind === "effect" ? [step.effect] : []);
    expect(completions(effects)).toEqual([
      { target: "a", program: "left", join, grade: 1000 },
      { target: "a", program: "right", join, grade: 1000 }
    ]);
    expect(leaves(effects)).toEqual(["a:a:epsilon"]);
    expect(effects[0]?.derivations).toBe(effects[1]?.derivations);
    expect(effects[0]?.hyperedge?.from).toBe(FROM);

    const prefixBytes = [0, ...roleWork, ...roleWork, ...(join === "and" ? [0] : [])].reduce((sum, bytes) => sum + bytes, 0);
    const cursor = new PathEffectCursor(makeSteps, 0);
    const blocked = cursor.advance(0, 10_000, prefixBytes);
    expect(blocked.status).toBe("memory_exhausted");
    expect(blocked.effects).toEqual([]);
    expect(blocked.retained_bytes).toBe(prefixBytes);
    const repeated = cursor.advance(0, 10_000, prefixBytes);
    expect(repeated.completed_work).toBe(blocked.completed_work);
    expect(repeated.retained_bytes).toBe(blocked.retained_bytes);
    expect(repeated.admitted_bytes).toBe(0);
    expect(drain(cursor, 1)).toEqual(drain(new PathEffectCursor(makeSteps, 0), 10_000));
  });

  it("resumes nested hyperedges before physical hops without reordering demands or proofs", () => {
    const { program, sequence, compiledPremises } = sequenceProgram();
    const rows = [edge("p", "a", "m", "p-old"), edge("q", "m", "y", "q-old")];
    const makeSteps = () => hyperedgeEffectSteps(rows, program, {
      ...input(), compiledPremises, physicalKindSet: new Set(["p", "q"]), reachOwner: {}
    });
    const expected = drain(new PathEffectCursor(makeSteps, 0), 10_000);
    expect(expected.effects.flatMap((effect) => effect.relation_demand === undefined ? [] : [effect.relation_demand]))
      .toEqual([{ subject: "a", predicate: "p" }, { subject: "m", predicate: "q" }]);
    expect(completions(expected.effects)).toEqual([{ target: "y", program: "accepting", join: "and", grade: 1000 }]);
    expectSequenceProof(expected.effects, compiledPremises.get(sequence)!.start, ["p-old", "q-old"]);
    expect(drain(new PathEffectCursor(makeSteps, 0), 1)).toEqual(expected);
    expect(drain(new PathEffectCursor(makeSteps, 0), 7)).toEqual(expected);
  });

  it("populates a cold sequence from retained rows even when only its last hop is new", () => {
    const { program, sequence, compiledPremises } = sequenceProgram();
    const rows = [edge("p", "a", "m", "p-old"), edge("q", "m", "y", "q-new")];
    const owner = {};
    const cursor = new PathEffectCursor(() => hyperedgeEffectSteps(rows, program, {
      ...input(), compiledPremises, reachOwner: owner, coldPrograms: new Set(), joinRows: [rows[1]!]
    }), 0);
    const result = drain(cursor, 1);
    expect(completions(result.effects)).toEqual([{ target: "y", program: "accepting", join: "and", grade: 1000 }]);
    expectSequenceProof(result.effects, compiledPremises.get(sequence)!.start, ["p-old", "q-new"]);
    expect(sequenceReachAccountBytes(owner)).toBeGreaterThan(64);
  });

  it("does not publish a sequence frontier when cancelled at its identity reservation", () => {
    const { program, sequence, compiledPremises } = sequenceProgram();
    const owner = {};
    const steps = hyperedgeEffectSteps([edge("p", "a", "m", "p-old")], program, {
      ...input(), compiledPremises, reachOwner: owner
    });
    let reservation: PathComputationStep | undefined;
    for (const step of steps) {
      if (step.kind === "work" && step.retained_bytes === 64) { reservation = step; break; }
    }
    // Breaking closes the generator while the reservation is still unadmitted.
    expect(reservation).toEqual({ kind: "work", retained_bytes: 64 });
    expect(readSequenceReach(owner, sequenceReachKey(sequence, productStateNodeId(FROM)))).toBeUndefined();
    expect(sequenceReachAccountBytes(owner)).toBe(0);
    expect(steps.next().done).toBe(true);
  });

  it("promotes a missing revision in a fork without mutating the retained sibling frontier", () => {
    const { program, sequence, compiledPremises } = sequenceProgram();
    const owner = {};
    // A plain sequence retains unresolved physical hops; nested hyperedges report their own miss.
    const plain: QueryProgram = { schema_version: 1, kind: "sequence", steps: [hop("p", "x", "m"), hop("q", "m", "y")] };
    const outer: Hyperedge = { ...program, premises: [plain] };
    compiledPremises.set(plain, compileProgramAutomaton(plain));
    const rows = [edge("p", "a", "m", "p-old"), edge("q", "m", "y", "q-old")];
    const initial = drain(new PathEffectCursor(() => hyperedgeEffectSteps(rows, outer, {
      ...input(["a", "y"]), compiledPremises, reachOwner: owner
    }), 0), 1);
    expect(initial.effects.some((effect) => effect.missing_target_revision === true)).toBe(true);
    expect(completions(initial.effects)).toEqual([]);
    const key = sequenceReachKey(plain, productStateNodeId(FROM));
    const prior = readSequenceReach(owner, key);
    expect(prior?.unresolved).toHaveLength(1);
    const fork = forkSequenceReachOwner(owner);
    const result = drain(new PathEffectCursor(() => hyperedgeEffectSteps(rows, outer, {
      ...input(), compiledPremises, reachOwner: fork, joinRows: [], promotedIds: new Set()
    }), 0), 1);
    expect(completions(result.effects)).toEqual([{ target: "y", program: "accepting", join: "and", grade: 1000 }]);
    expectSequenceProof(result.effects, compiledPremises.get(plain)!.start, ["p-old", "q-old"]);
    expect(readSequenceReach(fork, key)?.unresolved).toEqual([]);
    expect(readSequenceReach(owner, key)).toBe(prior);
    expect(prior?.unresolved).toHaveLength(1);
    expect(readSequenceReach(owner, sequenceReachKey(sequence, productStateNodeId(FROM)))).toBeUndefined();
  });
});
