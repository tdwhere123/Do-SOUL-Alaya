import {
  CJK_SCRIPT_PATTERN, TRIGRAM_MIN_CODEPOINTS, SourceIndexTargetSchema,
  SourceIndexOperationError, SourceSemanticResourceExhausted, SourceSemanticResourceLedger, canonicalJson, hashContentDigest,
  sourceGoldRootIdentity, splitFtsLanes,
  type FieldContractSha256, type SourceIndexLexicalCandidate, type SourceIndexLexicalRead, type SourceIndexQueryAdmission,
  type SourceIndexQueryResources, type SourceIndexResources, type SourceIndexTarget,
  type SourceIndexVectorBinding, type SourceIndexVectorCandidate, type SourceIndexVectorCursor,
  type SourceIndexVectorQueryState, type SourceIndexVectorRead, type SourceSemanticResourceBudget
} from "@do-soul/alaya-protocol";
import { analyzeSourceIndexLexical, isCjkSegmentationCandidate, readCjkSegmentationStatus, readSourceIndexLexicalAnalysisStatus } from "@do-soul/alaya-cjk-segmentation";
import type { StorageDatabase } from "../../sqlite/db.js";
import { cachedReadStatement } from "../../sqlite/dynamic-prepared-statement-cache.js";
import { StorageError } from "../../shared/errors.js";
import type { SqliteFieldSourceRecordRepo } from "../field/source-repo.js";
import { decodeValidEmbeddingBlob } from "../memory/embedding-vector-validity.js";
import { buildFtsMatchExpression, tokenizeFtsQuery } from "../shared/fts-lane-routing.js";
import { readBufferField, readIntegerField, readJsonColumn, readFiniteNumberField, readRecord, readStringField } from "../shared/parse-row.js";
import { readSourceIndexQueryState, sourceIndexEpoch, SOURCE_INDEX_LEXICAL_CURRENT } from "./generation-state.js";
import { assertIndexPageLimit, guardSourceIndexTarget } from "./native-source.js";
import { readSourceIndexLexicalBinding } from "./lexical-generation.js";

type QueryResourceRefusal = NonNullable<SourceIndexLexicalRead["resource_refusal"]>;
// Only schema-owned immutable targets whose canonical identity was checked here
// can reuse that check. Currentness, erasure and vector-generation guards still
// execute at each admission; caller-frozen lookalikes do not establish ownership.
const validatedTargets = new WeakSet<SourceIndexTarget>();

/** Request-local reuse of already parsed immutable targets. The enclosing SQLite
 * snapshot owns stability; same-connection writes and connection reopen invalidate
 * the capture. Currentness, erasure and vector binding are still checked at admission. */
export class SourceIndexTargetCapture {
  private rows: Map<string, SourceIndexTarget> | undefined;
  private epoch: string | undefined;
  begin(database: StorageDatabase, workspace: string, meter: QueryReadMeter): boolean {
    if (!database.connection.inTransaction) return false;
    meter.read(3, 24);
    // The epoch point-read pins the SQLite snapshot before comparing connection
    // revision, including the first read of a newly opened deferred transaction.
    const sourceEpoch = sourceIndexEpoch(database, workspace);
    const revision = `${database.getConnectionVersion()}:${sourceEpoch}:${String(cachedReadStatement(database, "PRAGMA data_version").pluck().get())}:${String(
      readRecord(cachedReadStatement(database, "SELECT total_changes() AS n").get(), "source capture revision").n)}`;
    if (this.rows === undefined) {
      meter.ledger.charge(1, 64, "source target capture map"); this.rows = new Map();
    } else if (this.epoch !== revision) {
      meter.ledger.charge(this.rows.size, 0, "source target capture invalidation"); this.rows.clear();
    }
    this.epoch = revision;
    return true;
  }
  owns(key: string): boolean { return this.rows?.has(key) === true; }
  get(key: string, meter: QueryReadMeter): SourceIndexTarget | undefined {
    meter.ledger.charge(1, 0, "source target capture lookup");
    return this.rows?.get(key);
  }
  remember(source: SourceIndexTarget, meter: QueryReadMeter): void {
    if (this.rows?.has(source.root_key)) return;
    meter.ledger.charge(1, 40, "source target capture reference");
    this.rows?.set(source.root_key, source);
  }
}
class QueryReadMeter {
  readonly ledger: SourceSemanticResourceLedger;
  private nativeBytes = 0;
  constructor(budget: SourceSemanticResourceBudget) {
    for (const value of [budget.work_units, budget.memory_bytes]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new StorageError("VALIDATION_FAILED", "invalid source query budget");
    }
    this.ledger = new SourceSemanticResourceLedger(budget);
  }
  read(work: number, bytes: number): void {
    this.ledger.charge(work, bytes, "source index query read"); this.nativeBytes += bytes;
  }
  /** Rows of one batch are already read from SQLite: pay each in order. Once the ledger refuses, the unpaid
   * remainder is charged as far as the budget reaches and always counts as native bytes, so no read goes unaccounted. */
  readRows(rowBytes: readonly number[]): SourceSemanticResourceExhausted | null {
    for (let paid = 0; paid < rowBytes.length; paid++) {
      try { this.read(1, rowBytes[paid]!); } catch (error) {
        if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
        for (let unpaid = paid; unpaid < rowBytes.length; unpaid++) {
          this.ledger.charge(Math.min(1, this.ledger.work), Math.min(rowBytes[unpaid]!, this.ledger.bytes), "source index query read");
          this.nativeBytes += rowBytes[unpaid]!;
        }
        return error;
      }
    }
    return null;
  }
  absorb(resources: SourceIndexResources): void { this.read(resources.work, resources.native_bytes); }
  remaining() { return { work: this.ledger.work, native_bytes: this.ledger.bytes }; }
  resources(): SourceIndexQueryResources {
    return { work: this.ledger.spentWork, native_bytes: this.nativeBytes,
      memory_bytes: this.ledger.spentBytes, sql_internal_work: "unknown" };
  }
}
// Decoding a target charges its JSON bytes as work, and a valid target is larger than this: rows past what
// the remaining work could decode are not worth reading.
const LEXICAL_ROW_WORK_ESTIMATE = 512;
const LEXICAL_LIMITATIONS = Object.freeze([
  "database_wide_bm25_statistics", "short_or_unadmitted_tokens_are_not_absence", "lexical_corpus_coverage_untracked"
]);

/** Lane-local BM25 ascending/root-key ties; unicode61/trigram lanes alternate, not raw-score fusion.
 * Every join is workspace-bound before LIMIT. Source FTS has body only, not content/workspace columns.
 */
export function readSourceIndexLexicalCandidates(database: StorageDatabase, workspaceId: string,
  navigationText: string, limit: number, budget: SourceSemanticResourceBudget,
  sha256: FieldContractSha256, capture?: SourceIndexTargetCapture): SourceIndexLexicalRead {
  assertIndexPageLimit(limit);
  const meter = new QueryReadMeter(budget), candidates: SourceIndexLexicalCandidate[] = [];
  let tokenization: SourceIndexLexicalRead["tokenization"] = null, shortCjk = false;
  let resourceRefusal: QueryResourceRefusal | null = null;
  let partialGeneration = false;
  const result = (completion: SourceIndexLexicalRead["completion"], reason: string | null): SourceIndexLexicalRead => ({
    candidates, completion, reason, resources: meter.resources(), index_coverage: "partial", tokenization,
    resource_refusal: resourceRefusal, limitations: shortCjk
      ? [...LEXICAL_LIMITATIONS, "short_cjk_unicode61_exact_tokens_only"] : LEXICAL_LIMITATIONS
  });
  try {
    const captured = capture?.begin(database, workspaceId, meter) === true;
    meter.ledger.retain(navigationText); meter.ledger.charge(navigationText.length, 0, "source query tokenization");
    // The synchronous capture cannot transition loading -> ready. Reads never initiate native loading.
    const selected = readSourceIndexLexicalBinding(database, workspaceId, meter.remaining());
    meter.absorb(selected.resources);
    if (selected.state.status === "unavailable") {
      if (selected.state.reason === "read_budget") resourceRefusal = { stage: "lexical", phase: "source lexical binding read" };
      return result(selected.state.reason === "read_budget" ? "partial" : "unavailable", selected.state.reason);
    }
    const binding = "binding" in selected.state ? selected.state.binding : undefined;
    partialGeneration = selected.state.status === "partial";
    const segmented = binding?.representation === "segmented-unicode61.v1";
    const cjkState = segmented ? readSourceIndexLexicalAnalysisStatus() : readCjkSegmentationStatus();
    if (segmented && cjkState !== "ready") return result("unavailable", `segmenter_${cjkState}`);
    const tokens = segmented ? analyzeSourceIndexLexical(navigationText, "query")
      : tokenizeFtsQuery(navigationText, { initializeCjk: false });
    const split = splitFtsLanes(tokens);
    const material = { policy: "source-index-fts.v1" as const, cjk_state: cjkState, terms: tokens,
      unicode61_terms: split.porterTokens, trigram_terms: split.trigramTokens,
      ...(binding === undefined ? {} : { lexical_binding: binding }) };
    meter.ledger.retain(material, "source tokenization capture");
    const bindingMaterial = canonicalJson(material);
    meter.ledger.retain(bindingMaterial, "source tokenization binding");
    meter.ledger.charge(bindingMaterial.length, 256, "source tokenization digest");
    tokenization = { ...material, binding_digest: hashContentDigest(bindingMaterial, sha256) };
    shortCjk = split.porterTokens.some(token => CJK_SCRIPT_PATTERN.test(token) &&
      Array.from(token).length < TRIGRAM_MIN_CODEPOINTS && (!segmented || !isCjkSegmentationCandidate(token)));
    const lanes = [
      { lane: "unicode61" as const, table: segmented ? "source_index_lexical_fts" : "source_index_fts", tokens: split.porterTokens },
      { lane: "trigram" as const, table: "source_index_fts_trigram", tokens: split.trigramTokens }
    ].filter(lane => lane.tokens.length > 0).map(lane => new LexicalLane(database, lane.lane, lane.table,
      buildFtsMatchExpression(lane.tokens), binding?.generation_id));
    meter.ledger.retain(lanes.map(lane => lane.match));
    if (lanes.length === 0) return result("partial", "no_admitted_tokens");
    while (candidates.length < limit && lanes.some(lane => !lane.done)) {
      for (const lane of lanes) {
        if (lane.done || candidates.length >= limit) continue;
        if (!lane.buffered()) {
          // Alternation hands this lane every other remaining slot while the other lanes still yield rows.
          const live = lanes.filter(other => !other.done && (other.buffered() || !other.exhausted)).length;
          lane.fill(workspaceId, Math.min(Math.ceil((limit - candidates.length) / live),
            Math.max(1, Math.floor(meter.ledger.work / LEXICAL_ROW_WORK_ESTIMATE))), meter);
        }
        const row = lane.take();
        if (row === undefined) {
          if (lane.refusal !== null) throw lane.refusal;
          lane.done = true; continue;
        }
        candidates.push(lexicalCandidate(lane, row, candidates.length + 1, workspaceId, meter, captured ? capture : undefined));
      }
    }
    return lanes.every(lane => lane.done)
      ? result(shortCjk || partialGeneration ? "partial" : "complete",
        partialGeneration ? "lexical_generation_partial" : shortCjk ? "short_cjk_exact_tokens_only" : null)
      : result("partial", "candidate_limit");
  } catch (error) {
    if (error instanceof SourceSemanticResourceExhausted) resourceRefusal = { stage: "lexical", phase: error.phase };
    return result(error instanceof SourceSemanticResourceExhausted ? "partial" : "unavailable",
      error instanceof SourceSemanticResourceExhausted ? "read_budget" : "native_query_failed");
  }
}

type LexicalRow = Readonly<{ raw: Record<string, unknown>; rootKey: string; bytes: number }>;

/** One FTS lane: a single ordered statement read in bounded batches, never one statement per candidate. */
class LexicalLane {
  done = false;
  exhausted = false;
  refusal: SourceSemanticResourceExhausted | null = null;
  consumed = 0;
  private rows: readonly LexicalRow[] = [];
  private next = 0;
  private fetched = 0;
  private readonly statement;
  constructor(database: StorageDatabase, readonly lane: "unicode61" | "trigram", readonly table: string,
    readonly match: string, private readonly generationId: string | undefined) {
    const projected = table === "source_index_lexical_fts";
    const projectionJoin = projected
      ? `JOIN source_index_lexical_projections p ON p.id=${table}.rowid AND p.workspace_id=?
         JOIN source_index_text x ON x.workspace_id=p.workspace_id AND x.root_key=p.root_key`
      : `JOIN source_index_text x ON x.id=${table}.rowid AND x.workspace_id=?`;
    const generationJoin = generationId === undefined ? "" : `${projected ? "" : `JOIN source_index_lexical_projections p
      ON p.workspace_id=x.workspace_id AND p.root_key=x.root_key`}
      JOIN source_index_lexical_targets t ON t.workspace_id=p.workspace_id AND t.generation_id=p.generation_id
        AND t.root_key=p.root_key AND t.complete=1`;
    this.statement = cachedReadStatement(database, `SELECT bm25(${table}) AS score,r.root_key,r.target_json,
      octet_length(r.target_json) AS metadata_bytes FROM ${table} ${projectionJoin} ${generationJoin}
      JOIN source_index_roots r ON r.workspace_id=x.workspace_id AND r.root_key=x.root_key
      WHERE ${table} MATCH ? AND ${SOURCE_INDEX_LEXICAL_CURRENT}
      ${generationId === undefined ? "" : "AND p.generation_id=? AND p.content_digest=x.content_digest AND p.body_bytes=x.body_bytes"}
      ORDER BY score ASC,x.root_key ASC LIMIT ? OFFSET ?`);
  }
  buffered(): boolean { return this.next < this.rows.length; }
  take(): LexicalRow | undefined {
    const row = this.rows[this.next];
    if (row !== undefined) { this.next++; this.consumed++; }
    return row;
  }
  /** Reads the next `size` rows in `score ASC, root_key ASC` order and pays for every one of them. */
  fill(workspaceId: string, size: number, meter: QueryReadMeter): void {
    if (this.exhausted) return;
    meter.ledger.reserve(1, 24); meter.read(1, 0);
    const raw = this.statement.all(workspaceId, this.match, ...(this.generationId === undefined ? [] : [this.generationId]),
      size, this.fetched);
    const rows = raw.map(item => {
      const row = readRecord(item, "source lexical candidate"), rootKey = readStringField(row, "root_key");
      return { raw: row, rootKey, bytes: readIntegerField(row, "metadata_bytes") };
    });
    this.fetched += rows.length; this.exhausted = rows.length < size;
    this.refusal = meter.readRows(rows.map(row => 24 + Buffer.byteLength(row.rootKey) + row.bytes));
    this.rows = this.refusal === null ? rows : []; this.next = 0;
  }
}

function lexicalCandidate(lane: LexicalLane, row: LexicalRow, rank: number, workspaceId: string, meter: QueryReadMeter,
  capture: SourceIndexTargetCapture | undefined): SourceIndexLexicalCandidate {
  const owned = capture?.get(row.rootKey, meter);
  // Reserve actual target decoding only when no paid snapshot-owned target exists.
  meter.ledger.reserve(129 + (owned === undefined ? row.bytes : 0), 4096 + 5 * row.bytes);
  if (owned === undefined) meter.ledger.charge(row.bytes, 0, "source target decode");
  const source = owned ?? parseTarget(row.raw, workspaceId, meter);
  const candidate = { source, lexical: { rank, lane: lane.lane, lane_rank: lane.consumed, bm25: readFiniteNumberField(row.raw, "score") } };
  meter.ledger.retain(candidate);
  capture?.remember(source, meter);
  return candidate;
}

const VECTOR_PAGE_SQL = `SELECT v.window_id,v.dimensions,v.embedding_blob,w.start_byte,w.end_byte,w.content_digest,r.root_key,
  octet_length(r.target_json) AS target_bytes,
  octet_length(v.window_id)+octet_length(w.content_digest)+24 AS window_bytes
  FROM source_index_vectors v
  JOIN source_index_windows w ON w.workspace_id=v.workspace_id AND w.generation_id=v.generation_id
    AND w.root_key=v.root_key AND w.window_id=v.window_id
  JOIN source_index_targets t ON t.workspace_id=v.workspace_id AND t.generation_id=v.generation_id AND t.root_key=v.root_key
  JOIN source_index_roots r ON r.workspace_id=v.workspace_id AND r.root_key=v.root_key
  WHERE v.workspace_id=? AND v.generation_id=? AND v.window_id>?
  ORDER BY v.window_id ASC LIMIT ?`;
const VECTOR_TARGETS_SQL = `SELECT root_key,target_json FROM source_index_roots
  WHERE workspace_id=? AND root_key IN (SELECT value FROM json_each(?))`;

/** Rows a ledger can still pay for: each needs `headroom` free before it starts and charges at least `charge`.
 * One more is counted for the row whose refusal ends the page. */
function consumableRows(free: number, headroom: number, charge: number): number {
  return free < headroom ? 1 : Math.floor((free - headroom) / charge) + 1;
}

type VectorWindowRow = Readonly<{ raw: Record<string, unknown>; rootKey: string; blob: Buffer; windowBytes: number; targetBytes: number }>;
function readVectorWindowRow(raw: Record<string, unknown>): VectorWindowRow {
  return { raw, rootKey: readStringField(raw, "root_key"), blob: readBufferField(raw, "embedding_blob"),
    windowBytes: readIntegerField(raw, "window_bytes"), targetBytes: readIntegerField(raw, "target_bytes") };
}

/** Windows are read in pages of one statement; the window key is the continuation and the deterministic order. */
export function readSourceIndexVectorCandidates(database: StorageDatabase, workspaceId: string,
  cursor: SourceIndexVectorCursor | null, limit: number, budget: SourceSemanticResourceBudget,
  capture?: SourceIndexTargetCapture): SourceIndexVectorRead {
  assertIndexPageLimit(limit);
  const meter = new QueryReadMeter(budget), candidates: SourceIndexVectorCandidate[] = [];
  let state: SourceIndexVectorQueryState = { status: "unavailable", reason: "read_budget" };
  let next = cursor, inspected = 0, invalid = 0;
  let resourceRefusal: QueryResourceRefusal | null = null;
  const result = (completion: SourceIndexVectorRead["completion"], reason: string | null): SourceIndexVectorRead => ({
    candidates, completion, reason, resources: meter.resources(), state, cursor: next, inspected, invalid,
    resource_refusal: resourceRefusal
  });
  try {
    const captured = capture?.begin(database, workspaceId, meter) === true;
    const read = readSourceIndexQueryState(database, workspaceId, meter.remaining());
    meter.absorb(read.resources); state = read.state;
    if (!("binding" in state) && state.reason === "read_budget") {
      resourceRefusal = { stage: "vector", phase: "source vector binding read" };
      return result("partial", "read_budget");
    }
    meter.ledger.retain(state, "source vector binding capture");
    if (!("binding" in state)) return result("unavailable", state.reason);
    if (cursor !== null) {
      meter.ledger.retain(cursor);
      if (canonicalJson(cursor.binding) !== canonicalJson(state.binding)) return result("unavailable", "active_generation_changed");
    }
    const binding = state.binding, dims = binding.dimensions;
    const page = cachedReadStatement(database, VECTOR_PAGE_SQL), targetsStatement = cachedReadStatement(database, VECTOR_TARGETS_SQL);
    const parsedTargets = new Map<string, SourceIndexTarget>();
    while (inspected < limit) {
      meter.ledger.reserve(1, 32); meter.read(1, 0);
      const size = Math.min(limit - inspected, consumableRows(meter.ledger.work, 134 + dims, 6 + dims),
        consumableRows(meter.ledger.bytes, 4160 + 8 * dims, 40 + 8 * dims));
      const rows = page.all(workspaceId, binding.generation_id, next?.after_window_id ?? "", size)
        .map(item => readVectorWindowRow(readRecord(item, "source vector candidate")));
      // Only the first window of a root not yet owned carries its target; owned roots never re-read it.
      const pending = new Set<string>();
      const costs = rows.map(row => {
        const carries = !pending.has(row.rootKey) && !parsedTargets.has(row.rootKey) && !(captured && capture!.owns(row.rootKey));
        if (carries) pending.add(row.rootKey);
        return 40 + Buffer.byteLength(row.rootKey) + row.windowBytes + row.blob.length + (carries ? row.targetBytes : 0);
      });
      const targets = new Map<string, Record<string, unknown>>();
      if (pending.size > 0) {
        for (const item of targetsStatement.all(workspaceId, JSON.stringify([...pending]))) {
          const target = readRecord(item, "source vector target");
          targets.set(readStringField(target, "root_key"), target);
        }
      }
      const refusal = meter.readRows(costs);
      if (refusal !== null) throw refusal;
      for (const row of rows) {
        const owned = captured ? capture!.get(row.rootKey, meter) : undefined;
        const known = owned ?? parsedTargets.get(row.rootKey);
        const payloadBytes = row.windowBytes + (known === undefined ? row.targetBytes : 0);
        // A known target needs neither another native JSON transfer nor JSON decoding. The cached branch reads five
        // typed window/vector fields; native window bytes and the embedding BLOB remain fully charged.
        const decodeWork = known === undefined ? payloadBytes : 5;
        meter.ledger.reserve(129 + decodeWork + dims, 4160 + 5 * payloadBytes + row.blob.length + dims * 4);
        meter.ledger.charge(decodeWork, 0, known === undefined ? "source target decode" : "source vector window fields");
        const window = { window_id: readStringField(row.raw, "window_id"), start_byte: readIntegerField(row.raw, "start_byte"),
          end_byte: readIntegerField(row.raw, "end_byte"), content_digest: readStringField(row.raw, "content_digest") };
        next = { binding, after_window_id: window.window_id }; inspected++;
        meter.ledger.charge(dims, dims * 4, "source vector decode");
        const embedding = readIntegerField(row.raw, "dimensions") === dims ? decodeValidEmbeddingBlob(row.blob, dims) : null;
        const source = known ?? parseTarget(targets.get(row.rootKey), workspaceId, meter);
        parsedTargets.set(row.rootKey, source);
        if (embedding === null || !sourceIndexWindowWithinSource(window, source)) {
          invalid++; continue;
        }
        if (known === undefined) meter.ledger.retain({ source, window });
        else {
          meter.ledger.retain(window);
          meter.ledger.charge(1, 8, "source vector captured target reference");
        }
        meter.ledger.charge(1, 64, "source vector candidate retention");
        if (captured) capture!.remember(source, meter);
        candidates.push({ source, window, embedding });
      }
      if (rows.length < size) return result(invalid > 0 ? "partial" : "complete", invalid > 0 ? "invalid_vectors" : null);
    }
    return result("partial", "window_page_limit");
  } catch (error) {
    if (error instanceof SourceSemanticResourceExhausted) resourceRefusal = { stage: "vector", phase: error.phase };
    return result(error instanceof SourceSemanticResourceExhausted ? "partial" : "unavailable",
      error instanceof SourceSemanticResourceExhausted ? "read_budget" : "native_query_failed");
  }
}

/** Every outcome includes all state/native/canonical-dependency costs; the caller must debit its remainder. */
export function admitSourceIndexQueryCandidate(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  source: SourceIndexTarget, vectorBinding: SourceIndexVectorBinding | null,
  budget: SourceSemanticResourceBudget): SourceIndexQueryAdmission {
  const meter = new QueryReadMeter(budget);
  const refused = (phase: string): SourceIndexQueryAdmission => ({
    status: "resource_limited", reason: "read_budget", phase, resources: meter.resources()
  });
  try {
    let target: SourceIndexTarget;
    if (validatedTargets.has(source)) {
      meter.ledger.charge(1, 8, "source admission target reference");
      target = source;
    } else {
      meter.ledger.retain(source, "source admission target capture");
      target = SourceIndexTargetSchema.parse(source);
      meter.ledger.charge(target.root_key.length, 0, "source admission target identity");
      if (target.root_key !== sourceGoldRootIdentity(target.target)) return { status: "stale", reason: "target_identity", resources: meter.resources() };
    }
    if (vectorBinding !== null) {
      meter.ledger.retain(vectorBinding);
      const read = readSourceIndexQueryState(database, target.target.workspace_id, meter.remaining());
      meter.absorb(read.resources);
      if (!("binding" in read.state) && read.state.reason === "read_budget") return refused("source vector binding read");
      if (!("binding" in read.state) || canonicalJson(vectorBinding) !== canonicalJson(read.state.binding)) {
        return { status: "unbound", reason: "binding" in read.state ? "active_generation_changed" : read.state.reason, resources: meter.resources() };
      }
    }
    const guard = guardSourceIndexTarget(database, records, target, meter.remaining());
    meter.absorb(guard.resources);
    if (guard.status === "partial" && guard.reason === "read_budget") return refused("source currentness and erase guard");
    return guard.status === "ready" ? { status: "ready", scope_class: guard.scope_class, resources: meter.resources() }
      : { status: guard.status, reason: guard.reason, resources: meter.resources() };
  } catch (error) {
    if (error instanceof SourceSemanticResourceExhausted) return refused(error.phase);
    if (error instanceof SourceIndexOperationError) {
      try { meter.absorb(error.resources); }
      catch (budgetError) {
        if (budgetError instanceof SourceSemanticResourceExhausted) return refused(budgetError.phase);
        throw budgetError;
      }
    }
    return { status: "partial", reason: "native_source_unavailable", resources: meter.resources() };
  }
}

/** Mechanical extent validity shared with the private frozen index measurement reader. */
export function sourceIndexWindowWithinSource(window: { start_byte: number; end_byte: number }, source: SourceIndexTarget): boolean {
  return window.start_byte >= 0 && window.end_byte > window.start_byte && window.end_byte <= source.body_bytes;
}

function parseTarget(raw: unknown, workspaceId: string, meter: QueryReadMeter): SourceIndexTarget {
  const source = SourceIndexTargetSchema.parse(readJsonColumn(readRecord(raw, "source query target"), "target_json"));
  if (source.target.workspace_id !== workspaceId || source.root_key !== sourceGoldRootIdentity(source.target)) {
    throw new StorageError("VALIDATION_FAILED", "source query target identity mismatch");
  }
  meter.ledger.charge(1, 16, "source target identity ownership");
  validatedTargets.add(source);
  return source;
}
