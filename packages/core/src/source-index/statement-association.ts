import { statementEventIntervals } from "@do-soul/alaya-graph-algorithms";
import { sourceIndexNativeRootKey, SourceSemanticResourceExhausted, type EvidenceCondition, type QuestionTimePreference,
  type SourceIndexLexicalCandidate, type SourceIndexQueryVector, type SourceIndexStatementWitnessRead, type SourceIndexTarget,
  type SourceSemanticResourceBudget, type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
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
// The key target is the scanned page's object, kept by reference.
type Retained = Readonly<{ cosine: number; embedding: Float32Array; key: SourceIndexTarget }>;

/** Evidence condition vectors bound to the admitted proposal. Not supplied and unavailable stay distinct. */
export type EvidenceDemands = Readonly<{ status: "ready"; vectors: readonly Float32Array[]; conditions: readonly EvidenceCondition[];
  derived?: boolean }>
  | Readonly<{ status: "not_supplied" | "unavailable"; reason: string }>;

/** Reads the host role and anchor tokens of one root's retained keys, charging the acquisition ledger. */
export type StatementWitnessReader = (keys: readonly SourceIndexTarget[], anchors: readonly string[]) => SourceIndexStatementWitnessRead | undefined;

/** Question window as UTC civil-day bounds: alternatives starting on or before the question clock. */
export type EvidenceWindow = Readonly<{ intervals: readonly (readonly [number, number])[]; earliest: number }>;

const civilDay = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

export function evidenceWindow(preference: QuestionTimePreference | undefined): EvidenceWindow | undefined {
  if (preference === undefined) return undefined;
  const clock = preference.interpretation_clock.slice(0, 10);
  const intervals = preference.intervals.filter(window => window.start <= clock)
    .map(window => [civilDay(window.start), civilDay(window.end)] as const);
  return intervals.length === 0 ? undefined : { intervals, earliest: Math.min(...intervals.map(([start]) => start)) };
}

/** Time dimension of one key: a stated event day inside the window satisfies, stated days all outside violate;
 * with none stated, a session before the window violates (a reported event precedes its session), else unknown. */
function keyTime(statement: string, session: number | null, window: EvidenceWindow): "satisfied" | "violated" | "unknown" {
  if (session === null) return "unknown";
  const days = statementEventIntervals(statement, session);
  if (days.length > 0) return days.some(span => window.intervals.some(([from, to]) => span.startDay <= to && span.endDay >= from))
    ? "satisfied" : "violated";
  return session < window.earliest ? "violated" : "unknown";
}

/** Query/snapshot-owned witness matrix. Per root and condition, `coverage` is the best cosine over the
 * root's retained keys that necessarily witness it (every dimension satisfied; null: none); under a question
 * window, `possible` marks roots with a key whose only open dimension is time, or with no retained key.
 * Only the field ordering decision mutates `decision`. */
export type StatementAssociation = Readonly<{
  roots: readonly string[];
  statements: number;
  coverage: readonly (readonly (number | null)[])[];
  possible?: readonly (readonly boolean[])[];
  /** Derived relation only: per cell, the host-message span of the key behind the necessary value. */
  spans?: readonly (readonly (readonly [number, number] | null)[])[];
  /** Per root, its best necessary cell's host-message span: delivery opens there (null: no necessary cell). */
  openings?: readonly (EvidenceOpening | null)[];
  /** A refused permutation never retries for free; an applied one is never silently undone on a later page. */
  decision: { refused: string | null; applied: boolean };
}>;

export type EvidenceOpening = Readonly<{ statement: number; span: readonly [number, number] }>;

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
// A retained span cell is one array node and two integers; each root keeps one opening.
function coverageCost(keyDimensions: number, demandDimensions: number, roots: number, statements: number,
  spans = false): SourceSemanticResourceBudget {
  return { work_units: keyDimensions * statements + demandDimensions + roots * (statements * (spans ? 2 : 1) + 1),
    memory_bytes: demandDimensions * 4 + roots * (64 + 96 + statements * (spans ? 72 + 192 : 72) + (spans ? 64 : 0)) };
}

/** Prepared statement vectors serve only the exact admitted condition texts under the query's profile. */
export function bindEvidenceDemands(conditions: readonly EvidenceCondition[] | undefined,
  prepared: readonly Readonly<{ vector: SourceIndexQueryVector }>[] | undefined, query: SourceIndexQueryVector,
  relation?: "derived"): EvidenceDemands {
  if (conditions === undefined) return { status: "not_supplied", reason: "evidence_conditions_not_supplied" };
  const statements = conditions.map(condition => condition.statement);
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
  return { status: "ready", vectors, conditions, ...(relation === "derived" ? { derived: true } : {}) };
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

  public consider(root: string, cosine: number, embedding: Float32Array, key: SourceIndexTarget): void {
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
    const row = { cosine, embedding: embedding.slice(), key };
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
    const scoring = coverageCost(keys * dimensions, vectors.reduce((sum, vector) => sum + vector.length, 0), roots, vectors.length,
      this.demands.status === "ready" && this.demands.derived === true);
    return { work_units: cost.work_units + scoring.work_units, memory_bytes: cost.memory_bytes + scoring.memory_bytes + rootCharacters * 4 };
  }

  private abandon(phase: string, refusal = true): void {
    if (this.abandoned) return;
    this.observed = { status: "unavailable", reason: phase };
    this.abandoned = true; this.byRoot.clear();
    if (refusal) this.refused(phase);
  }

  private fund(work: number, bytes: number, phase: string): boolean {
    try { this.meter.charge(work, bytes, phase); return true; }
    catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      this.abandon(phase); return false;
    }
  }

  /** Keys are consumed here: only the per-root witness matrix leaves acquisition. A key witnesses a
   * condition only if its message has the condition's speaker and, when anchors exist, one anchor's
   * tokens all occur in it; under a window its time dimension must hold (unknown: possible). Any
   * unknown witness read leaves the whole association unavailable. */
  public associate(roots: readonly string[], witnesses: StatementWitnessReader | undefined,
    window?: EvidenceWindow): StatementAssociation | undefined {
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
    const cost = coverageCost(dimensions, demandDimensions, roots.length, statements, demands.derived === true);
    if (!this.fund(cost.work_units, cost.memory_bytes, "statement key evidence coverage")) return undefined;
    if (demands.vectors.some(vector => vector.length !== (this.dimensions ?? vector.length) || vector.some(v => !Number.isFinite(v)))) {
      this.abandon("statement key association incompatible dimensions"); return undefined;
    }
    const anchors = [...new Set(demands.conditions.flatMap(condition => condition.anchors))];
    const anchorIndex = new Map(anchors.map((anchor, index) => [anchor, index]));
    const coverage: (number | null)[][] = [], possible: boolean[][] = [], spans: ((readonly [number, number]) | null)[][] = [];
    const openings: (EvidenceOpening | null)[] = [];
    for (const root of roots) {
      const kept = this.byRoot.get(root) ?? [];
      const read = kept.length === 0 ? undefined : witnesses?.(kept.map(row => row.key), anchors);
      if (kept.length > 0 && (read === undefined || read.status !== "ready" || read.witnesses.length !== kept.length)) {
        const reason = read === undefined ? "statement_witness_reader_absent" : read.status === "ready" ? "statement_witness_misaligned" : read.reason;
        this.abandon(reason, reason.startsWith("statement_witness_read_budget")); return undefined;
      }
      const facts = read?.status === "ready" ? read.witnesses : [];
      const session = read?.status === "ready" && read.session_time !== null ? civilDay(read.session_time) : null;
      let times: readonly ("satisfied" | "violated" | "unknown")[] | undefined;
      if (window !== undefined) {
        const characters = facts.reduce((sum, fact) => sum + fact.statement.length, 0);
        if (!this.fund(characters + facts.length, 8 * characters + 64, "statement key event time")) return undefined;
        times = facts.map(fact => keyTime(fact.statement, session, window));
      }
      const open = Array<boolean>(statements).fill(window !== undefined && kept.length === 0);
      const cells: ((readonly [number, number]) | null)[] = [];
      coverage.push(demands.vectors.map((vector, index) => {
        const condition = demands.conditions[index]!;
        let best: number | null = null, span: (readonly [number, number]) | null = null;
        kept.forEach((key, position) => {
          const fact = facts[position]!, time = times?.[position] ?? "satisfied";
          if (fact.role !== condition.speaker || condition.anchors.length > 0
            && !condition.anchors.some(anchor => fact.anchors[anchorIndex.get(anchor)!] === true) || time === "violated") return;
          if (time === "unknown") { open[index] = true; return; }
          const value = cosine(key.embedding, vector);
          if (value > (best ?? -Infinity)) { best = value; span = key.key.auxiliary === undefined ? null : [...key.key.auxiliary.source_span]; }
        });
        cells.push(span);
        return best;
      }));
      possible.push(open); spans.push(cells);
      const row = coverage.at(-1)!;
      let top = -1;
      row.forEach((value, index) => { if (value !== null && cells[index] !== null && (top < 0 || value > row[top]!)) top = index; });
      openings.push(top < 0 ? null : { statement: top, span: cells[top]! });
    }
    this.observed = { status: "ready", reason: null, ...counts, statements };
    this.byRoot.clear();
    return { roots: [...roots], statements, coverage, ...(window === undefined ? {} : { possible }),
      ...(demands.derived === true ? { spans } : {}), openings, decision: { refused: null, applied: false } };
  }
}

/** Membership filtering keeps each retained root's coverage and the shared decision state. */
export function restrictStatementAssociation(association: StatementAssociation,
  keep: (root: string) => boolean): StatementAssociation {
  const indices = association.roots.flatMap((root, index) => keep(root) ? [index] : []);
  return { roots: indices.map(i => association.roots[i]!), statements: association.statements,
    coverage: indices.map(i => association.coverage[i]!),
    ...(association.possible === undefined ? {} : { possible: indices.map(i => association.possible![i]!) }),
    ...(association.spans === undefined ? {} : { spans: indices.map(i => association.spans![i]!) }),
    ...(association.openings === undefined ? {} : { openings: indices.map(i => association.openings![i]!) }),
    decision: association.decision };
}

/** Another instance of a placed condition, delivered as its witness message after the first five. */
export type EvidenceWitnessVariant = Readonly<{ root: string; statement: number; root_position: number;
  support_span: Readonly<{ start_byte: number; end_byte: number }> }>;

export type EvidenceCoverageInjection = Readonly<{ statement: number; root_position: number }
  & ({ status: "injected"; slot: number } | { status: "no_free_slot" })>;

/** One selection over the witness matrix, lexicographic over conditions: first the conditions whose top
 * (best-scoring necessary witness; ties to the earlier position) is in the first five, then the conditions
 * with any necessary or possible witness there, then source order. Each condition in order whose top lies
 * outside the first five replaces the slot 5..2 that maximizes that pair (ties: the lowest slot), only if it
 * strictly improves. Slot 1 and membership are fixed; displaced roots follow the first five in source order.
 * Under a derived relation, each placed top's condition then brings its rank 2-5 witnesses from roots outside the first
 * five, in condition and rank order, delivered as their witness messages; nothing in the first five moves.
 * A selection over observed witnesses, not proof that the injected root answers the condition. */
export function selectEvidenceWitnesses(order: readonly string[], association: StatementAssociation,
  meter: SourceSemanticResourceLedger) {
  const statements = association.statements, head = Math.min(5, order.length);
  meter.charge(order.length * (statements + 2) + 4 * statements * statements * head,
    order.length * 16 + statements * 128, "evidence witness selection");
  const index = new Map(association.roots.map((root, i) => [root, i]));
  const necessary = (root: string, statement: number) => {
    const row = index.get(root); return row === undefined ? null : association.coverage[row]![statement]!;
  };
  const witnessed = (root: string, statement: number) => necessary(root, statement) !== null
    || association.possible?.[index.get(root) ?? -1]?.[statement] === true;
  const tops = Array.from({ length: statements }, (_, statement) => {
    let top: number | null = null, best = -Infinity;
    order.forEach((root, position) => {
      const value = necessary(root, statement);
      if (value !== null && value > best) { top = position; best = value; }
    });
    return top;
  });
  const topRoots = tops.flatMap(top => top === null ? [] : [order[top]!]);
  const objective = (first: readonly string[]) => [topRoots.filter(root => first.includes(root)).length,
    Array.from({ length: statements }, (_, statement) => first.some(root => witnessed(root, statement))).filter(Boolean).length] as const;
  const better = (a: readonly number[], b: readonly number[]) => a[0]! > b[0]! || a[0] === b[0] && a[1]! > b[1]!;
  const out = order.slice(0, head), injections: EvidenceCoverageInjection[] = [];
  tops.forEach((top, statement) => {
    if (top === null) return;
    const root = order[top]!;
    if (out.includes(root)) return;
    let best: { slot: number; value: readonly number[] } | undefined;
    for (let slot = head - 1; slot >= 1; slot--) {
      const trial = out.slice(); trial[slot] = root;
      const value = objective(trial);
      if (best === undefined || better(value, best.value)) best = { slot, value };
    }
    if (best === undefined || !better(best.value, objective(out))) {
      injections.push({ statement, root_position: top + 1, status: "no_free_slot" }); return;
    }
    out[best.slot] = root;
    injections.push({ statement, root_position: top + 1, status: "injected", slot: best.slot + 1 });
  });
  const chosen = new Set(out), variants: EvidenceWitnessVariant[] = [];
  // Derived relation: each placed top's condition brings its rank 2-5 witnesses from outside the first five.
  if (association.spans !== undefined) {
    meter.charge(statements * order.length * 4, statements * 5 * 64, "evidence witness variants");
    tops.forEach((top, statement) => {
      if (top === null || !chosen.has(order[top]!)) return;
      const ranked = order.map((root, position) => ({ root, position, value: necessary(root, statement) }))
        .filter((row): row is { root: string; position: number; value: number } => row.value !== null)
        .sort((a, b) => b.value - a.value || a.position - b.position).slice(1, 5);
      for (const { root, position } of ranked) {
        const span = association.spans![index.get(root)!]![statement];
        if (chosen.has(root) || span == null) continue;
        chosen.add(root);
        variants.push({ root, statement, root_position: position + 1, support_span: { start_byte: span[0], end_byte: span[1] } });
      }
    });
  }
  const moved = variants.map(row => row.root);
  return { order: [...out, ...moved, ...order.filter(root => !chosen.has(root))],
    top_positions: tops.map(top => top === null ? null : top + 1), injections, variants };
}
