import { describe, expect, it } from "vitest";
import {
  MonotonicHypergraphMaintainer,
  repairBottleneckHypergraph,
  solveBottleneckHypergraph,
  type BottleneckHyperedge,
  type BottleneckHypergraphInput,
  type BottleneckWitness
} from "../index.js";

describe("bottleneck hypergraph algorithms A, B, and C", () => {
  it("matches Knaster-Tarski least fixed point across 220 randomized cyclic hypergraphs", () => {
    const rng = mulberry32(20261120);
    for (let trial = 0; trial < 220; trial += 1) {
      const top = trial % 7 === 0 ? 5000 : 1 + Math.floor(rng() * 6);
      const nodeCount = 2 + Math.floor(rng() * 7);
      const nodeIds = Array.from({ length: nodeCount }, (_, i) => `z${i}`);
      const prior = randomHypergraph(nodeIds, top, rng, trial % 5 === 0);
      const next = randomRevision(prior, rng);

      const expectedPrior = knasterTarskiReference(prior);
      const expectedNext = knasterTarskiReference(next);

      const solvedPrior = solveBottleneckHypergraph(prior);
      expectMapsEqual(solvedPrior.values, expectedPrior);
      assertAcyclicWitnesses(solvedPrior.values, solvedPrior.witnesses, prior);

      const incremental = solveIncrementalViaAlgorithmB(prior, rng);
      expectMapsEqual(incremental.values, expectedPrior);
      assertAcyclicWitnesses(incremental.values, incremental.witnesses, prior);

      const repaired = repairBottleneckHypergraph({
        prior: { ...prior, values: solvedPrior.values },
        next
      });
      expectMapsEqual(repaired.values, expectedNext);
      assertAcyclicWitnesses(repaired.values, repaired.witnesses, next);
      expectMapsEqual(repaired.meetValues, knasterTarskiReference(meetGraph(prior, next)));
    }
  });

  it("distinguishes reachable grade 0 from unreachable bottom across A, B, and C", () => {
    const nodeIds = ["seed0", "viaId", "viaAnd", "viaOr", "unseeded", "cycleA", "cycleB"];
    const seeds = new Map([["seed0", 0]]);
    const edges: BottleneckHyperedge[] = [
      { id: "id0", kind: "identity", from: "seed0", to: "viaId" },
      { id: "and0", kind: "and", from: ["seed0", "viaId"], to: "viaAnd", strength: 10 },
      { id: "or0", kind: "or", from: ["unseeded", "viaAnd"], to: "viaOr", strength: 5 },
      { id: "ca", kind: "unary", from: "cycleA", to: "cycleB", strength: 10 },
      { id: "cb", kind: "unary", from: "cycleB", to: "cycleA", strength: 10 }
    ];
    const input: BottleneckHypergraphInput = { nodeIds, seeds, edges, bottom: 0, top: 10 };
    const expected = new Map([["seed0", 0], ["viaId", 0], ["viaAnd", 0], ["viaOr", 0]]);

    const solved = solveBottleneckHypergraph(input);
    expectMapsEqual(solved.values, expected);

    const maintainer = new MonotonicHypergraphMaintainer({ nodeIds, bottom: 0, top: 10 });
    maintainer.addEdges(edges);
    maintainer.raiseSeeds(seeds);
    expectMapsEqual(maintainer.values, expected);

    const repaired = repairBottleneckHypergraph({
      prior: { ...input, values: solved.values },
      next: { nodeIds, seeds: new Map(), edges, bottom: 0, top: 10 }
    });
    expectMapsEqual(repaired.values, new Map());
    expect(repaired.certifiedCore.size).toBe(0);
  });

  it("handles Appendix B Counterexample 1 and SCC core vs cycle eviction accurately", () => {
    // Appendix B #1: seed b(z)=3 overrides 0-premise axiom cap 1 even from lower bound a0(z)=1.
    const ce1 = new MonotonicHypergraphMaintainer({
      nodeIds: ["z"],
      bottom: 0,
      top: 5,
      initialValues: new Map([["z", 1]]),
      seeds: new Map([["z", 3]]),
      edges: [{ id: "ax", kind: "and", from: [], to: "z", strength: 1 }]
    });
    expect(ce1.values.get("z")).toBe(3);

    // Cycle a <-> b: deleting sole seed leaves K empty and evicts both nodes.
    const nodeIds = ["a", "b", "c"];
    const cycleEdges: BottleneckHyperedge[] = [
      { id: "ab", kind: "unary", from: "a", to: "b", strength: 9 },
      { id: "ba", kind: "unary", from: "b", to: "a", strength: 9 }
    ];
    const priorCycle: BottleneckHypergraphInput = {
      nodeIds,
      seeds: new Map([["a", 10]]),
      edges: cycleEdges,
      bottom: 0,
      top: 10
    };
    const cycleRepaired = repairBottleneckHypergraph({
      prior: { ...priorCycle, values: solveBottleneckHypergraph(priorCycle).values },
      next: { nodeIds, seeds: new Map(), edges: cycleEdges, bottom: 0, top: 10 }
    });
    expect(cycleRepaired.certifiedCore.size).toBe(0);
    expect(cycleRepaired.values.size).toBe(0);
    expect(cycleRepaired.recomputedNodes).toEqual(new Set(["a", "b"]));

    // Multi-node SCC {a, b, c} where c retains surviving seed 9 after s -> a downgrades:
    // K certifies {s, c, b, a} without full-SCC wipeout!
    const sccNodes = ["s", "a", "b", "c"];
    const sccPrior: BottleneckHypergraphInput = {
      nodeIds: sccNodes,
      seeds: new Map([["s", 10], ["c", 9]]),
      edges: [
        { id: "sa", kind: "unary", from: "s", to: "a", strength: 9 },
        { id: "ab", kind: "unary", from: "a", to: "b", strength: 9 },
        { id: "bc", kind: "unary", from: "b", to: "c", strength: 9 },
        { id: "cb", kind: "unary", from: "c", to: "b", strength: 9 },
        { id: "ba", kind: "unary", from: "b", to: "a", strength: 9 }
      ],
      bottom: 0,
      top: 10
    };
    const sccNext: BottleneckHypergraphInput = {
      ...sccPrior,
      edges: [
        { id: "sa", kind: "unary", from: "s", to: "a", strength: 2 },
        ...sccPrior.edges.slice(1)
      ]
    };
    const sccRepaired = repairBottleneckHypergraph({
      prior: { ...sccPrior, values: solveBottleneckHypergraph(sccPrior).values },
      next: sccNext
    });
    expect(sccRepaired.certifiedCore).toEqual(new Set(["s", "a", "b", "c"]));
    expect(sccRepaired.recomputedNodes.size).toBe(0);
    expectMapsEqual(sccRepaired.values, new Map([["s", 10], ["a", 9], ["b", 9], ["c", 9]]));
    assertAcyclicWitnesses(sccRepaired.values, sccRepaired.witnesses, sccNext);
  });

  it("certifies monotonic barrier frontier upper bounds u_t and open-graph bounds u_t v P at every step", () => {
    const nodeIds = ["s1", "s2", "a", "b", "c", "unreach1", "unreach2"];
    const edges: BottleneckHyperedge[] = [
      { id: "e1", kind: "unary", from: "s1", to: "a", strength: 8 },
      { id: "e2", kind: "and", from: ["a", "s2"], to: "b", strength: 6 },
      { id: "e3", kind: "or", from: ["b", "unreach1"], to: "c", strength: 4 },
      { id: "u1", kind: "unary", from: "unreach1", to: "unreach2", strength: 9 },
      { id: "u2", kind: "unary", from: "unreach2", to: "unreach1", strength: 9 }
    ];
    const base: BottleneckHypergraphInput = {
      nodeIds,
      seeds: new Map([["s1", 9], ["s2", 7]]),
      edges,
      bottom: 0,
      top: 10
    };
    const exact = solveBottleneckHypergraph(base);
    const pendingCap = 5;
    const extended = solveBottleneckHypergraph({
      ...base,
      seeds: new Map([...base.seeds, ["unreach1", pendingCap], ["c", pendingCap]]),
      edges: [...edges, { id: "ext", kind: "unary", from: "s1", to: "a", strength: pendingCap }]
    });

    let prevUpper: ReadonlyMap<string, number> | undefined;
    for (let step = 0; step <= exact.settledCount; step += 1) {
      const barrier = solveBottleneckHypergraph({ ...base, maxSettledSteps: step });
      const upper = barrier.frontierUpperBound;
      const openUpper = barrier.openExtensionUpperBound(pendingCap);
      for (const id of nodeIds) {
        const star = exact.values.get(id) ?? -1;
        const ut = upper.get(id) ?? -1;
        expect(ut).toBeGreaterThanOrEqual(star);
        if (prevUpper !== undefined) {
          expect(ut).toBeLessThanOrEqual(prevUpper.get(id) ?? -1);
        }
        const extStar = extended.values.get(id) ?? -1;
        const openUt = openUpper.get(id) ?? -1;
        expect(openUt).toBeGreaterThanOrEqual(extStar);
      }
      expect(upper.has("unreach1")).toBe(false);
      expect(upper.has("unreach2")).toBe(false);
      prevUpper = upper;
    }
    expectMapsEqual(prevUpper!, exact.values);
  });

  it("maintains k=32 tied premises across d=5 grades in <= d*k premise inspections (Algorithm B)", () => {
    const k = 32;
    const d = 5;
    const premises = Array.from({ length: k }, (_, i) => `p${i}`);
    const nodeIds = [...premises, "head"];
    const initialSeeds = new Map(premises.map((p) => [p, 1]));
    const maintainer = new MonotonicHypergraphMaintainer({
      nodeIds,
      bottom: 0,
      top: 10,
      seeds: initialSeeds,
      edges: [{ id: "joint", kind: "and", from: premises, to: "head", strength: 10 }]
    });
    expect(maintainer.values.get("head")).toBe(1);

    for (let grade = 2; grade <= d; grade += 1) {
      for (let i = 0; i < k - 1; i += 1) {
        maintainer.raiseSeed(premises[i]!, grade);
        expect(maintainer.values.get("head")).toBe(grade - 1);
      }
      maintainer.raiseSeed(premises[k - 1]!, grade);
      expect(maintainer.values.get("head")).toBe(grade);
    }

    expect(maintainer.stats.edgeRescans).toBeLessThanOrEqual(d);
    expect(maintainer.stats.premiseInspections).toBeLessThanOrEqual(d * k);
    expect(maintainer.stats.watcherRemovals).toBe((d - 1) * k);
  });

  it("avoids delimiter collision in rule signatures between ['a','b'] and ['a\\0b']", () => {
    const nodeIds = ["a", "b", "a\0b", "out"];
    const prior: BottleneckHypergraphInput = {
      nodeIds,
      seeds: new Map([["a", 5], ["b", 5], ["a\0b", 0]]),
      edges: [{ kind: "and", from: ["a", "b"], to: "out", strength: 5 }],
      bottom: 0,
      top: 5
    };
    const next: BottleneckHypergraphInput = {
      ...prior,
      edges: [{ kind: "and", from: ["a\0b"], to: "out", strength: 5 }]
    };
    const repaired = repairBottleneckHypergraph({ prior, next });
    expect(repaired.values.get("out")).toBe(0);
    expect(repaired.certifiedCore.has("out")).toBe(false);
    expectMapsEqual(repaired.values, solveBottleneckHypergraph(next).values);
  });

  it("avoids synthetic rule ID collisions with literal 'sub#0:a' and 'orig:0' in local A solve", () => {
    const nodeIds = ["k", "x", "y", "z"];
    const prior: BottleneckHypergraphInput = {
      nodeIds,
      seeds: new Map([["k", 10], ["x", 8]]),
      edges: [
        { id: "a", kind: "and", from: ["k", "y"], to: "z", strength: 10 },
        { id: "sub#0:a", kind: "unary", from: "x", to: "y", strength: 8 },
        { id: "orig:0", kind: "unary", from: "y", to: "z", strength: 3 }
      ],
      bottom: 0,
      top: 10
    };
    const next: BottleneckHypergraphInput = {
      ...prior,
      seeds: new Map([["k", 10], ["x", 5]])
    };
    const repaired = repairBottleneckHypergraph({ prior, next });
    expectMapsEqual(repaired.values, new Map([["k", 10], ["x", 5], ["y", 5], ["z", 5]]));
    assertAcyclicWitnesses(repaired.values, repaired.witnesses, next);
    expect(repaired.witnesses.get("z")).toEqual({ kind: "rule", ruleId: "a", grade: 5, premises: ["k", "y"] });
  });

  it("handles large integer grades >= 2**31 without Int32 wraparound across A, B, and C", () => {
    const big = 2 ** 31;
    const huge = 2 ** 40 + 7;
    const nodeIds = ["s", "a", "b"];
    const prior: BottleneckHypergraphInput = {
      nodeIds,
      seeds: new Map([["s", huge]]),
      edges: [
        { id: "sa", kind: "unary", from: "s", to: "a", strength: big },
        { id: "ab", kind: "unary", from: "a", to: "b", strength: huge }
      ],
      bottom: 0,
      top: huge
    };
    const solved = solveBottleneckHypergraph(prior);
    expectMapsEqual(solved.values, new Map([["s", huge], ["a", big], ["b", big]]));

    const maintainer = new MonotonicHypergraphMaintainer({
      nodeIds,
      bottom: 0,
      top: huge,
      seeds: prior.seeds,
      edges: prior.edges
    });
    expectMapsEqual(maintainer.values, solved.values);

    const next: BottleneckHypergraphInput = {
      ...prior,
      edges: [
        { id: "sa", kind: "unary", from: "s", to: "a", strength: big - 1 },
        { id: "ab", kind: "unary", from: "a", to: "b", strength: huge }
      ]
    };
    const repaired = repairBottleneckHypergraph({ prior, next });
    expectMapsEqual(repaired.values, new Map([["s", huge], ["a", big - 1], ["b", big - 1]]));
  });

  it("keeps structurally distinct rules sharing the same user id across A, B, and C", () => {
    const nodeIds = ["s", "a", "b"];
    const edges: BottleneckHyperedge[] = [
      { id: "shared", kind: "unary", from: "s", to: "a", strength: 2 },
      { id: "shared", kind: "unary", from: "s", to: "b", strength: 5 }
    ];
    const input: BottleneckHypergraphInput = { nodeIds, seeds: new Map([["s", 5]]), edges, bottom: 0, top: 5 };
    const expected = new Map([["s", 5], ["a", 2], ["b", 5]]);

    expectMapsEqual(solveBottleneckHypergraph(input).values, expected);

    const maintainer = new MonotonicHypergraphMaintainer({
      nodeIds,
      bottom: 0,
      top: 5,
      seeds: input.seeds,
      edges
    });
    expectMapsEqual(maintainer.values, expected);

    const repaired = repairBottleneckHypergraph({
      prior: { nodeIds, seeds: new Map([["s", 5]]), edges: [edges[0]!], bottom: 0, top: 5 },
      next: input
    });
    expectMapsEqual(repaired.values, expected);
  });

  it("ignores prior.maxSettledSteps when recomputing omitted prior.values in repair", () => {
    const nodeIds = ["s", "a", "b"];
    const prior: BottleneckHypergraphInput = {
      nodeIds,
      seeds: new Map([["s", 8]]),
      edges: [
        { id: "sa", kind: "unary", from: "s", to: "a", strength: 8 },
        { id: "ab", kind: "unary", from: "a", to: "b", strength: 6 }
      ],
      bottom: 0,
      top: 10,
      maxSettledSteps: 0
    };
    const next: BottleneckHypergraphInput = {
      nodeIds,
      seeds: new Map([["s", 8]]),
      edges: [{ id: "sa", kind: "unary", from: "s", to: "a", strength: 8 }],
      bottom: 0,
      top: 10
    };
    const repaired = repairBottleneckHypergraph({ prior, next });
    expectMapsEqual(repaired.values, new Map([["s", 8], ["a", 8]]));
    expect(repaired.certifiedCore).toEqual(new Set(["s", "a"]));
  });

  it("pushes each node once during heap initialization even with 5000 increasing axioms (n=1, r=5000, top=10000)", () => {
    const edges: BottleneckHyperedge[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `ax${i}`,
      kind: "and",
      from: [],
      to: "z",
      strength: i + 1
    }));
    const solved = solveBottleneckHypergraph({
      nodeIds: ["z"],
      seeds: new Map([["z", 0]]),
      edges,
      bottom: 0,
      top: 10_000
    });
    expect(solved.values.get("z")).toBe(5000);
    expect(solved.initialQueuePushes).toBe(1);
  });

  it("validates explicit prior.values fixed point and recomputes partial maxSettledSteps prior", () => {
    const nodeIds = ["s", "a", "b"];
    const priorBase: BottleneckHypergraphInput = {
      nodeIds,
      seeds: new Map([["s", 8]]),
      edges: [
        { id: "sa", kind: "unary", from: "s", to: "a", strength: 8 },
        { id: "ab", kind: "unary", from: "a", to: "b", strength: 6 }
      ],
      bottom: 0,
      top: 10
    };
    const next: BottleneckHypergraphInput = {
      nodeIds,
      seeds: new Map([["s", 8]]),
      edges: [{ id: "sa", kind: "unary", from: "s", to: "a", strength: 8 }],
      bottom: 0,
      top: 10
    };

    const partial = solveBottleneckHypergraph({ ...priorBase, maxSettledSteps: 1 });
    expect(partial.complete).toBe(false);
    expect(partial.values.has("b")).toBe(false);

    // Explicit non-fixed-point prior.values without maxSettledSteps throws.
    expect(() => repairBottleneckHypergraph({
      prior: { ...priorBase, values: partial.values },
      next
    })).toThrow("bottleneck hypergraph repair requires prior values to be the least fixed point");

    // Unfounded self-cycle a -> a @1 with no seeds (nuPhi != muPhi) throws RangeError.
    expect(() => repairBottleneckHypergraph({
      prior: {
        nodeIds: ["a"],
        seeds: new Map(),
        edges: [{ id: "self", kind: "unary", from: "a", to: "a", strength: 1 }],
        bottom: 0,
        top: 5,
        values: new Map([["a", 1]])
      },
      next: { nodeIds: ["a"], seeds: new Map(), edges: [], bottom: 0, top: 5 }
    })).toThrow(RangeError);

    // Ghost key outside prior.nodeIds throws RangeError.
    expect(() => repairBottleneckHypergraph({
      prior: {
        nodeIds: ["a"],
        seeds: new Map(),
        edges: [],
        bottom: 0,
        top: 5,
        values: new Map([["ghost", 1]])
      },
      next: { nodeIds: ["a"], seeds: new Map(), edges: [], bottom: 0, top: 5 }
    })).toThrow(RangeError);

    // maxSettledSteps: 0 with empty explicit prior.values on seeded graph recomputes full muPhi cleanly.
    const recomputedZero = repairBottleneckHypergraph({
      prior: { ...priorBase, maxSettledSteps: 0, values: new Map() },
      next
    });
    expectMapsEqual(recomputedZero.values, new Map([["s", 8], ["a", 8]]));
    expect(recomputedZero.changedNodes).toEqual(new Set(["b"]));

    // Partial prior with maxSettledSteps: 1 recomputes complete prior fixed point cleanly.
    const repaired = repairBottleneckHypergraph({
      prior: { ...priorBase, maxSettledSteps: 1, values: partial.values },
      next
    });
    expectMapsEqual(repaired.values, new Map([["s", 8], ["a", 8]]));
    expect(repaired.certifiedCore).toEqual(new Set(["s", "a"]));
  });

  it("builds initial heap bottom-up in O(n) comparisons on ascending grades 0..4999", () => {
    const n = 5000;
    const nodeIds = Array.from({ length: n }, (_, i) => `n${i}`);
    const seeds = new Map(nodeIds.map((id, i) => [id, i]));
    const solved = solveBottleneckHypergraph({
      nodeIds,
      seeds,
      edges: [],
      bottom: 0,
      top: 5000,
      maxSettledSteps: 0
    });
    expect(solved.initialQueuePushes).toBe(n);
    expect(solved.initialHeapComparisons).toBeLessThan(2 * n);
    expect(solved.horizon).toBe(4999);
  });
});

function solveIncrementalViaAlgorithmB(
  input: BottleneckHypergraphInput,
  rng: () => number
): MonotonicHypergraphMaintainer {
  const maintainer = new MonotonicHypergraphMaintainer({
    nodeIds: input.nodeIds,
    bottom: 0,
    top: input.top
  });
  const ops: Array<() => void> = [];
  for (const [id, grade] of input.seeds) {
    ops.push(() => maintainer.raiseSeed(id, grade));
  }
  for (const edge of input.edges) {
    ops.push(() => maintainer.addEdge(edge));
  }
  for (let i = ops.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [ops[i], ops[j]] = [ops[j]!, ops[i]!];
  }
  for (const op of ops) op();
  return maintainer;
}

function knasterTarskiReference(input: BottleneckHypergraphInput): Map<string, number> {
  const nodeSet = new Set(input.nodeIds);
  const current = new Map<string, number>();
  for (const [id, raw] of input.seeds) {
    if (!nodeSet.has(id)) continue;
    const g = Math.max(0, Math.min(input.top, Math.trunc(raw)));
    const prev = current.get(id);
    if (prev === undefined || g > prev) current.set(id, g);
  }
  const legal = input.edges.filter((edge) => {
    if (!nodeSet.has(edge.to)) return false;
    const ps = edge.kind === "and" || edge.kind === "or" ? edge.from : [edge.from];
    return ps.every((p) => nodeSet.has(p));
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of legal) {
      const cap = edge.kind === "identity"
        ? input.top
        : Math.max(0, Math.min(input.top, Math.trunc(edge.strength)));
      let out: number | undefined;
      if (edge.kind === "unary" || edge.kind === "identity") {
        const v = current.get(edge.from);
        if (v !== undefined) out = Math.min(cap, v);
      } else if (edge.kind === "and") {
        if (edge.from.length === 0) {
          out = cap;
        } else if (edge.from.every((p) => current.has(p))) {
          let minP = cap;
          for (const p of edge.from) minP = Math.min(minP, current.get(p)!);
          out = minP;
        }
      } else {
        for (const p of edge.from) {
          const v = current.get(p);
          if (v !== undefined) {
            const candidate = Math.min(cap, v);
            out = out === undefined ? candidate : Math.max(out, candidate);
          }
        }
      }
      if (out !== undefined) {
        const prev = current.get(edge.to);
        if (prev === undefined || out > prev) {
          current.set(edge.to, out);
          changed = true;
        }
      }
    }
  }
  return current;
}

function meetGraph(prior: BottleneckHypergraphInput, next: BottleneckHypergraphInput): BottleneckHypergraphInput {
  const nextIds = new Set(next.nodeIds);
  const seeds = new Map<string, number>();
  for (const [id, pVal] of prior.seeds) {
    const nVal = next.seeds.get(id);
    if (nVal !== undefined && nextIds.has(id)) {
      seeds.set(id, Math.min(pVal, nVal));
    }
  }
  const sig = (e: BottleneckHyperedge): string => {
    const ps = e.kind === "and" || e.kind === "or" ? [...new Set(e.from)].sort() : [e.from];
    return JSON.stringify([e.kind, e.to, ps]);
  };
  const cap = (e: BottleneckHyperedge): number => e.kind === "identity" ? prior.top : e.strength;
  const pGroups = new Map<string, BottleneckHyperedge[]>();
  const nGroups = new Map<string, BottleneckHyperedge[]>();
  const usedP = new Set<BottleneckHyperedge>();
  const usedN = new Set<BottleneckHyperedge>();
  for (const e of prior.edges) if (e.id !== undefined) {
    const k = JSON.stringify([e.id, sig(e)]);
    pGroups.set(k, [...(pGroups.get(k) ?? []), e]);
  }
  for (const e of next.edges) if (e.id !== undefined) {
    const k = JSON.stringify([e.id, sig(e)]);
    nGroups.set(k, [...(nGroups.get(k) ?? []), e]);
  }
  const edges: BottleneckHyperedge[] = [];
  for (const [k, nList] of nGroups) {
    const pList = pGroups.get(k) ?? [];
    pList.sort((a, b) => cap(b) - cap(a));
    nList.sort((a, b) => cap(b) - cap(a));
    for (let i = 0; i < Math.min(pList.length, nList.length); i += 1) {
      usedP.add(pList[i]!);
      usedN.add(nList[i]!);
      const ne = nList[i]!;
      edges.push(ne.kind === "identity" ? ne : { ...ne, strength: Math.min(cap(pList[i]!), cap(ne)) });
    }
  }
  const remP = new Map<string, BottleneckHyperedge[]>();
  const remN = new Map<string, BottleneckHyperedge[]>();
  for (const pe of prior.edges) if (!usedP.has(pe)) {
    const k = sig(pe);
    remP.set(k, [...(remP.get(k) ?? []), pe]);
  }
  for (const ne of next.edges) if (!usedN.has(ne)) {
    const k = sig(ne);
    remN.set(k, [...(remN.get(k) ?? []), ne]);
  }
  for (const [k, nList] of remN) {
    const pList = remP.get(k) ?? [];
    pList.sort((a, b) => cap(b) - cap(a));
    nList.sort((a, b) => cap(b) - cap(a));
    for (let i = 0; i < Math.min(pList.length, nList.length); i += 1) {
      const ne = nList[i]!;
      edges.push(ne.kind === "identity" ? ne : { ...ne, strength: Math.min(cap(pList[i]!), cap(ne)) });
    }
  }
  return { nodeIds: prior.nodeIds, seeds, edges, bottom: 0, top: prior.top };
}

function assertAcyclicWitnesses(
  values: ReadonlyMap<string, number>,
  witnesses: ReadonlyMap<string, BottleneckWitness>,
  input: BottleneckHypergraphInput
): void {
  const edgesById = new Map<string, BottleneckHyperedge[]>();
  for (const e of input.edges) {
    if (e.id !== undefined) edgesById.set(e.id, [...(edgesById.get(e.id) ?? []), e]);
  }
  const state = new Map<string, 1 | 2>();
  const dfs = (node: string): void => {
    const mark = state.get(node);
    expect(mark).not.toBe(1);
    if (mark === 2) return;
    state.set(node, 1);
    const val = values.get(node);
    const w = witnesses.get(node);
    expect(val).toBeDefined();
    expect(w).toBeDefined();
    expect(w!.grade).toBe(val);
    if (w!.kind === "seed") {
      expect(input.seeds.get(node)).toBe(val);
    } else {
      const candidates = edgesById.get(w!.ruleId);
      if (candidates !== undefined) {
        const matched = candidates.some((edge) => {
          if (edge.to !== node) return false;
          const cap = edge.kind === "identity" ? input.top : Math.max(0, Math.min(input.top, Math.trunc(edge.strength)));
          if (edge.kind === "or") {
            return w!.premises.length === 1 && edge.from.includes(w!.premises[0]!)
              && Math.min(cap, values.get(w!.premises[0]!)!) === val;
          }
          const deduped = edge.kind === "and" ? [...new Set(edge.from)] : [edge.from];
          if (deduped.length !== w!.premises.length || !deduped.every((p) => w!.premises.includes(p))) return false;
          const minPrem = w!.premises.reduce((acc, p) => Math.min(acc, values.get(p)!), input.top);
          return Math.min(cap, minPrem) === val;
        });
        expect(matched).toBe(true);
      }
      for (const p of w!.premises) {
        expect(values.get(p)!).toBeGreaterThanOrEqual(val!);
        dfs(p);
      }
    }
    state.set(node, 2);
  };
  for (const id of values.keys()) dfs(id);
}

function randomHypergraph(
  nodeIds: readonly string[],
  top: number,
  rng: () => number,
  includeAxioms: boolean
): BottleneckHypergraphInput {
  const seeds = new Map<string, number>();
  for (const id of nodeIds) {
    if (rng() < 0.35) seeds.set(id, Math.floor(rng() * (top + 1)));
  }
  const edgeCount = 2 + Math.floor(rng() * (nodeIds.length * 3));
  const edges: BottleneckHyperedge[] = [];
  for (let i = 0; i < edgeCount; i += 1) {
    const to = nodeIds[Math.floor(rng() * nodeIds.length)]!;
    const roll = rng();
    const strength = Math.floor(rng() * (top + 1));
    const id = `e${i}`;
    if (roll < 0.25) {
      const from = nodeIds[Math.floor(rng() * nodeIds.length)]!;
      edges.push({ id, kind: "unary", from, to, strength });
    } else if (roll < 0.4) {
      const from = nodeIds[Math.floor(rng() * nodeIds.length)]!;
      edges.push({ id, kind: "identity", from, to });
    } else if (roll < 0.72) {
      const arity = includeAxioms && i === 0 ? 0 : 1 + Math.floor(rng() * 3);
      const from = Array.from({ length: arity }, () => nodeIds[Math.floor(rng() * nodeIds.length)]!);
      edges.push({ id, kind: "and", from, to, strength });
    } else {
      const arity = rng() < 0.1 ? 0 : 1 + Math.floor(rng() * 3);
      const from = Array.from({ length: arity }, () => nodeIds[Math.floor(rng() * nodeIds.length)]!);
      edges.push({ id, kind: "or", from, to, strength });
    }
  }
  return { nodeIds, seeds, edges, bottom: 0, top };
}

function randomRevision(prior: BottleneckHypergraphInput, rng: () => number): BottleneckHypergraphInput {
  const seeds = new Map<string, number>();
  for (const id of prior.nodeIds) {
    const pVal = prior.seeds.get(id);
    if (pVal !== undefined) {
      const r = rng();
      if (r < 0.55) seeds.set(id, pVal);
      else if (r < 0.75) seeds.set(id, Math.floor(rng() * (prior.top + 1)));
    } else if (rng() < 0.15) {
      seeds.set(id, Math.floor(rng() * (prior.top + 1)));
    }
  }
  const edges: BottleneckHyperedge[] = [];
  for (const edge of prior.edges) {
    const r = rng();
    if (r < 0.25) continue;
    if (edge.kind === "identity" || r < 0.75) {
      edges.push(edge);
    } else {
      edges.push({ ...edge, strength: Math.floor(rng() * (prior.top + 1)) });
    }
  }
  if (rng() < 0.4) {
    const to = prior.nodeIds[Math.floor(rng() * prior.nodeIds.length)]!;
    const from = prior.nodeIds[Math.floor(rng() * prior.nodeIds.length)]!;
    edges.push({ id: "added-edge", kind: "unary", from, to, strength: Math.floor(rng() * (prior.top + 1)) });
  }
  return { nodeIds: prior.nodeIds, seeds, edges, bottom: 0, top: prior.top };
}

function expectMapsEqual(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): void {
  const sortEntries = (m: ReadonlyMap<string, number>) =>
    [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  expect(sortEntries(left)).toEqual(sortEntries(right));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
