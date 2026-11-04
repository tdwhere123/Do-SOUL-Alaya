import { SourceSemanticResourceExhausted, type SourceSemanticResourceBudget,
  type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";

/** Per-root statement keys retained for association; the highest question similarities are kept. */
export const STATEMENT_ASSOCIATION_KEYS_PER_ROOT = 16;

/** Original-query observations over admitted roots. A root without an observed statement key sits at the
 * floor, -1, of both coordinates. Links store each symmetric pair once: link[i][j] for j < i. */
export type StatementAssociation = Readonly<{
  roots: readonly string[];
  /** Max cosine between the original query and the root's statement keys. */
  question: readonly number[];
  /** Max cosine between any statement keys of each pair of roots. */
  link: readonly (readonly number[])[];
}>;

type Retained = { cosine: number; embedding: Float32Array; norm: number };

function retentionBytes(dimensions: number): number { return dimensions * 4 + 48; }
function observationBytes(roots: number): number { return (roots + roots * (roots - 1) / 2) * 8; }
function linkAt(link: StatementAssociation["link"], i: number, j: number): number {
  return i === j ? -1 : i > j ? link[i]![j]! : link[j]![i]!;
}

/** The original conservative quote also funds the exact fallback. The optional bounded comparison
 * uses only spare capacity within it; reserving that capacity is not a debit. */
export function quoteStatementAssociation(roots: number, windows: number, dimensions: number): SourceSemanticResourceBudget {
  return { work_units: windows * dimensions
      + roots * roots * STATEMENT_ASSOCIATION_KEYS_PER_ROOT * STATEMENT_ASSOCIATION_KEYS_PER_ROOT * dimensions,
    memory_bytes: windows * retentionBytes(dimensions) + roots * (roots + 1) * 8 };
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

  /** Pairwise links over admitted roots; vectors and comparison scratch are released afterwards. */
  public associate(roots: readonly string[]): StatementAssociation | undefined {
    if (this.abandoned || !this.fund(0, observationBytes(roots.length), "statement key association link")) return undefined;
    const kept = roots.map(root => this.byRoot.get(root) ?? []);
    const question = kept.map(rows => rows.length === 0 ? -1 : rows[0]!.cosine);
    const link = roots.map((_, i) => Array<number>(i).fill(-1));
    const initialWork = this.meter.spentWork;
    let scratch = this.comparisonScratch(kept), denseWork = 0;
    for (let i = 0; i + 1 < roots.length; i++) {
      if (scratch !== undefined && kept[i]!.length > 0) {
        for (let a = 0; a < kept[i]!.length; a++) {
          if (!this.suffixSquares(kept[i]![a]!, scratch, a * 3)) return undefined;
        }
      }
      for (let j = i + 1; j < roots.length; j++) {
        let best = -1;
        if (scratch !== undefined && kept[i]!.length > 0) {
          for (let b = 0; b < kept[j]!.length; b++) {
            if (!this.suffixSquares(kept[j]![b]!, scratch, (STATEMENT_ASSOCIATION_KEYS_PER_ROOT + b) * 3)) return undefined;
          }
        }
        for (let a = 0; a < kept[i]!.length; a++) for (let b = 0; b < kept[j]!.length; b++) {
          const cosine = this.cosine(kept[i]![a]!, kept[j]![b]!, best, scratch, a * 3, b * 3);
          if (cosine === undefined) return undefined;
          if (cosine > best) best = cosine;
        }
        link[j]![i] = best;
        if (scratch !== undefined) {
          denseWork += kept[i]!.length * kept[j]!.length * (kept[i]![0]?.embedding.length ?? 0);
          // Uncorrelated keys can make the bound more expensive than a full dot product.
          // Stop preparing bounds if the work already spent has not paid for itself.
          if (denseWork > 0 && this.meter.spentWork - initialWork > denseWork) scratch = undefined;
        }
      }
    }
    this.byRoot.clear();
    return { roots: [...roots], question, link };
  }

  /** Preflight the whole optional optimization, leaving enough work for every worst-case dot product.
   * If it doesn't fit, the original exact loop still has its existing quote and refusal behavior. */
  private comparisonScratch(kept: readonly Retained[][]): Float64Array | undefined {
    const first = kept.find(rows => rows.length > 0)?.[0], dimensions = first?.embedding.length ?? 0;
    const roots = kept.length, cap = STATEMENT_ASSOCIATION_KEYS_PER_ROOT;
    if (dimensions < 4 || dimensions > 65536 || roots < 2) return undefined;
    const rootPairs = roots * (roots - 1) / 2;
    const comparisons = rootPairs * cap * cap, scans = (roots + rootPairs) * cap;
    const inspection = roots + roots * cap;
    const bytes = 2 * cap * 3 * 8 + 64;
    // This conservative preflight also covers the inspection itself. It never consumes the
    // full-comparison allowance when the optional path cannot be funded.
    try { this.meter.reserve(inspection + scans * dimensions + comparisons * (dimensions + 3), bytes,
      "statement key association bounds"); }
    catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      return undefined;
    }
    let keyedRoots = 0;
    for (const rows of kept) {
      this.meter.charge(1, 0, "statement key association bounds");
      if (rows.length > 0) keyedRoots++;
      for (const row of rows) {
        this.meter.charge(1, 0, "statement key association bounds");
        if (row.embedding.length !== dimensions || !Number.isFinite(row.norm)) return undefined;
      }
    }
    if (keyedRoots < 2) return undefined;
    this.meter.charge(0, bytes, "statement key association bounds");
    return new Float64Array(2 * cap * 3);
  }

  /** Three tail norms, reused for every comparison with this key. */
  private suffixSquares(row: Retained, scratch: Float64Array, offset: number): boolean {
    const vector = row.embedding, dimensions = vector.length;
    if (!this.fund(dimensions, 0, "statement key association bounds")) return false;
    let sum = 0, boundary = 2, next = Math.ceil(3 * dimensions / 4);
    for (let d = dimensions - 1; d >= 0; d--) {
      sum += vector[d]! * vector[d]!;
      if (boundary >= 0 && d === next) {
        scratch[offset + boundary--] = sum;
        next = Math.ceil((boundary + 1) * dimensions / 4);
      }
    }
    return true;
  }

  private cosine(a: Retained, b: Retained, best: number, scratch: Float64Array | undefined,
    leftOffset: number, rightOffset: number): number | undefined {
    if (scratch === undefined) {
      if (!this.fund(a.embedding.length, 0, "statement key association link")) return undefined;
      let dot = 0;
      for (let d = 0; d < a.embedding.length; d++) dot += a.embedding[d]! * b.embedding[d]!;
      return a.norm === 0 || b.norm === 0 ? -1 : dot / (a.norm * b.norm);
    }
    if (a.norm === 0 || b.norm === 0) return -1;
    const dimensions = a.embedding.length, denominator = a.norm * b.norm;
    // Float32 products are exactly representable in Float64, including their smallest and largest
    // finite values. This slack bounds rounding of the two tail sums, Cauchy bound, sequential
    // dot additions and final division, even after cancellation (dimensions <= 65536 in the index).
    const slack = 32 * (dimensions + 1) * Number.EPSILON;
    let dot = 0, start = 0;
    for (let block = 0; block < 4; block++) {
      const end = Math.ceil((block + 1) * dimensions / 4);
      if (!this.fund(end - start + (block < 3 ? 1 : 0), 0, "statement key association link")) return undefined;
      for (let d = start; d < end; d++) dot += a.embedding[d]! * b.embedding[d]!;
      start = end;
      if (block < 3) {
        const remainder = Math.sqrt(scratch[leftOffset + block]!
          * scratch[STATEMENT_ASSOCIATION_KEYS_PER_ROOT * 3 + rightOffset + block]!) * (1 + slack);
        const upper = (dot + remainder + (Math.abs(dot) + remainder) * slack) / denominator;
        if (upper + (Math.abs(upper) + 1) * slack < best) return -1;
      }
    }
    return dot / denominator;
  }
}

/** Keeps only the listed roots, in their association order. */
export function restrictStatementAssociation(association: StatementAssociation,
  keep: (root: string) => boolean): StatementAssociation {
  const indices = association.roots.flatMap((root, index) => keep(root) ? [index] : []);
  return { roots: indices.map(i => association.roots[i]!), question: indices.map(i => association.question[i]!),
    link: indices.map((i, row) => indices.slice(0, row).map(j => linkAt(association.link, i, j))) };
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
  const linkTo = (i: number) => Math.max(-1, ...others.map(o => linkAt(association.link, i, o)));
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
