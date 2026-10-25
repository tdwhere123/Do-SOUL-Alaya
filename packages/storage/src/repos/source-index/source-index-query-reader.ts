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
    const revision = `${database.getConnectionVersion()}:${sourceEpoch}:${String(database.connection.pragma("data_version", { simple: true }))}:${String(
      readRecord(database.connection.prepare("SELECT total_changes() AS n").get(), "source capture revision").n)}`;
    if (this.rows === undefined) {
      meter.ledger.charge(1, 64, "source target capture map"); this.rows = new Map();
    } else if (this.epoch !== revision) {
      meter.ledger.charge(this.rows.size, 0, "source target capture invalidation"); this.rows.clear();
    }
    this.epoch = revision;
    return true;
  }
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
  absorb(resources: SourceIndexResources): void { this.read(resources.work, resources.native_bytes); }
  remaining() { return { work: this.ledger.work, native_bytes: this.ledger.bytes }; }
  resources(): SourceIndexQueryResources {
    return { work: this.ledger.spentWork, native_bytes: this.nativeBytes,
      memory_bytes: this.ledger.spentBytes, sql_internal_work: "unknown" };
  }
}
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
      { lane: "unicode61" as const, table: segmented ? "source_index_lexical_fts" : "source_index_fts",
        tokens: split.porterTokens, offset: 0, done: false },
      { lane: "trigram" as const, table: "source_index_fts_trigram", tokens: split.trigramTokens, offset: 0, done: false }
    ].filter(lane => lane.tokens.length > 0).map(lane => ({ ...lane, match: buildFtsMatchExpression(lane.tokens) }));
    meter.ledger.retain(lanes.map(lane => lane.match));
    if (lanes.length === 0) return result("partial", "no_admitted_tokens");
    while (candidates.length < limit && lanes.some(lane => !lane.done)) {
      for (const lane of lanes) {
        if (lane.done || candidates.length >= limit) continue;
        meter.ledger.reserve(1, 24); meter.read(1, 0);
        const projected = lane.table === "source_index_lexical_fts";
        const projectionJoin = projected
          ? `JOIN source_index_lexical_projections p ON p.id=${lane.table}.rowid AND p.workspace_id=?
             JOIN source_index_text x ON x.workspace_id=p.workspace_id AND x.root_key=p.root_key`
          : `JOIN source_index_text x ON x.id=${lane.table}.rowid AND x.workspace_id=?`;
        const generationJoin = binding === undefined ? "" : `${projected ? "" : `JOIN source_index_lexical_projections p
          ON p.workspace_id=x.workspace_id AND p.root_key=x.root_key`}
          JOIN source_index_lexical_targets t ON t.workspace_id=p.workspace_id AND t.generation_id=p.generation_id
            AND t.root_key=p.root_key AND t.complete=1`;
        const raw = database.connection.prepare(`SELECT x.id,bm25(${lane.table}) AS score,r.root_key,
          octet_length(r.target_json) AS metadata_bytes FROM ${lane.table} ${projectionJoin} ${generationJoin}
          JOIN source_index_roots r ON r.workspace_id=x.workspace_id AND r.root_key=x.root_key
          WHERE ${lane.table} MATCH ? AND ${SOURCE_INDEX_LEXICAL_CURRENT}
          ${binding === undefined ? "" : "AND p.generation_id=? AND p.content_digest=x.content_digest AND p.body_bytes=x.body_bytes"}
          ORDER BY score ASC,x.root_key ASC LIMIT 1 OFFSET ?`).get(workspaceId, lane.match,
            ...(binding === undefined ? [] : [binding.generation_id]), lane.offset);
        if (raw === undefined) { lane.done = true; continue; }
        const row = readRecord(raw, "source lexical candidate"), bytes = readIntegerField(row, "metadata_bytes");
        const rootKey = readStringField(row, "root_key");
        meter.read(0, 24 + Buffer.byteLength(rootKey));
        const owned = captured ? capture!.get(rootKey, meter) : undefined;
        // Reserve actual target decoding only when no paid snapshot-owned target exists.
        meter.ledger.reserve(129 + (owned === undefined ? bytes : 0), 4096 + 5 * bytes); meter.read(1, 0);
        const target = database.connection.prepare(`SELECT r.target_json FROM source_index_text x
          JOIN source_index_roots r ON r.workspace_id=x.workspace_id AND r.root_key=x.root_key
          WHERE x.workspace_id=? AND x.id=?`).get(workspaceId, readIntegerField(row, "id"));
        meter.read(0, bytes);
        if (owned === undefined) meter.ledger.charge(bytes, 0, "source target decode");
        const source = owned ?? parseTarget(target, workspaceId, meter);
        lane.offset++;
        const lexical = { rank: candidates.length + 1, lane: lane.lane, lane_rank: lane.offset,
          bm25: readFiniteNumberField(row, "score") };
        if (!Number.isFinite(lexical.bm25)) return result("unavailable", "invalid_bm25");
        const candidate = { source, lexical };
        meter.ledger.retain(candidate);
        if (captured) capture!.remember(source, meter);
        candidates.push(candidate);
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

/** Rowid is only a point-read address; the continuation and deterministic order use the window key. */
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
    const binding = state.binding;
    while (inspected < limit) {
      meter.ledger.reserve(1, 32); meter.read(1, 0);
      const raw = database.connection.prepare(`SELECT v.rowid AS vector_rowid,v.dimensions,r.root_key,
        octet_length(r.target_json) AS target_bytes,
        octet_length(r.target_json)+octet_length(v.window_id)+octet_length(w.content_digest)+24 AS metadata_bytes,
        length(v.embedding_blob) AS blob_bytes
        FROM source_index_vectors v
        JOIN source_index_windows w ON w.workspace_id=v.workspace_id AND w.generation_id=v.generation_id
          AND w.root_key=v.root_key AND w.window_id=v.window_id
        JOIN source_index_targets t ON t.workspace_id=v.workspace_id AND t.generation_id=v.generation_id AND t.root_key=v.root_key
        JOIN source_index_roots r ON r.workspace_id=v.workspace_id AND r.root_key=v.root_key
        WHERE v.workspace_id=? AND v.generation_id=? AND v.window_id>?
        ORDER BY v.window_id ASC LIMIT 1`).get(workspaceId, binding.generation_id, next?.after_window_id ?? "");
      if (raw === undefined) return result(invalid > 0 ? "partial" : "complete", invalid > 0 ? "invalid_vectors" : null);
      const pointer = readRecord(raw, "source vector pointer"), rootKey = readStringField(pointer, "root_key");
      meter.read(0, 40 + Buffer.byteLength(rootKey));
      const metadataBytes = readIntegerField(pointer, "metadata_bytes"), blobBytes = readIntegerField(pointer, "blob_bytes");
      const owned = captured ? capture!.get(rootKey, meter) : undefined;
      const payloadBytes = metadataBytes - (owned === undefined ? 0 : readIntegerField(pointer, "target_bytes"));
      // A snapshot-owned target needs neither another native JSON transfer nor
      // JSON decoding. The cached branch reads five typed window/vector fields;
      // native window bytes and the embedding BLOB remain fully charged.
      const decodeWork = owned === undefined ? metadataBytes : 5;
      meter.ledger.reserve(129 + decodeWork + binding.dimensions,
        4160 + 5 * payloadBytes + blobBytes + binding.dimensions * 4);
      meter.read(1, 0);
      const targetColumn = owned === undefined ? "r.target_json," : "";
      const targetJoin = owned === undefined
        ? "JOIN source_index_roots r ON r.workspace_id=v.workspace_id AND r.root_key=v.root_key" : "";
      const row = readRecord(database.connection.prepare(`SELECT ${targetColumn}v.window_id,w.start_byte,w.end_byte,
        w.content_digest,v.dimensions,v.embedding_blob FROM source_index_vectors v
        ${targetJoin}
        JOIN source_index_windows w ON w.workspace_id=v.workspace_id AND w.generation_id=v.generation_id
          AND w.root_key=v.root_key AND w.window_id=v.window_id
        WHERE v.workspace_id=? AND v.generation_id=? AND v.rowid=?`).get(workspaceId, binding.generation_id,
        readIntegerField(pointer, "vector_rowid")), "source vector candidate");
      meter.read(0, payloadBytes + blobBytes);
      meter.ledger.charge(decodeWork, 0, owned === undefined ? "source target decode" : "source vector window fields");
      const window = { window_id: readStringField(row, "window_id"), start_byte: readIntegerField(row, "start_byte"),
        end_byte: readIntegerField(row, "end_byte"), content_digest: readStringField(row, "content_digest") };
      next = { binding, after_window_id: window.window_id }; inspected++;
      meter.ledger.charge(binding.dimensions, binding.dimensions * 4, "source vector decode");
      const embedding = readIntegerField(row, "dimensions") === binding.dimensions
        ? decodeValidEmbeddingBlob(readBufferField(row, "embedding_blob"), binding.dimensions) : null;
      const source = owned ?? parseTarget(row, workspaceId, meter);
      if (embedding === null || !sourceIndexWindowWithinSource(window, source)) {
        invalid++; continue;
      }
      if (owned === undefined) meter.ledger.retain({ source, window });
      else {
        meter.ledger.retain(window);
        meter.ledger.charge(1, 8, "source vector captured target reference");
      }
      meter.ledger.charge(1, 64, "source vector candidate retention");
      if (captured) capture!.remember(source, meter);
      candidates.push({ source, window, embedding });
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
