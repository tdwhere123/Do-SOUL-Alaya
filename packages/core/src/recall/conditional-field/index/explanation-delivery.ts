import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { BOUNDED_DEFAULT_ARRAY_MAX, type Derivation, type IndexEntry, type SupportRecord, type Witness } from "@do-soul/alaya-protocol";
import { traceDerivationForest, type DerivationTraversal } from "../engine/derivation-provenance.js";

/** Append-only rows share their previous prefix when an unissued page is retried. */
class RetainedRows<T> {
  public constructor(public readonly length = 0, private readonly items = new PersistentStringMap<T>()) {}
  public at(index: number): T | undefined { return this.items.get(String(index).padStart(16, "0")); }
  public append(value: T): RetainedRows<T> {
    return new RetainedRows(this.length + 1, this.items.with(String(this.length).padStart(16, "0"), value));
  }
  public values(): readonly T[] { return [...this.items.values()]; }
}

type PreparedEntry = Readonly<{ entry: IndexEntry; roots: RetainedRows<string> }>;

/** This cursor owns one immutable page, bounded indexes and an append-only serialization buffer. */
export class ExplanationDelivery {
  private readonly cursorIdentity = {};
  private traversal: DerivationTraversal | undefined;
  private serialized = new RetainedRows<Derivation>();
  private roots = new RetainedRows<string>();
  private readonly rows: readonly Derivation[];
  private forest: ReadonlyMap<string, Derivation>;
  private witnesses = new PersistentStringMap<Witness>();
  private prepared = new RetainedRows<PreparedEntry>();
  private currentRoots = new RetainedRows<string>();
  private rowOffset = 0;
  private supportOffset = 0;
  private witnessOffset = 0;
  private entryOffset = 0;
  private rootOffset = 0;
  private selecting = true;
  private traced = false;
  private invalid = false;
  private capacityLimited = false;
  public completedWork = 0;
  public retainedBytes = 0;
  public omitted = false;

  public constructor(public readonly page: readonly IndexEntry[],
    private readonly sourceForest: ReadonlyMap<string, Derivation> | readonly Derivation[],
    private readonly support: readonly SupportRecord[] | undefined = undefined, public readonly pageBudget = 0,
    retainedBytes = 0, private readonly sourceRevision?: string) {
    this.rows = Array.isArray(sourceForest) ? sourceForest : [];
    this.forest = Array.isArray(sourceForest) ? new PersistentStringMap<Derivation>() : sourceForest as ReadonlyMap<string, Derivation>;
    this.retainedBytes = retainedBytes;
  }

  /** A branch changes only persistent indexes and scalars, never its issued parent's cursor. */
  public fork(): ExplanationDelivery { return Object.assign(Object.create(ExplanationDelivery.prototype), this); }

  /** Forks share their immutable selected-page identity; a replacement starts its own cursor. */
  public advancedSince(prior?: ExplanationDelivery): boolean {
    return this.completedWork > (prior?.cursorIdentity === this.cursorIdentity ? prior.completedWork : 0);
  }

  public matchesSource(forest: ReadonlyMap<string, Derivation> | readonly Derivation[] | undefined,
    support: readonly SupportRecord[] | undefined, revision?: string): boolean {
    return this.sourceRevision !== undefined || revision !== undefined
      ? this.sourceRevision !== undefined && this.sourceRevision === revision
      : this.sourceForest === forest && this.support === support;
  }

  public get deliveredPage(): readonly IndexEntry[] {
    return this.prepared.values().map(({ entry, roots }) => ({ ...entry, explanation_ids: roots.values() }));
  }

  public get explanations(): readonly Derivation[] { return this.capacityLimited ? [] : this.serialized.values(); }
  /** Final arrays visit each node and root and make the selected-page views. */
  public get materializationWork(): number { return this.serialized.length + this.roots.length + 3 * this.prepared.length; }

  public advance(allowance: number, memory: number): Readonly<{
    work: number; bytes: number; complete: boolean; invalid: boolean; capacity_limited: boolean;
  }> {
    let work = 0, bytes = 0;
    while (work < allowance && !this.invalid && !this.capacityLimited) {
      if (this.rowOffset < this.rows.length) {
        const row = this.rows[this.rowOffset]!;
        const cost = 128 + 2 * row.derivation_id.length;
        if (memory - bytes < cost) break;
        this.forest = (this.forest as PersistentStringMap<Derivation>).with(row.derivation_id, row);
        this.rowOffset++; work++; bytes += cost; continue;
      }
      if (this.supportOffset < (this.support?.length ?? 0)) {
        const witnesses = this.support![this.supportOffset]!.witnesses;
        const witness = witnesses[this.witnessOffset];
        if (witness === undefined) { this.supportOffset++; this.witnessOffset = 0; work++; continue; }
        const cost = 128 + 2 * witness.witness_id.length;
        if (memory - bytes < cost) break;
        if (!this.witnesses.has(witness.witness_id)) this.witnesses = this.witnesses.with(witness.witness_id, witness);
        this.witnessOffset++; work++; bytes += cost; continue;
      }
      if (this.selecting) {
        const entry = this.page[this.entryOffset];
        if (entry === undefined) { this.selecting = false; this.traced = this.roots.length === 0; continue; }
        const id = entry.explanation_ids[this.rootOffset];
        if (id === undefined) {
          if (memory - bytes < 96) break;
          this.prepared = this.prepared.append({ entry, roots: this.currentRoots });
          this.currentRoots = new RetainedRows(); this.entryOffset++; this.rootOffset = 0; work++; bytes += 96; continue;
        }
        if (memory - bytes < 128) break;
        const node = this.forest.get(id);
        if (node === undefined) { this.invalid = true; work++; continue; }
        const witness = node.witness_id === undefined ? undefined : this.witnesses.get(node.witness_id);
        const feasible = witness === undefined ? node.kind !== "leaf" || node.leaf_ids.length > 0
          : witness.complete && witness.cost <= this.pageBudget;
        if (feasible) { this.currentRoots = this.currentRoots.append(id); this.roots = this.roots.append(id); bytes += 128; }
        else this.omitted = true;
        this.rootOffset++; work++; continue;
      }
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
        this.serialized = this.serialized.append(node); work++; bytes += 8;
      }
    }
    this.completedWork += work;
    this.retainedBytes += bytes;
    return { work, bytes, complete: !this.selecting && this.traced && this.serialized.length === (this.traversal?.nodes.size ?? 0),
      invalid: this.invalid, capacity_limited: this.capacityLimited };
  }
}
