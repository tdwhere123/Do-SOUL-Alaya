import { sourceIndexNativeRootKey, SourceSemanticResourceExhausted, type SourceIndexLexicalCandidate,
  type SourceIndexQueryVector, type SourceSemanticResourceBudget, type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { sourceEmbeddingInputDigest } from "../embedding-recall/source-embedding-runtime.js";

/** A statement key reaches its raw root once per lexical lane, like a best vector window. */
export function collapseStatementCandidates(candidates: readonly SourceIndexLexicalCandidate[],
  meter: SourceSemanticResourceLedger): readonly SourceIndexLexicalCandidate[] {
  if (!candidates.some(row => row.source.auxiliary !== undefined)) return candidates;
  meter.charge(candidates.length, 0, "statement candidate collapse");
  const seen = new Set<string>();
  return candidates.filter(row => row.source.auxiliary === undefined ||
    seen.size < seen.add(`${row.lexical.lane}\0${sourceIndexNativeRootKey(row.source)}`).size);
}

export const STATEMENT_ASSOCIATION_KEYS_PER_ROOT = 16;
type Retained = Readonly<{ cosine: number; embedding: Float32Array }>;

/** Evidence statement vectors bound to the admitted proposal. Not supplied and unavailable stay distinct. */
export type EvidenceDemands = Readonly<{ status: "ready"; vectors: readonly Float32Array[] }>
  | Readonly<{ status: "not_supplied" | "unavailable"; reason: string }>;

/** Query/snapshot-owned evidence coverage: per root, each statement's best cosine over that root's
 * retained statement keys (null: no key). Only the field ordering decision mutates `decision`. */
export type StatementAssociation = Readonly<{
  roots: readonly string[];
  statements: number;
  coverage: readonly (readonly (number | null)[])[];
  /** A refused permutation never retries for free; an applied one is never silently undone on a later page. */
  decision: { refused: string | null; applied: boolean };
}>;

/** Internal diagnostics, never part of the retained association graph or its resource quote. */
export type StatementAssociationAvailability = Readonly<{
  status: "not_requested" | "ready" | "unavailable"; reason: string | null; roots?: number; keys?: number; statements?: number;
}>;
export type StatementAssociationRetentionObservation = Readonly<{
  stage: "source_retention" | "field_admission"; status: "retained" | "discarded" | "absent";
  reason: string | null; required_bytes: number | null; available_bytes: number; retained_bytes: number | null;
}>;

const retentionBytes = (dimensions: number) => dimensions * 4 + 48;

/** Includes key capture and a conservative retained-graph bound. Statement scoring is
 * charged on the same acquisition ledger when evidence statements are supplied. */
export function quoteStatementAssociation(roots: number, windows: number, dimensions: number): SourceSemanticResourceBudget {
  const retainedKeys = Math.min(windows, roots * STATEMENT_ASSOCIATION_KEYS_PER_ROOT);
  return { work_units: windows * dimensions + retainedKeys * (dimensions * 2 + 16) + roots * roots,
    memory_bytes: windows * retentionBytes(dimensions) + retainedKeys * (dimensions * 80 + 1024)
      + roots * roots * 128 + 4096 };
}

/** Exact statement scoring over retained keys plus the retained per-root coverage frame. */
function coverageCost(keyDimensions: number, demandDimensions: number, roots: number, statements: number): SourceSemanticResourceBudget {
  return { work_units: keyDimensions * statements + demandDimensions + roots * statements,
    memory_bytes: demandDimensions * 4 + roots * (64 + statements * 72) };
}

/** Prepared statement vectors serve only the exact admitted texts under the query's profile. */
export function bindEvidenceDemands(statements: readonly string[] | undefined,
  prepared: readonly Readonly<{ vector: SourceIndexQueryVector }>[] | undefined, query: SourceIndexQueryVector): EvidenceDemands {
  if (statements === undefined) return { status: "not_supplied", reason: "evidence_statements_not_supplied" };
  if (prepared === undefined || prepared.length !== statements.length) {
    return { status: "unavailable", reason: "evidence_statement_preparation_absent" };
  }
  const vectors: Float32Array[] = [];
  for (const [index, route] of prepared.entries()) {
    const vector = route.vector;
    if (vector.status !== "available") return { status: "unavailable", reason: vector.reason };
    if (vector.input_digest !== sourceEmbeddingInputDigest(statements[index]!)
      || query.status === "available" && vector.profile_id !== query.profile_id) {
      return { status: "unavailable", reason: "evidence_statement_preparation_mismatch" };
    }
    vectors.push(vector.embedding);
  }
  return { status: "ready", vectors };
}

/** Same arithmetic as the declared offline rule: one left-to-right Float64 pass over Float32 values. */
function cosine(key: Float32Array, demand: Float32Array): number {
  let dot = 0, keyNorm = 0, demandNorm = 0;
  for (let i = 0; i < key.length; i++) {
    const a = key[i]!, b = demand[i]!;
    dot += a * b; keyNorm += a * a; demandNorm += b * b;
  }
  return dot / Math.sqrt(keyNorm * demandNorm);
}

/** Optional retention cannot cancel the underlying scan or nomination. */
export class StatementKeyRetention {
  private readonly byRoot = new Map<string, Retained[]>();
  private abandoned = false;
  private dimensions: number | undefined;
  private retainedKeyCount = 0;
  private observed: StatementAssociationAvailability = { status: "unavailable", reason: "association_capture_not_reached" };

  public availability(): StatementAssociationAvailability { return { ...this.observed }; }

  public constructor(private readonly meter: SourceSemanticResourceLedger,
    private readonly refused: (phase: string) => void, private readonly demands: EvidenceDemands) {}

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
    const row = { cosine, embedding: embedding.slice() };
    const at = kept.findIndex(other => other.cosine < cosine);
    if (kept.length < STATEMENT_ASSOCIATION_KEYS_PER_ROOT) this.retainedKeyCount++;
    kept.splice(at === -1 ? kept.length : at, 0, row);
    if (kept.length > STATEMENT_ASSOCIATION_KEYS_PER_ROOT) kept.pop();
    this.byRoot.set(root, kept);
  }

  /** Numeric conservative protection for any final root membership, before optional reads.
   * It includes key capture, statement scoring and retained coverage without traversing vectors. */
  public finalizationProtection(roots: number, rootCharacters: number): SourceSemanticResourceBudget {
    if (this.abandoned) return { work_units: 0, memory_bytes: 0 };
    const keys = Math.min(this.retainedKeyCount, roots * STATEMENT_ASSOCIATION_KEYS_PER_ROOT), dimensions = this.dimensions ?? 0;
    const cost = quoteStatementAssociation(roots, keys, dimensions);
    const vectors = this.demands.status === "ready" ? this.demands.vectors : [];
    const scoring = coverageCost(keys * dimensions, vectors.reduce((sum, vector) => sum + vector.length, 0), roots, vectors.length);
    return { work_units: cost.work_units + scoring.work_units, memory_bytes: cost.memory_bytes + scoring.memory_bytes + rootCharacters * 4 };
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

  /** Keys are consumed here: only per-root statement coverage leaves acquisition. */
  public associate(roots: readonly string[]): StatementAssociation | undefined {
    if (this.abandoned) return undefined;
    let dimensions = 0, keyCount = 0;
    for (const root of roots) for (const row of this.byRoot.get(root) ?? []) { dimensions += row.embedding.length; keyCount++; }
    const counts = { roots: roots.length, keys: keyCount };
    const demands = this.demands;
    if (demands.status !== "ready" || demands.vectors.length === 0) {
      this.observed = demands.status === "ready" ? { status: "unavailable", reason: "evidence_statements_empty", ...counts }
        : { status: demands.status === "not_supplied" ? "not_requested" : "unavailable", reason: demands.reason, ...counts };
      this.byRoot.clear(); return undefined;
    }
    const statements = demands.vectors.length;
    const demandDimensions = demands.vectors.reduce((sum, vector) => sum + vector.length, 0);
    const cost = coverageCost(dimensions, demandDimensions, roots.length, statements);
    if (!this.fund(cost.work_units, cost.memory_bytes, "statement key evidence coverage")) return undefined;
    if (demands.vectors.some(vector => vector.length !== (this.dimensions ?? vector.length) || vector.some(v => !Number.isFinite(v)))) {
      this.abandon("statement key association incompatible dimensions"); return undefined;
    }
    const coverage = roots.map(root => {
      const kept = this.byRoot.get(root) ?? [];
      return demands.vectors.map(vector => {
        let best: number | null = null;
        for (const key of kept) {
          const value = cosine(key.embedding, vector);
          if (value > (best ?? -Infinity)) best = value;
        }
        return best;
      });
    });
    this.observed = { status: "ready", reason: null, ...counts, statements };
    this.byRoot.clear();
    return { roots: [...roots], statements, coverage, decision: { refused: null, applied: false } };
  }
}

/** Membership filtering keeps each retained root's coverage and the shared decision state. */
export function restrictStatementAssociation(association: StatementAssociation,
  keep: (root: string) => boolean): StatementAssociation {
  const indices = association.roots.flatMap((root, index) => keep(root) ? [index] : []);
  return { roots: indices.map(i => association.roots[i]!), statements: association.statements,
    coverage: indices.map(i => association.coverage[i]!), decision: association.decision };
}

export type EvidenceCoverageInjection = Readonly<{ statement: number; root_position: number }
  & ({ status: "injected"; slot: number } | { status: "no_free_slot" })>;

/** Each statement's top root (best coverage; ties to the earlier source position) enters the first
 * five in place of the last slot 5..2 root that tops no statement; all other roots keep base order,
 * so displaced roots follow at slot 6. Slot 1 and membership are fixed.
 * A selected slot heuristic, not proof that the injected root answers the statement. */
export function preferEvidenceCoverage(order: readonly string[], association: StatementAssociation,
  meter: SourceSemanticResourceLedger) {
  const statements = association.statements;
  meter.charge(order.length * (statements + 2), order.length * 16 + statements * 128, "evidence statement coverage ordering");
  const index = new Map(association.roots.map((root, i) => [root, i]));
  const tops = Array.from({ length: statements }, (_, statement) => {
    let top: number | null = null, best = -Infinity;
    order.forEach((root, position) => {
      const row = index.get(root), value = row === undefined ? null : association.coverage[row]![statement]!;
      if (value !== null && value > best) { top = position; best = value; }
    });
    return top;
  });
  const serving = new Set(tops.flatMap(top => top === null ? [] : [order[top]!]));
  const head = Math.min(5, order.length), out = order.slice(0, head), injections: EvidenceCoverageInjection[] = [];
  tops.forEach((top, statement) => {
    if (top === null) return;
    const root = order[top]!;
    if (out.includes(root)) return;
    let slot = -1;
    for (let position = head - 1; position >= 1; position--) if (!serving.has(out[position]!)) { slot = position; break; }
    if (slot < 0) { injections.push({ statement, root_position: top + 1, status: "no_free_slot" }); return; }
    out[slot] = root;
    injections.push({ statement, root_position: top + 1, status: "injected", slot: slot + 1 });
  });
  const chosen = new Set(out);
  return { order: [...out, ...order.filter(root => !chosen.has(root))],
    top_positions: tops.map(top => top === null ? null : top + 1), injections };
}
