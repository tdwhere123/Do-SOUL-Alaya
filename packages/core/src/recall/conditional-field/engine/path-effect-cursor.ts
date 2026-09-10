import type { CompiledAdjacencyEffect } from "./path-composition.js";
import type { ObserverPage } from "@do-soul/alaya-protocol";

export type PathComputationStep = Readonly<{ kind: "work"; retained_bytes?: number }>
  | Readonly<{ kind: "effect"; effect: CompiledAdjacencyEffect }>;
export type PathComputation<Result> = Generator<PathComputationStep, Result, void>;
export type PendingPathEffects = Readonly<{ cursor?: PathEffectCursor; offset: number; retained_bytes: number; completed_work?: number; page: ObserverPage;
  input: Readonly<{ rows: Iterable<import("./path-matching.js").AdjacencyRow>; options: import("./path-composition.js").AdjacencyEffectsInput }> }>;
const EFFECT_LOG_SLOT_BYTES = 64;

/** Prepared effects remain replayable until the field commits their offset. */
export class PathEffectCursor {
  private readonly effects: CompiledAdjacencyEffect[] = [];
  private retainedBytes: number;
  private completedWork = 0;
  private pending: PathComputationStep | undefined;
  private closed = false;
  public constructor(private readonly computation: PathComputation<void>, initialBytes: number) { this.retainedBytes = initialBytes; }

  public advance(offset: number, allowance: number, memory: number): Readonly<{
    offset: number; work: number; completed_work: number; retained_bytes: number; effects: readonly CompiledAdjacencyEffect[];
    status: "open" | "complete" | "memory_exhausted";
  }> {
    let work = 0;
    const effects: CompiledAdjacencyEffect[] = [];
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
        const next = this.computation.next();
        if (next.done) { this.closed = true; break; }
        this.pending = next.value;
      }
      const cost = this.pending.kind === "work" ? this.pending.retained_bytes ?? 0 : EFFECT_LOG_SLOT_BYTES;
      if (this.retainedBytes + cost > memory) break;
      this.retainedBytes += cost;
      if (this.pending.kind === "effect") this.effects.push(this.pending.effect);
      this.pending = undefined;
    }
    const pendingBytes = this.pending === undefined ? 0 : this.pending.kind === "work" ? this.pending.retained_bytes ?? 0 : EFFECT_LOG_SLOT_BYTES;
    return { offset, work, completed_work: this.completedWork, retained_bytes: this.retainedBytes, effects,
      status: this.retainedBytes + pendingBytes > memory ? "memory_exhausted"
        : this.closed && offset === this.effects.length ? "complete" : "open" };
  }
}
