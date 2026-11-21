import {
  assertValidTop,
  canonicalRuleStructureKey,
  requireGrade,
  type BottleneckHyperedge,
  type BottleneckWitness
} from "./bottleneck-hypergraph.js";

export interface MonotonicMaintainerStats {
  readonly premiseInspections: number;
  readonly edgeRescans: number;
  readonly watcherRemovals: number;
  readonly relaxations: number;
}

export interface MonotonicMaintainerInput {
  readonly nodeIds: readonly string[];
  readonly bottom: 0;
  readonly top: number;
  readonly seeds?: ReadonlyMap<string, number>;
  readonly edges?: readonly BottleneckHyperedge[];
  readonly initialValues?: ReadonlyMap<string, number>;
  readonly initialWitnesses?: ReadonlyMap<string, BottleneckWitness>;
}

interface DirectRuleEntry {
  readonly ruleId: string;
  readonly kind: "unary" | "identity" | "or";
  readonly premises: readonly number[];
  readonly to: number;
  cap: number;
}

interface AndRuleEntry {
  readonly ruleId: string;
  readonly premises: readonly number[];
  readonly to: number;
  cap: number;
  mu: number;
  readonly tiedMinima: Set<number>;
}

interface AxiomEntry {
  readonly ruleId: string;
  readonly to: number;
  cap: number;
}

type EdgeRef =
  | { readonly kind: "direct"; readonly idx: number }
  | { readonly kind: "and"; readonly idx: number }
  | { readonly kind: "axiom"; readonly idx: number };

/** Algorithm B: monotonic hypergraph maintainer with tied-minima watcher sets (Theorem 3.4). */
export class MonotonicHypergraphMaintainer {
  public readonly top: number;
  private readonly nodeIds: string[] = [];
  private readonly indexById = new Map<string, number>();
  private readonly valuesArr: number[] = [];
  private readonly witnessesArr: (BottleneckWitness | undefined)[] = [];
  private readonly inQueue: number[] = [];
  private readonly queue: number[] = [];
  private queueHead = 0;

  private readonly directByPremise: number[][] = [];
  private readonly directEdges: DirectRuleEntry[] = [];
  private readonly andEdges: AndRuleEntry[] = [];
  private readonly axioms: AxiomEntry[] = [];
  private readonly andWatchersByNode: Set<number>[] = [];
  private readonly edgeRefByStructAndId = new Map<string, EdgeRef>();
  private readonly edgeRefsByUserId = new Map<string, EdgeRef[]>();
  private anonymousEdgeCounter = 0;

  private premiseInspections = 0;
  private edgeRescans = 0;
  private watcherRemovals = 0;
  private relaxations = 0;

  public constructor(input: MonotonicMaintainerInput) {
    this.top = assertValidTop(input.top, input.bottom);
    this.addNodes(input.nodeIds);
    if (input.initialValues !== undefined) {
      for (const [id, raw] of input.initialValues) {
        const idx = this.indexById.get(id);
        if (idx === undefined) continue;
        this.valuesArr[idx] = requireGrade(raw, this.top);
        const w = input.initialWitnesses?.get(id);
        if (w !== undefined) this.witnessesArr[idx] = w;
      }
    }
    if (input.seeds !== undefined) {
      for (const [id, raw] of input.seeds) {
        const idx = this.indexById.get(id);
        if (idx === undefined) continue;
        const grade = requireGrade(raw, this.top);
        this.raiseNode(idx, grade, { kind: "seed", grade });
      }
    }
    if (input.edges !== undefined) {
      for (const edge of input.edges) this.registerEdge(edge);
    }
    this.propagate();
  }

  public get stats(): MonotonicMaintainerStats {
    return {
      premiseInspections: this.premiseInspections,
      edgeRescans: this.edgeRescans,
      watcherRemovals: this.watcherRemovals,
      relaxations: this.relaxations
    };
  }

  public get values(): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (let i = 0; i < this.nodeIds.length; i += 1) {
      if (this.valuesArr[i]! >= 0) out.set(this.nodeIds[i]!, this.valuesArr[i]!);
    }
    return out;
  }

  public get witnesses(): ReadonlyMap<string, BottleneckWitness> {
    const out = new Map<string, BottleneckWitness>();
    for (let i = 0; i < this.nodeIds.length; i += 1) {
      const w = this.witnessesArr[i];
      if (this.valuesArr[i]! >= 0 && w !== undefined) out.set(this.nodeIds[i]!, w);
    }
    return out;
  }

  public addNodes(nodeIds: readonly string[]): void {
    for (const id of nodeIds) {
      if (this.indexById.has(id)) continue;
      this.indexById.set(id, this.nodeIds.length);
      this.nodeIds.push(id);
      this.valuesArr.push(-1);
      this.witnessesArr.push(undefined);
      this.inQueue.push(0);
      this.directByPremise.push([]);
      this.andWatchersByNode.push(new Set<number>());
    }
  }

  public raiseSeed(nodeId: string, grade: number, options?: { readonly propagate?: boolean }): void {
    const idx = this.indexById.get(nodeId);
    if (idx === undefined) return;
    grade = requireGrade(grade, this.top);
    this.raiseNode(idx, grade, { kind: "seed", grade });
    if (options?.propagate !== false) this.propagate();
  }

  public raiseSeeds(seeds: ReadonlyMap<string, number>, options?: { readonly propagate?: boolean }): void {
    for (const [id, grade] of seeds) {
      this.raiseSeed(id, grade, { propagate: false });
    }
    if (options?.propagate !== false) this.propagate();
  }

  public addEdge(edge: BottleneckHyperedge, options?: { readonly propagate?: boolean }): void {
    this.registerEdge(edge);
    if (options?.propagate !== false) this.propagate();
  }

  public addEdges(edges: readonly BottleneckHyperedge[], options?: { readonly propagate?: boolean }): void {
    for (const edge of edges) this.registerEdge(edge);
    if (options?.propagate !== false) this.propagate();
  }

  public upgradeEdge(edgeId: string, newStrength: number, options?: { readonly propagate?: boolean }): void {
    const refs = this.edgeRefsByUserId.get(edgeId);
    if (refs === undefined) return;
    const nextCap = requireGrade(newStrength, this.top);
    for (const ref of refs) this.upgradeEdgeRef(ref, nextCap);
    if (options?.propagate !== false) this.propagate();
  }

  private upgradeEdgeRef(ref: EdgeRef, nextCap: number): void {
    if (ref.kind === "axiom") {
      const entry = this.axioms[ref.idx]!;
      if (nextCap <= entry.cap) return;
      entry.cap = nextCap;
      this.raiseNode(entry.to, nextCap, { kind: "rule", ruleId: entry.ruleId, grade: nextCap, premises: [] });
    } else if (ref.kind === "direct") {
      const entry = this.directEdges[ref.idx]!;
      if (entry.kind === "identity" || nextCap <= entry.cap) return;
      entry.cap = nextCap;
      this.relaxDirectRule(entry);
    } else {
      const entry = this.andEdges[ref.idx]!;
      if (nextCap <= entry.cap) return;
      entry.cap = nextCap;
      this.relaxAndRule(entry);
    }
  }

  public propagate(): void {
    while (this.queueHead < this.queue.length) {
      const p = this.queue[this.queueHead++]!;
      this.inQueue[p] = 0;
      const val = this.valuesArr[p]!;
      for (const directIdx of this.directByPremise[p]!) {
        const entry = this.directEdges[directIdx]!;
        const candidate = Math.min(entry.cap, val);
        this.relaxations += 1;
        this.raiseNode(entry.to, candidate, {
          kind: "rule",
          ruleId: entry.ruleId,
          grade: candidate,
          premises: [this.nodeIds[p]!]
        });
      }
      this.notifyAndWatchers(p, val);
    }
    this.queue.length = 0;
    this.queueHead = 0;
  }

  private notifyAndWatchers(p: number, val: number): void {
    const watchers = this.andWatchersByNode[p]!;
    if (watchers.size === 0) return;
    for (const andIdx of [...watchers]) {
      const entry = this.andEdges[andIdx]!;
      if (val <= entry.mu) continue;
      watchers.delete(andIdx);
      entry.tiedMinima.delete(p);
      this.watcherRemovals += 1;
      if (entry.tiedMinima.size === 0) {
        this.rescanAndRule(andIdx, entry);
      }
    }
  }

  private rescanAndRule(andIdx: number, entry: AndRuleEntry): void {
    this.edgeRescans += 1;
    let minVal = Number.POSITIVE_INFINITY;
    for (const p of entry.premises) {
      this.premiseInspections += 1;
      const v = this.valuesArr[p]!;
      if (v < minVal) minVal = v;
    }
    entry.mu = minVal;
    for (const p of entry.premises) {
      if (this.valuesArr[p]! === minVal) {
        entry.tiedMinima.add(p);
        this.andWatchersByNode[p]!.add(andIdx);
      }
    }
    this.relaxAndRule(entry);
  }

  private relaxAndRule(entry: AndRuleEntry): void {
    if (entry.mu < 0) return;
    const candidate = Math.min(entry.cap, entry.mu);
    this.relaxations += 1;
    this.raiseNode(entry.to, candidate, {
      kind: "rule",
      ruleId: entry.ruleId,
      grade: candidate,
      premises: entry.premises.map((p) => this.nodeIds[p]!)
    });
  }

  private relaxDirectRule(entry: DirectRuleEntry): void {
    let bestPremise = -1;
    let bestVal = -1;
    for (const p of entry.premises) {
      this.premiseInspections += 1;
      const v = this.valuesArr[p]!;
      if (v > bestVal) {
        bestVal = v;
        bestPremise = p;
      }
    }
    if (bestVal < 0) return;
    const candidate = Math.min(entry.cap, bestVal);
    this.relaxations += 1;
    this.raiseNode(entry.to, candidate, {
      kind: "rule",
      ruleId: entry.ruleId,
      grade: candidate,
      premises: [this.nodeIds[bestPremise]!]
    });
  }

  private registerEdge(edge: BottleneckHyperedge): void {
    const to = this.indexById.get(edge.to);
    if (to === undefined) return;
    const premises = resolveUniquePremises(this.indexById, edge);
    if (premises === undefined) return;
    const cap = edge.kind === "identity" ? this.top : requireGrade(edge.strength, this.top);
    const structKey = canonicalRuleStructureKey(edge.kind, edge.to, premises.map((p) => this.nodeIds[p]!));
    const compositeKey = edge.id === undefined ? undefined : JSON.stringify([edge.id, structKey]);
    if (compositeKey !== undefined && this.edgeRefByStructAndId.has(compositeKey)) {
      this.upgradeEdgeRef(this.edgeRefByStructAndId.get(compositeKey)!, cap);
      return;
    }
    const ruleId = edge.id ?? `inc#${this.anonymousEdgeCounter++}`;
    let ref: EdgeRef;
    if (edge.kind === "and" && premises.length === 0) {
      ref = { kind: "axiom", idx: this.axioms.length };
      this.axioms.push({ ruleId, to, cap });
      this.trackEdgeRef(edge.id, compositeKey, ref);
      this.raiseNode(to, cap, { kind: "rule", ruleId, grade: cap, premises: [] });
      return;
    }
    if (edge.kind === "or" && premises.length === 0) return;
    if (edge.kind === "and") {
      const idx = this.andEdges.length;
      const entry: AndRuleEntry = { ruleId, premises, to, cap, mu: -1, tiedMinima: new Set<number>() };
      this.andEdges.push(entry);
      this.trackEdgeRef(edge.id, compositeKey, { kind: "and", idx });
      this.rescanAndRule(idx, entry);
      return;
    }
    const idx = this.directEdges.length;
    const entry: DirectRuleEntry = { ruleId, kind: edge.kind, premises, to, cap };
    this.directEdges.push(entry);
    this.trackEdgeRef(edge.id, compositeKey, { kind: "direct", idx });
    for (const p of premises) this.directByPremise[p]!.push(idx);
    this.relaxDirectRule(entry);
  }

  private trackEdgeRef(userId: string | undefined, compositeKey: string | undefined, ref: EdgeRef): void {
    if (userId === undefined || compositeKey === undefined) return;
    this.edgeRefByStructAndId.set(compositeKey, ref);
    const list = this.edgeRefsByUserId.get(userId);
    if (list === undefined) this.edgeRefsByUserId.set(userId, [ref]);
    else list.push(ref);
  }

  private raiseNode(idx: number, grade: number, witness: BottleneckWitness): void {
    if (grade <= this.valuesArr[idx]!) return;
    this.valuesArr[idx] = grade;
    this.witnessesArr[idx] = witness;
    if (this.inQueue[idx] === 0) {
      this.inQueue[idx] = 1;
      this.queue.push(idx);
    }
  }
}

function resolveUniquePremises(
  indexById: ReadonlyMap<string, number>,
  edge: BottleneckHyperedge
): readonly number[] | undefined {
  const raw = edge.kind === "and" || edge.kind === "or" ? edge.from : [edge.from];
  const premises: number[] = [];
  const seen = new Set<number>();
  for (const id of raw) {
    const idx = indexById.get(id);
    if (idx === undefined) return undefined;
    if (!seen.has(idx)) {
      seen.add(idx);
      premises.push(idx);
    }
  }
  return premises;
}
