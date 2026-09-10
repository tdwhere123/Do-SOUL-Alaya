import { MaxMinWorkQueue, PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { productSubjectId, type Derivation, type SeedActivation, type Transition } from "@do-soul/alaya-protocol";
import { productStateNodeId } from "../reference/bind-max-min.js";
import type { RetainedRows } from "./retained-sequence.js";
import { incomingRules, type SharedRule } from "./dependency-equations.js";
import { joinDerivation, leafDerivation, seedDerivationIdentity } from "./path-derivation.js";

type RuleIndex = PersistentStringMap<PersistentStringMap<SharedRule>>;
type CurrentProduct = Readonly<{ id: string; grade: number; phase: "incoming" | "outgoing"; offset: number; root?: Derivation }>;
type InputReferences = readonly unknown[];

export type GroundingProgress = Readonly<{
  input_digest: string;
  input_references: InputReferences;
  completed_work: number;
  retained_bytes: number;
  forest: PersistentStringMap<Derivation>;
  incoming: RuleIndex;
  outgoing: RuleIndex;
  root_map: PersistentStringMap<readonly string[]>;
  assembled: PersistentStringMap<Derivation>;
  grades: PersistentStringMap<number>;
  settled: PersistentStringMap<true>;
  queue: MaxMinWorkQueue;
  current?: CurrentProduct;
  derivation_offset: number;
  transition_offset: number;
  seed_offset: number;
  retained_rule_references: number;
}>;

type GroundingInput = Readonly<{
  seeds: RetainedRows<SeedActivation>;
  transitions: RetainedRows<Transition>;
  derivations: RetainedRows<Derivation>;
  transition_derivations: import("./path-derivation.js").DerivationRootLookup;
  allowance: number;
  memory_bytes?: number;
  progress?: GroundingProgress;
  input_revision?: string;
}>;

let localGeneration = 0;

export function groundedOutputDerivations(input: GroundingInput): {
  derivations: readonly Derivation[];
  roots: Readonly<Record<string, readonly string[]>>;
  work: number;
  retained_bytes: number;
  complete: boolean;
  progress: GroundingProgress;
  retained_rule_references: number;
} {
  const references: InputReferences = [input.seeds, input.transitions,
    input.derivations.length === 0 ? null : input.derivations,
    input.transitions.length === 0 ? null : input.transition_derivations];
  const same = input.input_revision === undefined
    ? references.every((reference, index) => reference === input.progress?.input_references[index])
    : input.input_revision === input.progress?.input_digest;
  const prior = same ? input.progress : undefined;
  const inputDigest = input.input_revision ?? prior?.input_digest ?? "grounding-local-v2:" + (++localGeneration);
  const machine = new GroundingMachine(input, prior);
  while (machine.work < input.allowance && machine.step()) {}
  const progress = machine.progress(inputDigest, references);
  return {
    get derivations() { return [...progress.forest.values()]; },
    get roots() { return Object.fromEntries(progress.root_map); },
    work: machine.work,
    retained_bytes: machine.retainedBytes - (prior === undefined ? input.progress?.retained_bytes ?? 0 : 0),
    complete: machine.complete,
    progress,
    retained_rule_references: progress.retained_rule_references
  };
}

class GroundingMachine {
  public work = 0;
  public retainedBytes = 0;
  private forest: PersistentStringMap<Derivation>;
  private incoming: RuleIndex;
  private outgoing: RuleIndex;
  private roots: PersistentStringMap<readonly string[]>;
  private assembled: PersistentStringMap<Derivation>;
  private grades: PersistentStringMap<number>;
  private settled: PersistentStringMap<true>;
  private queue: MaxMinWorkQueue;
  private current: CurrentProduct | undefined;
  private derivationOffset: number;
  private transitionOffset: number;
  private seedOffset: number;
  private ruleReferences: number;
  private readonly memory: number;

  public constructor(private readonly input: GroundingInput, private readonly prior: GroundingProgress | undefined) {
    this.forest = prior?.forest ?? new PersistentStringMap();
    this.incoming = prior?.incoming ?? new PersistentStringMap();
    this.outgoing = prior?.outgoing ?? new PersistentStringMap();
    this.roots = prior?.root_map ?? new PersistentStringMap();
    this.assembled = prior?.assembled ?? new PersistentStringMap();
    this.grades = prior?.grades ?? new PersistentStringMap();
    this.settled = prior?.settled ?? new PersistentStringMap();
    this.queue = prior?.queue ?? new MaxMinWorkQueue();
    this.current = prior?.current;
    this.derivationOffset = prior?.derivation_offset ?? 0;
    this.transitionOffset = prior?.transition_offset ?? 0;
    this.seedOffset = prior?.seed_offset ?? 0;
    this.ruleReferences = prior?.retained_rule_references ?? 0;
    this.memory = (input.memory_bytes ?? Number.MAX_SAFE_INTEGER) + (prior === undefined ? input.progress?.retained_bytes ?? 0 : 0);
  }

  public get complete(): boolean {
    return this.derivationOffset === this.input.derivations.length && this.transitionOffset === this.input.transitions.length
      && this.seedOffset === this.input.seeds.length && this.current === undefined && this.queue.size === 0;
  }

  public step(): boolean {
    if (this.complete) return false;
    this.work += 1;
    if (this.derivationOffset < this.input.derivations.length) {
      if (!this.retainNode(this.input.derivations.at(this.derivationOffset)!)) return false;
      this.derivationOffset += 1;
      return true;
    }
    if (this.transitionOffset < this.input.transitions.length) return this.indexTransition();
    if (this.seedOffset < this.input.seeds.length) return this.indexSeed();
    if (this.current !== undefined) return this.advanceProduct(this.current);
    const next = this.queue.pop();
    if (next === undefined) return false;
    this.queue = next.queue;
    if (this.settled.has(next.item.nodeId) || this.grades.get(next.item.nodeId) !== next.item.strength) return true;
    this.settled = this.settled.with(next.item.nodeId, true);
    this.current = { id: next.item.nodeId, grade: next.item.strength, phase: "incoming", offset: 0,
      root: this.assembled.get(next.item.nodeId) };
    return true;
  }

  private indexTransition(): boolean {
    const edge = this.input.transitions.at(this.transitionOffset)!;
    if (edge.applicable) {
      const rule = [...incomingRules([edge], this.input.transition_derivations).values()][0]?.[0];
      if (rule !== undefined && !this.incoming.get(rule.to)?.has(rule.rule_id)) {
        const missing = this.forest.has(rule.derivation_id) ? [] : [leafDerivation({ derivation_id: rule.derivation_id,
          observation_id: edge.instance_id ?? edge.relation_kind, leaf_id: edge.instance_id ?? rule.derivation_id,
          source_revision: edge.revision_id, association_milligrades: edge.strength_milligrades })];
        if (!this.retainNodes(missing, 128 + Buffer.byteLength(rule.rule_id, "utf8"))) return false;
        this.incoming = addRule(this.incoming, rule.to, rule);
        this.outgoing = addRule(this.outgoing, rule.from, rule);
        this.ruleReferences += 1;
      }
    }
    this.transitionOffset += 1;
    return true;
  }

  private indexSeed(): boolean {
    const seed = this.input.seeds.at(this.seedOffset)!;
    const key = productStateNodeId(seed.state);
    if ((this.grades.get(key) ?? -1) < seed.milligrades) {
      const root = leafDerivation({ derivation_id: seedDerivationIdentity(key), observation_id: productSubjectId(seed.state),
        leaf_id: seedDerivationIdentity(key), source_revision: seed.state.target.kind === "memory_entry" ? seed.state.target.source_revision : seed.state.target.source_version,
        association_milligrades: seed.milligrades });
      if (!this.retainNodes([root], 64 + Buffer.byteLength(key, "utf8"))) return false;
      this.assembled = this.assembled.with(key, root);
      this.roots = this.roots.with(key, [root.derivation_id]);
      this.grades = this.grades.with(key, seed.milligrades);
      if (this.input.transitions.length > 0) this.queue = this.queue.push({ nodeId: key, strength: seed.milligrades });
      this.ruleReferences += 1;
    }
    this.seedOffset += 1;
    return true;
  }

  private advanceProduct(current: CurrentProduct): boolean {
    if (current.phase === "incoming") {
      const rule = this.incoming.get(current.id)?.entryAt(current.offset)?.[1];
      if (rule === undefined) {
        if (current.root !== undefined) {
          this.assembled = this.assembled.with(current.id, current.root);
          this.roots = this.roots.with(current.id, [current.root.derivation_id]);
        }
        this.current = { ...current, phase: "outgoing", offset: 0 };
        return true;
      }
      const premise = this.assembled.get(rule.from);
      const edge = this.forest.get(rule.derivation_id);
      let root = current.root;
      if (premise !== undefined && edge !== undefined) {
        const serial = joinDerivation("serial", [premise, edge]);
        const alternative = root === undefined ? serial : joinDerivation("or", [root, serial]);
        if (!this.retainNodes([serial, alternative])) return false;
        root = alternative;
      }
      this.current = { ...current, offset: current.offset + 1, root };
      return true;
    }
    const rule = this.outgoing.get(current.id)?.entryAt(current.offset)?.[1];
    if (rule === undefined) { this.current = undefined; return true; }
    if (!this.settled.has(rule.to)) {
      const grade = Math.min(current.grade, rule.cap);
      if ((this.grades.get(rule.to) ?? -1) < grade) {
        this.grades = this.grades.with(rule.to, grade);
        this.queue = this.queue.push({ nodeId: rule.to, strength: grade });
      }
    }
    this.current = { ...current, offset: current.offset + 1 };
    return true;
  }

  private retainNode(node: Derivation): boolean {
    return this.retainNodes([node]);
  }

  private retainNodes(nodes: readonly Derivation[], extraBytes = 0): boolean {
    const unique = new Map(nodes.map((node) => [node.derivation_id, node]));
    let bytes = extraBytes;
    for (const node of unique.values()) if (!this.forest.has(node.derivation_id)) bytes += Buffer.byteLength(JSON.stringify(node), "utf8") + 64;
    if (!this.retain(bytes)) return false;
    for (const node of unique.values()) this.forest = this.forest.with(node.derivation_id, node);
    return true;
  }

  private retain(bytes: number): boolean {
    if (this.retainedBytes + bytes > this.memory) return false;
    this.retainedBytes += bytes;
    return true;
  }

  public progress(inputDigest: string, references: InputReferences): GroundingProgress {
    return { input_digest: inputDigest, input_references: references, completed_work: (this.prior?.completed_work ?? 0) + this.work,
      retained_bytes: (this.prior?.retained_bytes ?? 0) + this.retainedBytes, forest: this.forest, incoming: this.incoming,
      outgoing: this.outgoing, root_map: this.roots, assembled: this.assembled, grades: this.grades, settled: this.settled,
      queue: this.queue, current: this.current, derivation_offset: this.derivationOffset, transition_offset: this.transitionOffset,
      seed_offset: this.seedOffset, retained_rule_references: this.ruleReferences };
  }
}

function addRule(index: RuleIndex, product: string, rule: SharedRule): RuleIndex {
  return index.with(product, (index.get(product) ?? new PersistentStringMap<SharedRule>()).with(rule.rule_id, rule));
}
