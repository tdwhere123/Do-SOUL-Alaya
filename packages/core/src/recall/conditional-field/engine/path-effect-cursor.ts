import type { AdjacencyEffectsInput, CompiledAdjacencyEffect } from "./path-composition-adjacency.js";
import type { ObserverPage } from "@do-soul/alaya-protocol";
import { BindingContextResourceError, type BindingContextStore } from "./binding-environment.js";
import { ProgramAutomatonResourceError } from "./program-automaton.js";
import type { AdjacencyRow } from "./path-matching.js";
import type { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";

export type PathComputationStep = Readonly<{ kind: "work"; retained_bytes?: number; retention?: "effect_payload" }>
  | Readonly<{ kind: "effect"; effect: CompiledAdjacencyEffect }>;
export type PathComputation<Result> = Generator<PathComputationStep, Result, void>;
export type PathEffectPreparation = Readonly<{
  effects: readonly CompiledAdjacencyEffect[];
  next_offset: number;
  status: "open" | "complete";
  effect_index: number;
  stage: "start" | "pair" | "source" | "facet";
  facet_scan_index: number;
  facet_resume_offset: number;
  pair_demands: PersistentStringMap<true>;
  pair_bytes: number;
  source_demands: PersistentStringMap<"pending" | "done">;
  source_pending: number;
  source_bytes: number;
  retained_bytes: number;
}>;
export type PendingPathEffects = Readonly<{ cursor?: PathEffectCursor; offset: number; retained_bytes: number; completed_work?: number; progress_position?: number; guards_seen?: boolean; facet_resume_offset?: number; preparation?: PathEffectPreparation; page: ObserverPage;
  input: Readonly<{ rows: Iterable<AdjacencyRow>; options: AdjacencyEffectsInput }> }>;
const EFFECT_LOG_SLOT_BYTES = 64;

/** Prepared effects remain replayable until the field commits their offset. */
export class PathEffectCursor {
  private readonly effects: CompiledAdjacencyEffect[] = [];
  private retainedBytes: number;
  private loggedPayloadBytes = 0;
  private preparedPayloadBytes = 0;
  private pendingPayloadBytes = 0;
  private completedWork = 0;
  private computationPosition = 0;
  private progressPosition = 0;
  private pending: PathComputationStep | undefined;
  private closed = false;
  private resourceFailed = false;
  private computation: PathComputation<void>;
  private replayedEffects = 0;
  private readonly initialBindingBytes: number;
  public get initialRetainedBytes(): number { return this.initialBytes; }
  public constructor(private readonly rebuild: () => PathComputation<void>, private readonly initialBytes: number,
    public readonly bindingContexts?: BindingContextStore) {
    this.retainedBytes = initialBytes;
    this.initialBindingBytes = bindingContexts?.bytes ?? 0;
    this.computation = rebuild();
  }

  public advance(offset: number, allowance: number, memory: number): Readonly<{
    offset: number; work: number; completed_work: number; progress_position: number; retained_bytes: number; effects: readonly CompiledAdjacencyEffect[];
    admitted_bytes: number;
    status: "open" | "complete" | "memory_exhausted";
  }> {
    const initialOffset = offset;
    let work = 0;
    let admittedBytes = 0;
    const effects: CompiledAdjacencyEffect[] = [];
    if (this.resourceFailed) {
      // Throwing closes a generator. Rebuild its immutable input, preserving the
      // replay log and bindings already referenced by committed field effects.
      this.computation = this.rebuild();
      this.computationPosition = 0;
      this.replayedEffects = 0;
      this.preparedPayloadBytes = 0;
      this.retainedBytes = this.initialBytes + this.effects.length * EFFECT_LOG_SLOT_BYTES + this.loggedPayloadBytes
        + (this.bindingContexts?.bytes ?? 0) - this.initialBindingBytes;
      this.resourceFailed = false;
    }
    while (work < allowance && effects.length < 32) {
      if (this.retainedBytes > memory) break;
      const retained = this.effects[offset];
      if (retained !== undefined) {
        effects.push(retained); offset += 1; work += 1;
        continue;
      }
      if (this.closed) break;
      if (this.pending === undefined) {
        work += 1;
        this.completedWork += 1;
        const previousBytes = this.bindingContexts?.bytes ?? 0;
        this.bindingContexts?.setAvailableBytes(Math.max(0, memory - this.retainedBytes));
        let next: IteratorResult<PathComputationStep, void>;
        try { next = this.computation.next(); }
        catch (error) {
          if (!(error instanceof BindingContextResourceError) && !(error instanceof ProgramAutomatonResourceError)) throw error;
          const bindingBytes = (this.bindingContexts?.bytes ?? 0) - previousBytes;
          this.retainedBytes += bindingBytes;
          admittedBytes += Math.max(0, bindingBytes);
          this.resourceFailed = true;
          return { offset: initialOffset, work, completed_work: this.completedWork, progress_position: this.progressPosition, retained_bytes: this.retainedBytes,
            effects: [], admitted_bytes: admittedBytes, status: "memory_exhausted" };
        }
        // Successful iterator positions survive as a high-water mark. Retrying
        // a failed generator's prefix spends work without inventing progress.
        this.computationPosition += 1;
        this.progressPosition = Math.max(this.progressPosition, this.computationPosition);
        const bindingBytes = (this.bindingContexts?.bytes ?? 0) - previousBytes;
        this.retainedBytes += bindingBytes;
        admittedBytes += Math.max(0, bindingBytes);
        if (next.done) { this.closed = true; break; }
        this.pending = next.value;
        // A producer's payload reservation transfers to the log. Other effects
        // (including hyperedges) need their own charge beyond generator scratch.
        this.pendingPayloadBytes = this.pending.kind === "effect" ? this.preparedPayloadBytes
          || 512 + Buffer.byteLength(JSON.stringify(this.pending.effect), "utf8") : 0;
      }
      const replayed = this.pending.kind === "effect" && this.replayedEffects < this.effects.length;
      const cost = this.pendingAllocation();
      if (this.retainedBytes + cost > memory) break;
      this.retainedBytes += cost;
      if (!replayed) admittedBytes += Math.max(0, cost);
      if (this.pending.kind === "work" && this.pending.retention === "effect_payload") this.preparedPayloadBytes += cost;
      if (this.pending.kind === "effect") {
        if (!replayed) { this.effects.push(this.pending.effect); this.loggedPayloadBytes += this.pendingPayloadBytes; }
        else this.retainedBytes -= this.pendingPayloadBytes;
        this.preparedPayloadBytes = 0;
        this.replayedEffects += 1;
      }
      this.pending = undefined;
    }
    const pendingBytes = this.pendingAllocation();
    return { offset, work, completed_work: this.completedWork, progress_position: this.progressPosition, retained_bytes: this.retainedBytes, effects,
      admitted_bytes: admittedBytes,
      status: this.retainedBytes + pendingBytes > memory ? "memory_exhausted"
        : this.closed && offset === this.effects.length ? "complete" : "open" };
  }

  private pendingAllocation(): number {
    if (this.pending === undefined) return 0;
    if (this.pending.kind === "work") return this.pending.retained_bytes ?? 0;
    return this.pendingPayloadBytes - this.preparedPayloadBytes
      + (this.replayedEffects < this.effects.length ? 0 : EFFECT_LOG_SLOT_BYTES);
  }
}
