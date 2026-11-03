import { SourceSemanticResourceExhausted, type SourceSemanticResourceBudget,
  type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";

/** Per-root statement keys retained for association; the highest question similarities are kept. */
export const STATEMENT_ASSOCIATION_KEYS_PER_ROOT = 16;

/** Original-query observations over admitted roots. A root without an observed statement key sits at the
 * floor, -1, of both coordinates. Two separate coordinates, never combined into one score. */
export type StatementAssociation = Readonly<{
  roots: readonly string[];
  /** Max cosine between the original query and the root's statement keys. */
  question: readonly number[];
  /** Max cosine between any statement key of root i and any of root j; symmetric, diagonal -1. */
  link: readonly (readonly number[])[];
}>;

type Retained = { cosine: number; embedding: Float32Array; norm: number };

function retentionBytes(dimensions: number): number { return dimensions * 4 + 48; }
function observationBytes(roots: number): number { return roots * (roots + 1) * 8; }

/** Worst case of retaining every inspected window and linking every admitted root pair. */
export function quoteStatementAssociation(roots: number, windows: number, dimensions: number): SourceSemanticResourceBudget {
  return { work_units: windows * dimensions
      + roots * roots * STATEMENT_ASSOCIATION_KEYS_PER_ROOT * STATEMENT_ASSOCIATION_KEYS_PER_ROOT * dimensions,
    memory_bytes: windows * retentionBytes(dimensions) + observationBytes(roots) };
}

/** Bounded retention of statement-key vectors seen by the vector scan, keyed by native root.
 * An unfunded charge abandons the association and reports its phase once; it never interrupts the scan
 * or nomination. */
export class StatementKeyRetention {
  private readonly byRoot = new Map<string, Retained[]>();
  private abandoned = false;

  public constructor(private readonly meter: SourceSemanticResourceLedger,
    private readonly refused: (phase: string) => void) {}

  public consider(root: string, cosine: number, embedding: Float32Array): void {
    if (this.abandoned) return;
    const kept = this.byRoot.get(root) ?? [];
    if (kept.length === STATEMENT_ASSOCIATION_KEYS_PER_ROOT && kept.at(-1)!.cosine >= cosine) return;
    if (!this.fund(embedding.length, retentionBytes(embedding.length), "statement key association retention")) return;
    let norm = 0;
    for (const value of embedding) norm += value * value;
    const row = { cosine, embedding: embedding.slice(), norm: Math.sqrt(norm) };
    const at = kept.findIndex(other => other.cosine < cosine);
    kept.splice(at === -1 ? kept.length : at, 0, row);
    if (kept.length > STATEMENT_ASSOCIATION_KEYS_PER_ROOT) kept.pop();
    this.byRoot.set(root, kept);
  }

  private fund(work: number, bytes: number, phase: string): boolean {
    try { this.meter.charge(work, bytes, phase); return true; }
    catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      this.abandoned = true; this.byRoot.clear(); this.refused(phase); return false;
    }
  }

  /** Pairwise links over the admitted roots only; vectors are released afterwards. */
  public associate(roots: readonly string[]): StatementAssociation | undefined {
    if (this.abandoned || !this.fund(0, observationBytes(roots.length), "statement key association link")) return undefined;
    const kept = roots.map(root => this.byRoot.get(root) ?? []);
    const question = kept.map(rows => rows.length === 0 ? -1 : rows[0]!.cosine);
    const link = roots.map(() => roots.map(() => -1));
    for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
      let best = -1;
      for (const a of kept[i]!) for (const b of kept[j]!) {
        if (!this.fund(a.embedding.length, 0, "statement key association link")) return undefined;
        let dot = 0;
        for (let d = 0; d < a.embedding.length; d++) dot += a.embedding[d]! * b.embedding[d]!;
        const cosine = a.norm === 0 || b.norm === 0 ? -1 : dot / (a.norm * b.norm);
        if (cosine > best) best = cosine;
      }
      link[i]![j] = best; link[j]![i] = best;
    }
    this.byRoot.clear();
    return { roots: [...roots], question, link };
  }
}

/** Keeps only the listed roots, in their association order. */
export function restrictStatementAssociation(association: StatementAssociation,
  keep: (root: string) => boolean): StatementAssociation {
  const indices = association.roots.flatMap((root, index) => keep(root) ? [index] : []);
  return { roots: indices.map(i => association.roots[i]!), question: indices.map(i => association.question[i]!),
    link: indices.map(i => indices.map(j => association.link[i]![j]!)) };
}

/** Slot 5 of the source order yields only to a later root that dominates it on both coordinates: question
 * similarity and link to slots 1–4. Among dominating roots the earliest in access order wins; the two swap.
 * A keyless root is at the floor, so it never displaces slot 5 and, at slot 5, yields to any later keyed root.
 * Roots outside the association never move. */
export function preferAssociatedSlot(order: readonly string[], association: StatementAssociation): string[] {
  const out = [...order];
  if (out.length < 6) return out;
  const index = new Map(association.roots.map((root, i) => [root, i]));
  const at = (root: string) => index.get(root);
  const slot = at(out[4]!);
  if (slot === undefined) return out;
  const others = out.slice(0, 4).map(at).filter((i): i is number => i !== undefined);
  const linkTo = (i: number) => Math.max(-1, ...others.map(o => association.link[i]![o]!));
  const slotQuestion = association.question[slot]!, slotLink = linkTo(slot);
  for (let position = 5; position < out.length; position++) {
    const candidate = at(out[position]!);
    if (candidate === undefined) continue;
    const question = association.question[candidate]!, link = linkTo(candidate);
    if (question >= slotQuestion && link >= slotLink && (question > slotQuestion || link > slotLink)) {
      [out[4], out[position]] = [out[position]!, out[4]!];
      return out;
    }
  }
  return out;
}
