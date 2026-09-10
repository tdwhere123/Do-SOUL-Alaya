import { BOUNDED_DEFAULT_ARRAY_MAX, type Derivation, type IndexEntry } from "@do-soul/alaya-protocol";
import { traceDerivationForest, type DerivationTraversal } from "../engine/derivation-provenance.js";

export type ProjectedPage = Readonly<{
  entries: readonly IndexEntry[]; page: readonly IndexEntry[]; offset: number;
  remaining: number; next: number; truncated: boolean;
}>;

/** This cursor owns one immutable page and an append-only serialization buffer. */
export class ExplanationDelivery {
  private traversal: DerivationTraversal | undefined;
  private readonly serialized: Derivation[] = [];
  private readonly roots: readonly string[];
  private traced = false;
  private invalid = false;
  private capacityLimited = false;
  public completedWork = 0;
  public retainedBytes = 0;

  public constructor(public readonly page: ProjectedPage, private readonly forest: ReadonlyMap<string, Derivation>) {
    this.roots = page.page.flatMap((entry) => entry.explanation_ids);
    this.traced = this.roots.length === 0;
  }

  public advance(allowance: number, memory: number): Readonly<{
    work: number; bytes: number; complete: boolean; invalid: boolean; capacity_limited: boolean; explanations: readonly Derivation[];
  }> {
    let work = 0;
    let bytes = 0;
    while (work < allowance && !this.invalid && !this.capacityLimited) {
      if (!this.traced) {
        if (memory - bytes < 320) break;
        const next = traceDerivationForest({ forest: this.forest, roots: this.roots, progress: this.traversal, maxVisits: 1 });
        this.traversal = next.traversal;
        this.traced = next.complete;
        this.invalid = next.traversal.invalid;
        this.capacityLimited = next.traversal.nodes.size > BOUNDED_DEFAULT_ARRAY_MAX;
        work += next.work; bytes += next.work * 320;
        if (next.work === 0 && !this.traced) break;
      } else {
        const node = this.traversal?.nodes.entryAt(this.serialized.length)?.[1];
        if (node === undefined) break;
        if (memory - bytes < 8) break;
        this.serialized.push(node);
        work += 1; bytes += 8;
      }
    }
    this.completedWork += work;
    this.retainedBytes += bytes;
    return { work, bytes, complete: this.traced && this.serialized.length === (this.traversal?.nodes.size ?? 0),
      invalid: this.invalid, capacity_limited: this.capacityLimited,
      explanations: this.capacityLimited ? [] : this.serialized };
  }
}
