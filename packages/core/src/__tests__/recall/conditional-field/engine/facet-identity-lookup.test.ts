import { describe, expect, it } from "vitest";
import type { FacetVector, ObserverPage, QueryProgram } from "@do-soul/alaya-protocol";
import { type AdjacencyRow } from "../../../../recall/conditional-field/engine/path-composition-adjacency.js";
import { seedProgramStates } from "../../../../recall/conditional-field/engine/path-composition-seed.js";
import { composedFacetPathId, facetPathId, indexFacetsByIdentity, PathFacetLookup } from "../../../../recall/conditional-field/engine/path-composition-facet.js";
import { facetIdentityIndexOf } from "../../../../recall/conditional-field/engine/field-retention-index.js";
import {
  applyObserverPage,
  createConditionalField,
  withdrawDerivationLeaves,
  type FieldEngineState
} from "../../../../recall/conditional-field/engine/field-engine.js";
import type { BoundSourceFacts } from "../../../../recall/conditional-field/engine/binding-environment.js";
import { resumePathEffects } from "../../../../recall/runtime/pending-path-effects.js";
import { defaultBudget, productKey } from "../reference/deployment.fixture.js";
import { AS_OF, OPEN_GUARD, edge, facts, project, query } from "./relation-grounding.fixture.js";

const hop = (kind: string, source: string, target: string): QueryProgram => ({ schema_version: 1, kind: "relation",
  relation_kind: kind, source_variable: source, target_variable: target, facet_mode: "same_path",
  threshold_milligrades: 0, guard: OPEN_GUARD });
const PROGRAM: QueryProgram = { schema_version: 1, kind: "sequence", steps: [hop("r", "x", "m"), hop("s", "m", "y")] };
const KINDS = ["r", "s"];
const olds = (count: number) => Array.from({ length: count }, (_, index) => `old${String(index)}`);
const ALL_FACTS = (count: number) => facts([...olds(count), "mid", "mid2", "end"]);

function seededAt(objects: readonly string[]): FieldEngineState {
  const starts = seedProgramStates(PROGRAM);
  return createConditionalField({
    interpretation: query(PROGRAM),
    budget: defaultBudget({ work_units: 4_000_000, memory_bytes: 64_000_000, finalization_reserve: 0, min_envelope: 0 }),
    seeds: objects.flatMap((object) => starts.map((programState) => ({
      schema_version: 1, milligrades: 1000, state: productKey(object, "h0", "unbound", programState)
    })))
  });
}

function pageFor(state: FieldEngineState): ObserverPage {
  return { schema_version: 1, query_id: state.query_id, snapshot_id: state.snapshot_id,
    cursor: { schema_version: 1, cursor_id: "adjacency", region_id: "adjacency", query_id: state.query_id,
      snapshot_id: state.snapshot_id, position: null, committed_through: null },
    observations: [], outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] };
}

/** Runs one relation page the way the observe session starts it: the field's own identity index is handed over. */
function pass(
  state: FieldEngineState,
  rows: readonly AdjacencyRow[],
  sourceFacts: ReadonlyMap<string, BoundSourceFacts>,
  joinRows?: readonly AdjacencyRow[],
  allowance = 4_000_000
): FieldEngineState {
  let current = resumePathEffects({ ...state, remaining_exploration: allowance,
    remaining_memory_bytes: Math.max(state.remaining_memory_bytes, 32_000_000), memory_exhausted: false,
    retention_rejected: undefined,
    pending_path_effects: { offset: 0, retained_bytes: 0, page: pageFor(state), input: { rows, options: {
      interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts, physicalKinds: KINDS,
      liveStates: state.seen_identities, facets: state.facets, facetIndex: facetIdentityIndexOf(state),
      discoveries: state.discoveries, bindingContexts: state.binding_contexts,
      ...(joinRows === undefined ? {} : { joinRows })
    } } } });
  for (let guard = 0; current.pending_path_effects !== undefined && guard < 10_000; guard += 1) {
    current = resumePathEffects({ ...current, remaining_exploration: allowance, memory_exhausted: false,
      retention_rejected: undefined });
  }
  return current;
}

/** Work a later single-edge page spends when `count` unrelated states and facets are already retained. */
function laterPageWork(count: number): number {
  const hops = olds(count).map((object, index) => edge("r", object, `mid${String(index)}`, `a${String(index)}`));
  const known = facts([...olds(count), ...hops.map((row) => row.targetObjectId), "end"]);
  const first = pass(seededAt(olds(count)), hops, known, hops);
  expect(first.pending_path_effects).toBeUndefined();
  expect(first.facets.length).toBe(count);
  const row = edge("s", "mid0", "end", "b1");
  const second = pass(first, [...hops, row], known, [row], 4_000_000);
  expect(second.pending_path_effects).toBeUndefined();
  return 4_000_000 - second.remaining_exploration;
}

const byIdentity = (facets: Iterable<FacetVector>) => {
  const groups = new Map<string, string[]>();
  for (const facet of facets) {
    const identity = facet.path_id.split(":")[0]!;
    groups.set(identity, [...groups.get(identity) ?? [], facet.path_id]);
  }
  return groups;
};

describe("facet lookup by source state identity", () => {
  it("looks up a state's facets without touching unrelated retained facets", () => {
    const programState = seedProgramStates(PROGRAM)[0]!;
    const start = productKey("m", "h0", "unbound", programState);
    const mine = [composedFacetPathId(start, "route-a"), facetPathId(start), composedFacetPathId(start, "route-b")];
    const lookupFor = (unrelated: number) => {
      const facets: FacetVector[] = [
        ...Array.from({ length: unrelated }, (_, index) => ({ schema_version: 1 as const,
          path_id: composedFacetPathId(productKey(`other${String(index)}`, "h0", "unbound", programState), "route"),
          coordinates: [999] })),
        ...mine.map((path_id, index) => ({ schema_version: 1 as const, path_id, coordinates: [index] }))];
      const lookup = new PathFacetLookup(facets, indexFacetsByIdentity(facets));
      const steps = lookup.forState(start);
      let work = 0, next = steps.next();
      while (next.done !== true) { work += 1; next = steps.next(); }
      return { work, paths: [...next.value].map((facet) => facet.path_id) };
    };
    const few = lookupFor(1), many = lookupFor(500);
    expect(many.paths).toEqual(mine);
    expect(few.paths).toEqual(mine);
    expect(many.work).toBe(few.work);
    expect(many.work).toBe(1);
  });

  it("charges a later page a fixed amount per unrelated retained state and facet", () => {
    const small = laterPageWork(2), large = laterPageWork(402);
    // Walking and joining one retained state costs 14 units; scanning its facet and prior state added 3 more.
    expect((large - small) / 400).toBeLessThanOrEqual(14.5);
  });

  it("keeps the identity index equal to the retained facets, grouped by their state identity", () => {
    const hops = [edge("r", "old0", "mid", "a1"), edge("r", "old1", "mid2", "a2")];
    const sourceFacts = ALL_FACTS(3);
    const state = pass(seededAt(olds(3)), hops, sourceFacts, hops);
    const index = facetIdentityIndexOf(state)!;
    expect(index).toBeDefined();
    const expected = byIdentity(state.facets);
    expect(expected.size).toBe(2);
    for (const [identity, paths] of expected) expect([...index.get(identity)!].map((facet) => facet.path_id)).toEqual(paths);
    expect(index.get(facetPathId(productKey("nowhere", "h0", "unbound", seedProgramStates(PROGRAM)[0]!)))).toBeUndefined();
  });
});

describe("facet lookup under interruption, forks and withdrawal", () => {
  const rows = [edge("r", "old0", "mid", "a1"), edge("r", "old1", "mid2", "a2"), edge("s", "mid", "end", "b1")];

  function incremental(sourceFacts: ReadonlyMap<string, BoundSourceFacts>, allowance?: number): FieldEngineState {
    let state = pass(seededAt(olds(40)), [], sourceFacts, undefined, allowance);
    let population: AdjacencyRow[] = [];
    for (const page of [[rows[0]!], [rows[1]!, rows[2]!]]) {
      population = population.concat(page);
      state = pass(state, population, sourceFacts, population.length === page.length ? undefined : page, allowance);
    }
    return state;
  }

  it("resumes an interrupted pass to the same field as an uninterrupted run, with a consistent index", () => {
    const sourceFacts = ALL_FACTS(40);
    const whole = incremental(sourceFacts);
    const sliced = incremental(sourceFacts, 90);
    expect(sliced.pending_path_effects).toBeUndefined();
    expect(project(sliced)).toEqual(project(whole));
    expect(project(whole).facets.length).toBeGreaterThanOrEqual(3);
    const index = facetIdentityIndexOf(sliced)!;
    for (const [identity, paths] of byIdentity(sliced.facets)) {
      expect([...index.get(identity)!].map((facet) => facet.path_id)).toEqual(paths);
    }
  });

  it("keeps sibling fields independent after a shared retained prefix", () => {
    const sourceFacts = ALL_FACTS(40);
    const base = pass(seededAt(olds(40)), [], sourceFacts);
    const left = pass(base, [rows[0]!], sourceFacts, [rows[0]!]);
    const right = pass(base, [rows[1]!], sourceFacts, [rows[1]!]);
    expect(base.facets.length).toBe(0);
    expect(left.facets.length).toBe(1);
    expect(right.facets.length).toBe(1);
    expect([...facetIdentityIndexOf(left)!.get(facetPathId(left.seen_identities.at(-1)!)) ?? []]).toHaveLength(1);
    const leftThenS = pass(left, [rows[0]!, rows[2]!], sourceFacts, [rows[2]!]);
    const rightThenS = pass(right, [rows[1]!, edge("s", "mid2", "end", "b2")], sourceFacts, [edge("s", "mid2", "end", "b2")]);
    const fresh = pass(pass(pass(seededAt(olds(40)), [], sourceFacts), [rows[1]!], sourceFacts, [rows[1]!]),
      [rows[1]!, edge("s", "mid2", "end", "b2")], sourceFacts, [edge("s", "mid2", "end", "b2")]);
    expect(project(rightThenS)).toEqual(project(fresh));
    expect(project(leftThenS).facets).not.toEqual(project(rightThenS).facets);
    // The sibling pass left the shared base untouched.
    expect(base.facets.length).toBe(0);
    expect(facetIdentityIndexOf(base)?.size ?? 0).toBe(0);
  });

  it("matches a fresh rebuild after a withdrawal removes facets and the same hop is derived again", () => {
    const sourceFacts = ALL_FACTS(40);
    const first = pass(seededAt(olds(40)), [], sourceFacts);
    const withBoth = pass(pass(first, [rows[0]!], sourceFacts, [rows[0]!]), [rows[0]!, rows[2]!], sourceFacts, [rows[2]!]);
    const withdrawn = withdrawDerivationLeaves(withBoth, "a1");
    expect(withdrawn.facets.length).toBeLessThan(withBoth.facets.length);
    const survivingIndex = facetIdentityIndexOf(withdrawn)!;
    for (const [identity, paths] of byIdentity(withdrawn.facets)) {
      expect([...survivingIndex.get(identity)!].map((facet) => facet.path_id)).toEqual(paths);
    }
    expect(survivingIndex.size).toBe(byIdentity(withdrawn.facets).size);
    const again = edge("r", "old0", "mid", "a1-again");
    const rederived = pass(pass(withdrawn, [again], sourceFacts, [again]), [again, rows[2]!], sourceFacts, [rows[2]!]);
    const fresh = pass(pass(pass(seededAt(olds(40)), [], sourceFacts), [again], sourceFacts, [again]),
      [again, rows[2]!], sourceFacts, [rows[2]!]);
    expect(project(rederived)).toEqual(project(fresh));
  });
});

describe("facet retention under a memory quota", () => {
  const facet: FacetVector = { schema_version: 1, path_id: composedFacetPathId(
    productKey("a", "h0", "unbound", seedProgramStates(PROGRAM)[0]!), "route"), coordinates: [500] };
  // Payload bytes plus a new identity bucket: 96 + 2 * 64 identity characters + 16 for the entry.
  const NEEDED = Buffer.byteLength(JSON.stringify(facet), "utf8") + 96 + 128 + 16;
  const absorbWith = (memory: number) => {
    const base = seededAt([]);
    const state = { ...base, remaining_memory_bytes: memory };
    return applyObserverPage(state, { page: pageFor(state), effects: [{ observation_id: "facet-only", facet }] });
  };

  it("retains the facet together with its identity entry when both fit", () => {
    const absorbed = absorbWith(NEEDED);
    expect(absorbed.memory_exhausted).toBe(false);
    expect(absorbed.facets.length).toBe(1);
    expect(absorbed.remaining_memory_bytes).toBe(0);
    expect(facetIdentityIndexOf(absorbed)!.get(facetPathId(productKey("a", "h0", "unbound", seedProgramStates(PROGRAM)[0]!)))).toHaveLength(1);
  });

  it("retains neither when only the facet payload fits", () => {
    const absorbed = absorbWith(NEEDED - 1);
    expect(absorbed.memory_exhausted).toBe(true);
    expect(absorbed.facets.length).toBe(0);
    expect(absorbed.remaining_memory_bytes).toBe(NEEDED - 1);
    expect(facetIdentityIndexOf(absorbed)?.size ?? 0).toBe(0);
  });
});
