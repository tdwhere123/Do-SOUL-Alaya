import { MaxMinWorkQueue, PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { productEndpointId, type Derivation, type SeedActivation, type Transition } from "@do-soul/alaya-protocol";
import { CoreError } from "../../../shared/errors.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import { incomingRules, type SharedRule } from "./dependency-equations.js";
import { joinDerivation, leafDerivation, seedDerivationIdentity } from "./path-derivation.js";

type RuleIndex = PersistentStringMap<PersistentStringMap<SharedRule>>;
type CurrentProduct = Readonly<{ id: string; grade: number; phase: "incoming" | "outgoing"; offset: number; root?: Derivation }>;
type ProofFrame = Readonly<{
  id: string;
  offset: number;
  root?: Derivation;
  cycle: boolean;
  depth: number;
  active: PersistentStringMap<true>;
  parent?: ProofFrame;
}>;
type InputReferences = readonly unknown[];

export type GroundingProgress = Readonly<{
  input_digest: string;
  input_references: InputReferences;
  completed_work: number;
  /** Successful retained transitions; failed resource attempts do not advance this cursor. */
  completed_steps: number;
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
  proof_needed: boolean;
  proof_offset: number;
  proof_frame?: ProofFrame;
  proof_memo: PersistentStringMap<Derivation | null>;
  proof_capacity: number;
  derivation_offset: number;
  transition_offset: number;
  seed_offset: number;
  retained_rule_references: number;
}>;

type GroundingRows<T> = Readonly<{ readonly length: number; at(index: number): T | undefined }>;

type GroundingInput = Readonly<{
  seeds: GroundingRows<SeedActivation>;
  transitions: GroundingRows<Transition>;
  derivations: GroundingRows<Derivation>;
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
  /** New logical allocation admitted by this call, independent of a prior owner's release. */
  admitted_bytes: number;
  /** Signed change in the retained grounding level for available-memory adjustment. */
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
  let completedSteps = prior?.completed_steps ?? 0;
  while (machine.work < input.allowance && machine.step()) completedSteps++;
  const progress = machine.progress(inputDigest, references, completedSteps);
  return {
    get derivations() { return [...progress.forest.values()]; },
    get roots() { return Object.fromEntries(progress.root_map); },
    work: machine.work,
    admitted_bytes: machine.retainedBytes,
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
  private proofNeeded: boolean;
  private proofOffset: number;
  private proofFrame: ProofFrame | undefined;
  private proofMemo: PersistentStringMap<Derivation | null>;
  private proofCapacity: number;
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
    this.proofNeeded = prior?.proof_needed ?? false;
    this.proofOffset = prior?.proof_offset ?? 0;
    this.proofFrame = prior?.proof_frame;
    this.proofMemo = prior?.proof_memo ?? new PersistentStringMap();
    this.proofCapacity = prior?.proof_capacity ?? 0;
    this.derivationOffset = prior?.derivation_offset ?? 0;
    this.transitionOffset = prior?.transition_offset ?? 0;
    this.seedOffset = prior?.seed_offset ?? 0;
    this.ruleReferences = prior?.retained_rule_references ?? 0;
    this.memory = (input.memory_bytes ?? Number.MAX_SAFE_INTEGER) + (prior === undefined ? input.progress?.retained_bytes ?? 0 : 0);
  }

  public get complete(): boolean {
    return this.derivationOffset === this.input.derivations.length && this.transitionOffset === this.input.transitions.length
      && this.seedOffset === this.input.seeds.length && this.current === undefined && this.queue.size === 0
      && (!this.proofNeeded || (this.proofOffset === this.settled.size && this.proofFrame === undefined));
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
    if (next !== undefined) {
      this.queue = next.queue;
      if (this.settled.has(next.item.nodeId) || this.grades.get(next.item.nodeId) !== next.item.strength) return true;
      this.settled = this.settled.with(next.item.nodeId, true);
      this.current = { id: next.item.nodeId, grade: next.item.strength, phase: "incoming", offset: 0,
        root: this.assembled.get(next.item.nodeId) };
      return true;
    }
    return this.advanceProof();
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
      const root = leafDerivation({ derivation_id: seedDerivationIdentity(key), observation_id: productEndpointId(seed.state),
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
      // Only a seed with no incoming rules is an independent, single-edge premise.
      // Assembled roots may already contain a weaker seed or a walk through this product.
      const premise = this.incoming.has(rule.from) ? undefined : this.forest.get(seedDerivationIdentity(rule.from));
      const edge = this.forest.get(rule.derivation_id);
      let root = current.root;
      if (premise !== undefined && edge !== undefined && rule.from !== current.id) {
        const serial = joinDerivation("serial", [premise, edge]);
        const alternative = root === undefined ? serial : joinDerivation("or", [root, serial]);
        if (!this.retainNodes([serial, alternative])) return false;
        root = alternative;
      } else {
        this.proofNeeded = true;
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

  private advanceProof(): boolean {
    const frame = this.proofFrame;
    if (frame === undefined) {
      const next = this.settled.entryAt(this.proofOffset);
      if (next === undefined) return false;
      return this.openProof(next[0]);
    }
    const rule = this.incoming.get(frame.id)?.entryAt(frame.offset)?.[1];
    if (rule === undefined) return this.finishProof(frame);
    if (!this.settled.has(rule.from) || frame.active.has(rule.from)) {
      // A repeated product is a cyclic walk, not a new founded witness.
      this.proofFrame = { ...frame, offset: frame.offset + 1,
        cycle: frame.cycle || frame.active.has(rule.from) };
      return true;
    }
    const known = this.proofMemo.get(rule.from);
    if (known !== undefined) return this.joinProof(frame, rule, known === null ? undefined : known);
    return this.openProof(rule.from, frame);
  }

  private openProof(id: string, parent?: ProofFrame): boolean {
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > this.proofCapacity) {
      // Parent frames retain every version of the active AVL map. Insertion copies a
      // search path and may rotate nodes; reserve a conservative per-depth peak for
      // the frame, map wrapper and all copied AVL nodes, not only the frame object.
      // Branches reuse the slot once their prior frames are no longer retained.
      const copiedNodes = 2 * Math.ceil(Math.log2(depth + 2)) + 5;
      if (!this.retain(128 + copiedNodes * 96)) return false;
      this.proofCapacity = depth;
    }
    this.proofFrame = { id, offset: 0, root: this.forest.get(seedDerivationIdentity(id)), cycle: false,
      depth, active: (parent?.active ?? new PersistentStringMap<true>()).with(id, true), parent };
    return true;
  }

  private joinProof(frame: ProofFrame, rule: SharedRule, premise: Derivation | undefined): boolean {
    const edge = this.forest.get(rule.derivation_id);
    let root = frame.root;
    if (premise !== undefined && edge !== undefined) {
      const serial = joinDerivation("serial", [premise, edge]);
      const alternative = root === undefined ? serial : joinDerivation("or", [root, serial]);
      if (!this.retainNodes([serial, alternative])) return false;
      root = alternative;
    }
    this.proofFrame = { ...frame, offset: frame.offset + 1, root };
    return true;
  }

  private finishProof(frame: ProofFrame): boolean {
    const memoBytes = frame.cycle || this.proofMemo.has(frame.id) ? 0 : 64 + Buffer.byteLength(frame.id, "utf8");
    if (frame.parent !== undefined) {
      const rule = this.incoming.get(frame.parent.id)?.entryAt(frame.parent.offset)?.[1];
      if (rule === undefined) throw new CoreError("OBLIGATION_VIOLATION", "missing retained proof rule");
      const edge = this.forest.get(rule.derivation_id);
      const serial = frame.root !== undefined && edge !== undefined ? joinDerivation("serial", [frame.root, edge]) : undefined;
      const alternative = serial === undefined ? undefined : frame.parent.root === undefined
        ? serial : joinDerivation("or", [frame.parent.root, serial]);
      if (!this.retainNodes([...(serial === undefined ? [] : [serial, alternative!])], memoBytes)) return false;
      if (!frame.cycle) this.proofMemo = this.proofMemo.with(frame.id, frame.root ?? null);
      this.proofFrame = { ...frame.parent, offset: frame.parent.offset + 1,
        root: alternative ?? frame.parent.root, cycle: frame.parent.cycle || frame.cycle };
      return true;
    }
    // Numeric reachability without a founded proof cannot be certified as complete.
    if (frame.root === undefined) return false;
    if (!this.retainNodes([], memoBytes)) return false;
    if (!frame.cycle) this.proofMemo = this.proofMemo.with(frame.id, frame.root);
    this.assembled = this.assembled.with(frame.id, frame.root);
    this.roots = this.roots.with(frame.id, [frame.root.derivation_id]);
    this.proofFrame = undefined;
    this.proofOffset += 1;
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

  public progress(inputDigest: string, references: InputReferences, completedSteps: number): GroundingProgress {
    return { input_digest: inputDigest, input_references: references, completed_steps: completedSteps,
      completed_work: (this.prior?.completed_work ?? 0) + this.work,
      retained_bytes: (this.prior?.retained_bytes ?? 0) + this.retainedBytes, forest: this.forest, incoming: this.incoming,
      outgoing: this.outgoing, root_map: this.roots, assembled: this.assembled, grades: this.grades, settled: this.settled,
      queue: this.queue, current: this.current, proof_needed: this.proofNeeded,
      proof_offset: this.proofOffset, proof_frame: this.proofFrame,
      proof_memo: this.proofMemo, proof_capacity: this.proofCapacity,
      derivation_offset: this.derivationOffset, transition_offset: this.transitionOffset,
      seed_offset: this.seedOffset, retained_rule_references: this.ruleReferences };
  }
}

function addRule(index: RuleIndex, product: string, rule: SharedRule): RuleIndex {
  return index.with(product, (index.get(product) ?? new PersistentStringMap<SharedRule>()).with(rule.rule_id, rule));
}
