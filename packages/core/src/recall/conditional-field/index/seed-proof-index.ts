import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import type { Derivation } from "@do-soul/alaya-protocol";

/** A supplied forest is indexed incrementally before incomplete grounding can prove seeds. */
export class SeedProofIndex {
  private offset = 0;
  private rowsById = new PersistentStringMap<Derivation>();
  public retainedBytes = 0;
  public constructor(public readonly rows: readonly Derivation[], private readonly revision?: string) {}
  public fork(): SeedProofIndex { return Object.assign(Object.create(SeedProofIndex.prototype), this); }
  public matchesSource(rows: readonly Derivation[], revision?: string): boolean {
    return this.revision !== undefined || revision !== undefined
      ? this.revision !== undefined && this.revision === revision : this.rows === rows;
  }
  public get forest(): ReadonlyMap<string, Derivation> { return this.rowsById; }
  public advance(allowance: number, memory: number): { work: number; bytes: number; complete: boolean } {
    let work = 0, bytes = 0;
    while (this.offset < this.rows.length && work < allowance) {
      const row = this.rows[this.offset]!;
      const cost = 128 + 2 * row.derivation_id.length;
      if (memory - bytes < cost) break;
      this.rowsById = this.rowsById.with(row.derivation_id, row);
      this.offset++; work++; bytes += cost;
    }
    this.retainedBytes += bytes;
    return { work, bytes, complete: this.offset === this.rows.length };
  }
}
