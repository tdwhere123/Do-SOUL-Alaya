import { SourceSemanticResourceExhausted, type SourceSemanticResourceBudget,
  type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";

export const STATEMENT_ASSOCIATION_KEYS_PER_ROOT = 16;
type Retained = Readonly<{ cosine: number; embedding: Float32Array; norm: number }>;
type StatementKey = Readonly<{ embedding: readonly number[]; norm: number }>;

/** Query/snapshot-owned observations, never a global cache. Keys and every possible cache cell are
 * explicit retained data. Root remapping preserves their indices and key-set identity. Null is an
 * uncomputed link, -1 is a computed floor. Only the pair owner below writes the bounded cache. */
export type StatementAssociation = Readonly<{
  roots: readonly string[];
  question: readonly number[];
  keys: readonly (readonly StatementKey[])[];
  link: (number | null)[][];
  /** Once optional computation is refused it cannot silently retry for free on a later page. */
  refusal: { phase: number | null; swap_selected: boolean };
}>;

/** Internal diagnostics, never part of the retained association graph or its resource quote. */
export type StatementAssociationAvailability = Readonly<{
  status: "not_requested" | "ready" | "unavailable"; reason: string | null; roots?: number; keys?: number;
}>;
export type StatementAssociationRetentionObservation = Readonly<{
  stage: "source_retention" | "field_admission"; status: "retained" | "discarded" | "absent";
  reason: string | null; required_bytes: number | null; available_bytes: number; retained_bytes: number | null;
}>;

const refusalPhases = ["statement key association validation", "statement key association ordering",
  "statement key association lookup", "statement key association link"] as const;
export function refuseStatementAssociation(value: StatementAssociation, phase: string): void {
  const index = refusalPhases.indexOf(phase as typeof refusalPhases[number]);
  value.refusal.phase = index < 0 ? refusalPhases.length : index;
}
export function statementAssociationRefusalReason(value: StatementAssociation): string | null {
  return value.refusal.phase === null ? null : refusalPhases[value.refusal.phase] ?? "statement key association resource refusal";
}

const retentionBytes = (dimensions: number) => dimensions * 4 + 48;
const observationBytes = (roots: number) => (roots + roots * (roots - 1) / 2) * 8;

/** Includes conversion and conservative plain-data retention. Pair work is paid by navigation only
 * when requested, after scope, source order and time preference are known. */
export function quoteStatementAssociation(roots: number, windows: number, dimensions: number): SourceSemanticResourceBudget {
  const retainedKeys = Math.min(windows, roots * STATEMENT_ASSOCIATION_KEYS_PER_ROOT);
  return { work_units: windows * dimensions + retainedKeys * (dimensions * 2 + 16) + roots * roots,
    memory_bytes: windows * retentionBytes(dimensions) + retainedKeys * (dimensions * 80 + 1024)
      + roots * roots * 128 + 4096 };
}

/** Optional retention cannot cancel the underlying scan or nomination. */
export class StatementKeyRetention {
  private readonly byRoot = new Map<string, Retained[]>();
  private abandoned = false;
  private dimensions: number | undefined;
  private observed: StatementAssociationAvailability = { status: "unavailable", reason: "association_capture_not_reached" };

  public availability(): StatementAssociationAvailability { return { ...this.observed }; }

  public constructor(private readonly meter: SourceSemanticResourceLedger,
    private readonly refused: (phase: string) => void) {}

  public consider(root: string, cosine: number, embedding: Float32Array): void {
    if (this.abandoned) return;
    if (!Number.isFinite(cosine) || this.dimensions !== undefined && embedding.length !== this.dimensions) {
      this.abandon("statement key association incompatible dimensions"); return;
    }
    const kept = this.byRoot.get(root) ?? [];
    if (kept.length === STATEMENT_ASSOCIATION_KEYS_PER_ROOT && kept.at(-1)!.cosine >= cosine) return;
    if (!this.fund(embedding.length, retentionBytes(embedding.length), "statement key association retention")) return;
    let norm = 0;
    for (const value of embedding) norm += value * value;
    if (!Number.isFinite(norm)) { this.abandon("statement key association invalid vector"); return; }
    this.dimensions ??= embedding.length;
    const row = { cosine, embedding: embedding.slice(), norm: Math.sqrt(norm) };
    const at = kept.findIndex(other => other.cosine < cosine);
    kept.splice(at === -1 ? kept.length : at, 0, row);
    if (kept.length > STATEMENT_ASSOCIATION_KEYS_PER_ROOT) kept.pop();
    this.byRoot.set(root, kept);
  }

  private abandon(phase: string): void {
    if (this.abandoned) return;
    this.observed = { status: "unavailable", reason: phase };
    this.abandoned = true; this.byRoot.clear(); this.refused(phase);
  }

  private fund(work: number, bytes: number, phase: string): boolean {
    try { this.meter.charge(work, bytes, phase); return true; }
    catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      this.abandon(phase); return false;
    }
  }

  /** No pair is evaluated before the consumer knows source order. Plain vectors keep the complete
   * retained graph visible to nomination and continuation resource owners. */
  public associate(roots: readonly string[]): StatementAssociation | undefined {
    if (this.abandoned) return undefined;
    let dimensions = 0, keyCount = 0;
    for (const root of roots) for (const row of this.byRoot.get(root) ?? []) { dimensions += row.embedding.length; keyCount++; }
    if (!this.fund(dimensions + roots.length, dimensions * 8 + keyCount * 128 + roots.length * 128 + observationBytes(roots.length),
      "statement key association capture")) return undefined;
    const kept = roots.map(root => this.byRoot.get(root) ?? []);
    const result: StatementAssociation = { roots: [...roots], question: kept.map(rows => rows[0]?.cosine ?? -1),
      keys: kept.map(rows => rows.map(row => ({ embedding: Array.from(row.embedding), norm: row.norm }))),
      link: roots.map((_, i) => Array<number | null>(i).fill(null)), refusal: { phase: null, swap_selected: false } };
    this.observed = { status: "ready", reason: null, roots: roots.length, keys: keyCount };
    this.byRoot.clear();
    return result;
  }
}

/** One exact symmetric-pair authority. Charge before comparisons; cache capacity was retained at
 * capture. Repeated navigation pays lookup work but never recomputes a completed pair. */
export function statementAssociationLink(value: StatementAssociation, left: number, right: number,
  meter: SourceSemanticResourceLedger): number {
  meter.charge(1, 0, "statement key association lookup");
  if (left === right) return -1;
  const i = Math.min(left, right), j = Math.max(left, right);
  const cached = value.link[j]![i];
  if (cached !== null) return cached!;
  const first = value.keys[i]!, second = value.keys[j]!;
  const work = first.reduce((sum, key) => sum + key.embedding.length * second.length, 0);
  meter.charge(work, 0, "statement key association link");
  let best = -1;
  for (const a of first) for (const b of second) {
    if (a.embedding.length !== b.embedding.length) throw new TypeError("statement association dimensions differ");
    let dot = 0;
    for (let d = 0; d < a.embedding.length; d++) dot += a.embedding[d]! * b.embedding[d]!;
    const cosine = a.norm === 0 || b.norm === 0 ? -1 : dot / (a.norm * b.norm);
    if (cosine > best) best = cosine;
  }
  value.link[j]![i] = best;
  return best;
}

/** Membership filtering retains only the corresponding vectors and cached pairs. */
export function restrictStatementAssociation(association: StatementAssociation,
  keep: (root: string) => boolean): StatementAssociation {
  const indices = association.roots.flatMap((root, index) => keep(root) ? [index] : []);
  return { roots: indices.map(i => association.roots[i]!), question: indices.map(i => association.question[i]!),
    keys: indices.map(i => association.keys[i]!), refusal: association.refusal,
    link: indices.map((i, row) => indices.slice(0, row).map(j => association.link[Math.max(i, j)]![Math.min(i, j)]!)) };
}

/** A limited source-slot heuristic, not proof of complementary evidence or mixed-cutoff gain.
 * Keep four source roots, then swap slot five with the earliest two-coordinate dominator. */
export function preferAssociatedSlot(order: readonly string[], association: StatementAssociation,
  meter: SourceSemanticResourceLedger): readonly string[] {
  if (order.length < 6 || association.refusal.phase !== null) return order;
  try {
    meter.charge(order.length + association.roots.length, (order.length + association.roots.length) * 16,
      "statement key association ordering");
    const out = [...order];
    const index = new Map(association.roots.map((root, i) => [root, i]));
    const slot = index.get(out[4]!);
    if (slot === undefined) return out;
    const others = out.slice(0, 4).flatMap(root => index.has(root) ? [index.get(root)!] : []);
    const linkTo = (i: number) => Math.max(-1, ...others.map(o => statementAssociationLink(association, i, o, meter)));
    const slotQuestion = association.question[slot]!, slotLink = linkTo(slot);
    for (let position = 5; position < out.length; position++) {
      const candidate = index.get(out[position]!);
      if (candidate === undefined) continue;
      const question = association.question[candidate]!;
      // A lower question coordinate cannot dominate, so its links are not demanded.
      if (question < slotQuestion) continue;
      const link = linkTo(candidate);
      if (link >= slotLink && (question > slotQuestion || link > slotLink)) {
        association.refusal.swap_selected = true;
        [out[4], out[position]] = [out[position]!, out[4]!]; return out;
      }
    }
    return out;
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    // A later small page must not replace an already selected permutation with baseline order.
    // Links remain cached, but inspecting a changed order still requires its own funded work.
    if (association.refusal.swap_selected) throw error;
    refuseStatementAssociation(association, error.phase);
  }
  return order;
}
