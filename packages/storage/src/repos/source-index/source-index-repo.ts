import {
  SourceIndexConfigurationSchema, SourceIndexTargetSchema, SourceIndexOperationError, BoundedIdSchema, canonicalJson,
  prepareSourceIndexDocument, prepareSourceIndexLexical, sourceIndexConfigurationId, sourceIndexGenerationId,
  sourceIndexProfileId, type FieldContractSha256, type SourceIndexBudget, type SourceIndexCaptureResult,
  type SourceIndexConfiguration, type SourceIndexDocument, type SourceIndexGeneration, type SourceIndexGuardedWriteResult,
  type SourceIndexReadResult, type SourceIndexQueryRepository, type SourceIndexVectorBinding,
  type SourceIndexVectorCursor, type SourceSemanticResourceBudget,
  type SourceIndexRepository, type SourceIndexSelection, type SourceIndexState, type SourceIndexTarget,
  type SourceIndexVector, type SourceIndexWriteResult, type SourceIndexPendingResult
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { SqliteFieldSourceRecordRepo } from "../field/source-repo.js";
import { encodeEmbeddingBlob, isFiniteNonzeroEmbedding } from "../memory/embedding-vector-validity.js";
import { readBufferField, readIntegerField, readJsonColumn, readNullableStringField, readRecord, readStringField } from "../shared/parse-row.js";
import { SOURCE_INDEX_STANDALONE_BUDGET, assertIndexBudget, assertIndexPageLimit, guardSourceIndexTarget, readSourceIndexDocument,
  sourceReadCost, sourceTargetFromRead } from "./native-source.js";
import { readSourceIndexGeneration, readSourceIndexSelection, requireSourceIndexGeneration,
  sourceIndexBuildGuard, sourceIndexEpoch, verifySourceIndexTargetCoverage } from "./generation-state.js";
import { SourceIndexTargetCapture, admitSourceIndexQueryCandidate, readSourceIndexLexicalCandidates,
  readSourceIndexVectorCandidates } from "./source-index-query-reader.js";
import { SOURCE_INDEX_QUALIFICATION_STATUSES, readSourceIndexRootQualification, readSourceIndexSnapshotFact } from "./source-index-qualification.js";

// Private Node measurement friend. No package-root export, public operation or persisted state.
// Both source and installed consumers discover this on the same existing package constructor.
const SOURCE_INDEX_MEASUREMENT: unique symbol = Symbol.for("@do-soul/alaya-storage/private/source-index-measurement");

/** Mechanical CAS/materialization for Core's SourceIndexLifecycle. No inference or truth promotion. */
export class SqliteSourceIndexRepository implements SourceIndexRepository, SourceIndexQueryRepository {
  static readonly [SOURCE_INDEX_MEASUREMENT] = Object.freeze({ statuses: SOURCE_INDEX_QUALIFICATION_STATUSES,
    readSnapshot: readSourceIndexSnapshotFact, readRoot: readSourceIndexRootQualification });
  private records: SqliteFieldSourceRecordRepo;
  private connectionVersion: number;
  private readonly targetCapture: SourceIndexTargetCapture | undefined;
  public constructor(private readonly database: StorageDatabase, private readonly sha256: FieldContractSha256,
    options: Readonly<{ captureReadTargets?: boolean }> = {}) {
    this.targetCapture = options.captureReadTargets ? new SourceIndexTargetCapture() : undefined;
    this.records = new SqliteFieldSourceRecordRepo(database, sha256);
    this.connectionVersion = database.getConnectionVersion();
  }

  public readLexicalCandidates(workspaceId: string, navigationText: string, limit: number, budget: SourceSemanticResourceBudget) {
    BoundedIdSchema.parse(workspaceId);
    const capture = this.database.connection.inTransaction ? this.targetCapture : undefined;
    return this.atomic(() => readSourceIndexLexicalCandidates(this.database, workspaceId, navigationText, limit, budget, this.sha256, capture), "read");
  }

  public readVectorCandidates(workspaceId: string, cursor: SourceIndexVectorCursor | null, limit: number,
    budget: SourceSemanticResourceBudget) {
    BoundedIdSchema.parse(workspaceId);
    const capture = this.database.connection.inTransaction ? this.targetCapture : undefined;
    return this.atomic(() => readSourceIndexVectorCandidates(this.database, workspaceId, cursor, limit, budget, capture), "read");
  }

  public admitQueryCandidate(source: SourceIndexTarget, vectorBinding: SourceIndexVectorBinding | null,
    budget: SourceSemanticResourceBudget) {
    return this.atomic(() => admitSourceIndexQueryCandidate(this.database, this.records, source, vectorBinding, budget), "read");
  }

  public select(workspaceId: string, configuration: SourceIndexConfiguration): SourceIndexSelection {
    const captured = structuredClone({ workspaceId, configuration });
    BoundedIdSchema.parse(captured.workspaceId);
    const config = SourceIndexConfigurationSchema.parse(captured.configuration);
    const configId = sourceIndexConfigurationId(config, this.sha256);
    return this.atomic(() => {
      const previous = readSourceIndexSelection(this.database, captured.workspaceId);
      if (previous?.config_id === configId) return previous;
      this.database.connection.prepare(`UPDATE source_index_generations SET status = 'retired', reason = 'selection_changed'
        WHERE workspace_id = ? AND status != 'retired'`).run(captured.workspaceId);
      this.database.connection.prepare(`INSERT INTO source_index_selections
        (workspace_id,selection_revision,config_id,profile_id,configuration_json,active_generation_id)
        VALUES(?,?,?,?,?,NULL) ON CONFLICT(workspace_id) DO UPDATE SET
        selection_revision=excluded.selection_revision, config_id=excluded.config_id, profile_id=excluded.profile_id,
        configuration_json=excluded.configuration_json, active_generation_id=NULL`).run(captured.workspaceId,
        (previous?.selection_revision ?? 0) + 1, configId, sourceIndexProfileId(config.profile, this.sha256), canonicalJson(config));
      return readSourceIndexSelection(this.database, captured.workspaceId)!;
    });
  }

  public unbind(workspaceId: string): void {
    BoundedIdSchema.parse(workspaceId);
    this.atomic(() => {
      // Advancing even an unbuilt selection fences callers that captured it before unbind.
      // Generation snapshots preserve the previous revision/profile and accepted vectors.
      this.database.connection.prepare(`UPDATE source_index_generations SET status='retired',reason='configuration_unbound'
        WHERE workspace_id=? AND status != 'retired'`).run(workspaceId);
      this.database.connection.prepare(`UPDATE source_index_selections
        SET selection_revision=selection_revision+1,active_generation_id=NULL WHERE workspace_id=?`).run(workspaceId);
    });
  }

  public state(workspaceId: string): SourceIndexState {
    return this.atomic(() => {
      const selection = readSourceIndexSelection(this.database, workspaceId);
      if (selection === null) return { status: "unknown" };
      const raw = readRecord(this.database.connection.prepare(`SELECT active_generation_id FROM source_index_selections
        WHERE workspace_id = ?`).get(workspaceId), "source selection");
      const active = readNullableStringField(raw, "active_generation_id");
      if (active === null) {
        const build = readSourceIndexGeneration(this.database, workspaceId,
          sourceIndexGenerationId(selection, sourceIndexEpoch(this.database, workspaceId), this.sha256));
        return { status: build?.status ?? "unbound", selection, active_generation_id: null };
      }
      return { status: requireSourceIndexGeneration(this.database, workspaceId, active).status,
        selection, active_generation_id: active };
    }, "read");
  }

  public begin(selection: SourceIndexSelection): SourceIndexGeneration {
    const captured = structuredClone(selection);
    return this.atomic(() => {
      const current = readSourceIndexSelection(this.database, captured.workspace_id);
      if (current === null || canonicalJson(current) !== canonicalJson(captured)) {
        throw new StorageError("CONFLICT", "source index selection was superseded");
      }
      const epoch = sourceIndexEpoch(this.database, current.workspace_id);
      const generationId = sourceIndexGenerationId(current, epoch, this.sha256);
      this.database.connection.prepare(`INSERT INTO source_index_generations
        (workspace_id,generation_id,selection_revision,config_id,profile_id,configuration_json,source_epoch,status)
        VALUES(?,?,?,?,?,?,?,'building') ON CONFLICT(workspace_id,generation_id) DO NOTHING`).run(current.workspace_id,
        generationId, current.selection_revision, current.config_id, current.profile_id, canonicalJson(current.configuration), epoch);
      this.database.connection.prepare(`UPDATE source_index_generations SET status = 'building', reason = NULL
        WHERE workspace_id = ? AND generation_id = ? AND status = 'failed'`).run(current.workspace_id, generationId);
      return requireSourceIndexGeneration(this.database, current.workspace_id, generationId);
    });
  }

  public generation(workspaceId: string, generationId: string): SourceIndexGeneration | null {
    return this.atomic(() => readSourceIndexGeneration(this.database, workspaceId, generationId), "read");
  }

  public capturePage(workspaceId: string, generationId: string, limit: number, budget: SourceIndexBudget): SourceIndexCaptureResult {
    const captured = structuredClone({ workspaceId, generationId, limit, budget });
    assertIndexPageLimit(captured.limit); assertIndexBudget(captured.budget);
    return this.atomic(() => this.captureTargets(captured));
  }

  private captureTargets(input: { workspaceId: string; generationId: string; limit: number; budget: SourceIndexBudget }): SourceIndexCaptureResult {
    let generation = requireSourceIndexGeneration(this.database, input.workspaceId, input.generationId);
    const resources = { work: 0, native_bytes: 0 };
    const guard = sourceIndexBuildGuard(this.database, generation);
    if (guard !== null || generation.enumeration_complete || generation.status === "failed") return { generation, added: 0, resources };
    let cursor = generation.after_source_id, added = 0, complete = false, reason: string | null = null;
    for (let index = 0; index < input.limit; index++) {
      if (input.budget.work - resources.work < 320 || input.budget.native_bytes - resources.native_bytes < 262144) {
        reason = "enumeration_budget"; break;
      }
      const read = this.records.findNextCurrentBounded(input.workspaceId, cursor, 4,
        { workLimit: input.budget.work - resources.work, nativeByteLimit: input.budget.native_bytes - resources.native_bytes });
      if (read === null) { resources.work++; complete = true; break; }
      const cost = sourceReadCost(read); resources.work += cost.work; resources.native_bytes += cost.native_bytes;
      if (read.record === null || read.resourceLimited || read.record.source_body === null && read.bodyBytes > 0) {
        reason = "native_source_unknown"; break;
      }
      const source = sourceTargetFromRead(read);
      if (source !== null) {
        const available = guardSourceIndexTarget(this.database, this.records, source,
          { work: input.budget.work - resources.work, native_bytes: input.budget.native_bytes - resources.native_bytes });
        resources.work += available.resources.work; resources.native_bytes += available.resources.native_bytes;
        if (available.status === "partial") {
          reason = available.reason === "read_budget" ? "enumeration_budget" : "native_source_unknown"; break;
        }
        if (available.status === "ready") {
          if (!this.persistRoot(source, available.dependencies, input.budget, resources)) {
            reason = "enumeration_budget"; break;
          }
          const write = this.database.connection.prepare(`INSERT INTO source_index_targets
            (workspace_id,generation_id,root_key) VALUES(?,?,?) ON CONFLICT DO NOTHING`)
            .run(input.workspaceId, input.generationId, source.root_key);
          added += write.changes;
        }
      }
      cursor = read.record.source_id;
    }
    if (!complete && reason === null) reason = "enumeration_page";
    this.database.connection.prepare(`UPDATE source_index_generations SET after_source_id=?, enumeration_complete=?,
      status=?, reason=? WHERE workspace_id=? AND generation_id=?`).run(cursor, complete ? 1 : 0,
      complete ? "building" : "partial", reason, input.workspaceId, input.generationId);
    generation = requireSourceIndexGeneration(this.database, input.workspaceId, input.generationId);
    return { generation, added, resources };
  }

  public listTargets(workspaceId: string, generationId: string, afterRootKey: string | null, limit: number): readonly SourceIndexTarget[] {
    assertIndexPageLimit(limit);
    return this.atomic(() => {
      requireSourceIndexGeneration(this.database, workspaceId, generationId);
      return this.database.connection.prepare(`SELECT r.target_json FROM source_index_targets t
        JOIN source_index_roots r ON r.workspace_id=t.workspace_id AND r.root_key=t.root_key
        WHERE t.workspace_id=? AND t.generation_id=? AND t.root_key>? ORDER BY t.root_key LIMIT ?`)
        .all(workspaceId, generationId, afterRootKey ?? "", limit).map(raw => SourceIndexTargetSchema.parse(
          readJsonColumn(readRecord(raw, "source index target"), "target_json")));
    }, "read");
  }

  private target(workspaceId: string, generationId: string, rootKey: string): SourceIndexTarget | null {
    const raw = this.database.connection.prepare(`SELECT r.target_json FROM source_index_targets t
      JOIN source_index_roots r ON r.workspace_id=t.workspace_id AND r.root_key=t.root_key
      WHERE t.workspace_id=? AND t.generation_id=? AND t.root_key=?`).get(workspaceId, generationId, rootKey);
    return raw === undefined ? null : SourceIndexTargetSchema.parse(readJsonColumn(readRecord(raw, "source index target"), "target_json"));
  }

  public readDocument(workspaceId: string, generationId: string, rootKey: string, maxBytes: number,
    budget: SourceIndexBudget): SourceIndexReadResult {
    const input = structuredClone({ workspaceId, generationId, rootKey, maxBytes, budget });
    return this.atomic(() => {
      const resources = { work: 0, native_bytes: 0 };
      const generation = readSourceIndexGeneration(this.database, input.workspaceId, input.generationId);
      if (generation === null) return { status: "unbound", reason: "missing_generation", resources };
      const guard = sourceIndexBuildGuard(this.database, generation);
      if (guard !== null) return { status: guard, reason: guard, resources };
      if (generation.status === "failed") return { status: "partial", reason: "incomplete", resources };
      const source = this.target(input.workspaceId, input.generationId, input.rootKey);
      if (source === null) return { status: "unbound", reason: "missing_target", resources };
      return readSourceIndexDocument(this.database, this.records, source, input.maxBytes, input.budget);
    }, "read");
  }

  public writeLexical(source: SourceIndexTarget, body: string,
    budget: SourceIndexBudget = SOURCE_INDEX_STANDALONE_BUDGET): SourceIndexGuardedWriteResult {
    const captured = structuredClone({ source, body, budget });
    const lexical = prepareSourceIndexLexical(captured, this.sha256);
    let completed = { work: 0, native_bytes: 0 };
    try {
      return this.atomic(() => {
        const guard = guardSourceIndexTarget(this.database, this.records, lexical.source, captured.budget);
        completed = guard.resources;
        if (guard.status !== "ready") return { status: "rejected",
          reason: guard.status === "partial" ? guard.reason : "stale", resources: guard.resources };
        if (!this.persistLexical(lexical.source, lexical.body, guard.dependencies, captured.budget, guard.resources)) {
          return { status: "rejected", reason: "read_budget", resources: guard.resources };
        }
        return { status: "accepted", resources: guard.resources };
      });
    } catch (error) {
      throw new SourceIndexOperationError(error, completed);
    }
  }

  private persistRoot(source: SourceIndexTarget, dependencies: readonly string[], budget: SourceIndexBudget,
    resources: { work: number; native_bytes: number }): boolean {
    // Admit every indexed dependency lookup before replacing any existing root/dependency metadata.
    if (budget.work - resources.work < dependencies.length) return false;
    this.database.connection.prepare(`INSERT INTO source_index_roots
      (workspace_id,root_key,record_id,source_id,target_json) VALUES(?,?,?,?,?)
      ON CONFLICT(workspace_id,root_key) DO UPDATE SET target_json=excluded.target_json`)
      .run(source.target.workspace_id, source.root_key, source.target.root_id, source.source_id, canonicalJson(source));
    this.database.connection.prepare(`DELETE FROM source_index_dependencies WHERE workspace_id=? AND root_key=?`)
      .run(source.target.workspace_id, source.root_key);
    const insert = this.database.connection.prepare(`INSERT INTO source_index_dependencies
      (workspace_id,root_key,dependency_record_id,dependency_source_id)
      SELECT workspace_id,?,record_id,source_id FROM source_records WHERE workspace_id=? AND record_id=?`);
    // INSERT ... SELECT keeps all identity bytes inside SQLite; no source metadata/body is hydrated.
    for (const id of dependencies) {
      insert.run(source.root_key, source.target.workspace_id, id);
      resources.work++;
    }
    return true;
  }

  private persistLexical(source: SourceIndexTarget, body: string, dependencies: readonly string[], budget: SourceIndexBudget,
    resources: { work: number; native_bytes: number }): boolean {
    if (!this.persistRoot(source, dependencies, budget, resources)) return false;
    this.database.connection.prepare(`INSERT INTO source_index_text(workspace_id,root_key,content_digest,body_bytes,body)
      VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,root_key) DO UPDATE SET content_digest=excluded.content_digest,
      body_bytes=excluded.body_bytes,body=excluded.body`).run(source.target.workspace_id, source.root_key,
      source.target.content_digest, source.body_bytes, body);
    return true;
  }

  public writeDocument(workspaceId: string, generationId: string, document: SourceIndexDocument,
    budget: SourceIndexBudget = SOURCE_INDEX_STANDALONE_BUDGET): SourceIndexGuardedWriteResult {
    const input = structuredClone({ workspaceId, generationId, document, budget });
    let completed = { work: 0, native_bytes: 0 };
    try {
      return this.atomic(() => {
        const resources = { work: 0, native_bytes: 0 };
        const generation = readSourceIndexGeneration(this.database, input.workspaceId, input.generationId);
        if (generation === null) return { status: "rejected", reason: "missing_generation", resources };
        const stale = sourceIndexBuildGuard(this.database, generation);
        if (stale !== null) return { status: "rejected", reason: stale, resources };
        if (generation.status === "failed") return { status: "rejected", reason: "incomplete", resources };
        const source = this.target(input.workspaceId, input.generationId, input.document.source.root_key);
        if (source === null) return { status: "rejected", reason: "missing_target", resources };
        if (canonicalJson(source) !== canonicalJson(input.document.source)) return { status: "rejected", reason: "stale", resources };
        const expected = prepareSourceIndexDocument({ source, body: input.document.body,
          profile: generation.selection.configuration.profile }, this.sha256);
        if (canonicalJson(expected) !== canonicalJson(input.document)) {
          throw new StorageError("VALIDATION_FAILED", "source index window manifest mismatch");
        }
        const guard = guardSourceIndexTarget(this.database, this.records, source, input.budget);
        completed = guard.resources;
        if (guard.status !== "ready") return { status: "rejected",
          reason: guard.status === "partial" ? guard.reason : "stale", resources: guard.resources };
        if (!this.persistLexical(source, expected.body, guard.dependencies, input.budget, guard.resources)) {
          return { status: "rejected", reason: "read_budget", resources: guard.resources };
        }
        const insert = this.database.connection.prepare(`INSERT INTO source_index_windows
          (workspace_id,generation_id,root_key,window_id,ordinal,start_byte,end_byte,content_digest,body)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
        // A deterministic same-generation manifest is insert-only: preparation retries retain accepted vectors.
        for (const window of expected.windows) insert.run(input.workspaceId, input.generationId, source.root_key,
          window.window_id, window.ordinal, window.start_byte, window.end_byte, window.content_digest, window.text);
        this.database.connection.prepare(`UPDATE source_index_targets SET expected_windows=?
          WHERE workspace_id=? AND generation_id=? AND root_key=?`).run(expected.windows.length,
          input.workspaceId, input.generationId, source.root_key);
        verifySourceIndexTargetCoverage(this.database, input.workspaceId, input.generationId, source.root_key);
        return { status: "accepted", resources: guard.resources };
      });
    } catch (error) {
      throw new SourceIndexOperationError(error, completed);
    }
  }

  public pendingWindows(workspaceId: string, generationId: string, rootKey: string, limit: number,
    budget: SourceIndexBudget): SourceIndexPendingResult {
    const input = structuredClone({ workspaceId, generationId, rootKey, limit, budget });
    assertIndexPageLimit(input.limit); assertIndexBudget(input.budget);
    const resources = { work: 0, native_bytes: 0 };
    try {
      this.database.reopenIfClosed();
      if (this.database.connection.inTransaction) {
        throw new StorageError("CONFLICT", "Source backfill requires a transaction-free caller");
      }
      return this.atomic(() => {
        const generation = readSourceIndexGeneration(this.database, input.workspaceId, input.generationId);
        if (generation === null) return { status: "unbound", reason: "missing_generation", resources };
        const stale = sourceIndexBuildGuard(this.database, generation);
        if (stale !== null) return { status: stale, reason: stale, resources };
        if (generation.status === "failed") return { status: "partial", reason: "generation_failed", resources };
        const raw = this.database.connection.prepare(`SELECT expected_windows FROM source_index_targets
          WHERE workspace_id=? AND generation_id=? AND root_key=?`).get(input.workspaceId, input.generationId, input.rootKey);
        if (raw === undefined) return { status: "unbound", reason: "missing_target", resources };
        if (readRecord(raw, "source index manifest").expected_windows === null) {
          return { status: "partial", reason: "manifest_unprepared", resources };
        }
        const count = Math.min(input.limit, input.budget.work, Math.floor(input.budget.native_bytes / 8));
        if (count === 0) return { status: "partial", reason: "read_budget", resources };
        // The SQL anti-join may inspect accepted rows internally: its CPU is unknown, not bounded by count.
        const rows = this.database.connection.prepare(`SELECT w.ordinal FROM source_index_windows w
          WHERE w.workspace_id=? AND w.generation_id=? AND w.root_key=? AND NOT EXISTS (
            SELECT 1 FROM source_index_vectors v WHERE v.workspace_id=w.workspace_id
              AND v.generation_id=w.generation_id AND v.window_id=w.window_id AND v.root_key=w.root_key)
          ORDER BY w.ordinal LIMIT ?`).all(input.workspaceId, input.generationId, input.rootKey, count);
        resources.work = Math.max(1, rows.length); resources.native_bytes = 8 * rows.length;
        return { status: "ready", ordinals: rows.map(row => readIntegerField(readRecord(row, "pending window"), "ordinal")), resources };
      }, "read");
    } catch (error) {
      throw new SourceIndexOperationError(error, resources);
    }
  }

  public writeVector(workspaceId: string, generationId: string, vector: SourceIndexVector): SourceIndexWriteResult;
  public writeVector(workspaceId: string, generationId: string, vector: SourceIndexVector,
    budget: SourceIndexBudget): SourceIndexGuardedWriteResult;
  public writeVector(workspaceId: string, generationId: string, vector: SourceIndexVector,
    budget?: SourceIndexBudget): SourceIndexWriteResult | SourceIndexGuardedWriteResult {
    const input = structuredClone({ workspaceId, generationId, vector, budget: budget ?? SOURCE_INDEX_STANDALONE_BUDGET });
    assertIndexBudget(input.budget);
    let resources = { work: 0, native_bytes: 0 };
    try {
      const result: SourceIndexGuardedWriteResult = this.atomic(() => {
        const generation = readSourceIndexGeneration(this.database, input.workspaceId, input.generationId);
        if (generation === null) return { status: "rejected", reason: "missing_generation", resources };
        const stale = sourceIndexBuildGuard(this.database, generation);
        if (stale !== null) return { status: "rejected", reason: stale, resources };
        if (generation.status === "failed") return { status: "rejected", reason: "incomplete", resources };
        const window = this.database.connection.prepare(`SELECT root_key,content_digest FROM source_index_windows
          WHERE workspace_id=? AND generation_id=? AND window_id=?`).get(input.workspaceId, input.generationId, input.vector.window_id);
        if (window === undefined) return { status: "rejected", reason: "missing_target", resources };
        const row = readRecord(window, "source index window");
        const source = this.target(input.workspaceId, input.generationId, readStringField(row, "root_key"));
        if (source === null) return { status: "rejected", reason: "missing_target", resources };
        const guard = guardSourceIndexTarget(this.database, this.records, source, input.budget);
        resources = guard.resources;
        if (guard.status !== "ready") return { status: "rejected",
          reason: guard.status === "partial" ? guard.reason : "stale", resources };
        const profile = generation.selection.configuration.profile;
        const value = input.vector;
        if (!(value.embedding instanceof Float32Array) || value.embedding.length !== profile.dimensions ||
            !isFiniteNonzeroEmbedding(value.embedding) || value.truncated !== false ||
            !Number.isSafeInteger(value.token_count) || value.token_count < 1 || value.token_count > profile.max_input_tokens ||
            value.input_digest !== readStringField(row, "content_digest")) {
          throw new StorageError("VALIDATION_FAILED", "source vector requires compatible complete window input");
        }
        const blob = encodeEmbeddingBlob(value.embedding);
        const previous = this.database.connection.prepare(`SELECT dimensions,embedding_blob,token_count FROM source_index_vectors
          WHERE workspace_id=? AND generation_id=? AND window_id=?`).get(input.workspaceId, input.generationId, value.window_id);
        if (previous !== undefined) {
          const persisted = readRecord(previous, "source index vector");
          if (readIntegerField(persisted, "dimensions") !== profile.dimensions ||
              readIntegerField(persisted, "token_count") !== value.token_count || !readBufferField(persisted, "embedding_blob").equals(blob)) {
            throw new StorageError("CONFLICT", "source index vector retry differs from its persisted result");
          }
          return { status: "accepted", resources };
        }
        this.database.connection.prepare(`INSERT INTO source_index_vectors
          (workspace_id,generation_id,root_key,window_id,dimensions,embedding_blob,token_count) VALUES(?,?,?,?,?,?,?)`)
          .run(input.workspaceId, input.generationId, source.root_key, value.window_id, profile.dimensions, blob, value.token_count);
        verifySourceIndexTargetCoverage(this.database, input.workspaceId, input.generationId, source.root_key);
        return { status: "accepted", resources };
      });
      if (budget !== undefined) return result;
      // Retain the established standalone result shape and incomplete mapping, not a second write route.
      return result.status === "accepted" ? { status: "accepted" } : rejected(
        result.reason === "read_budget" || result.reason === "native_source_unavailable" ? "incomplete" : result.reason);
    } catch (error) {
      throw new SourceIndexOperationError(error, resources);
    }
  }

  public activate(workspaceId: string, generationId: string): SourceIndexWriteResult {
    return this.atomic(() => {
      let generation = readSourceIndexGeneration(this.database, workspaceId, generationId);
      if (generation === null) return rejected("missing_generation");
      const guard = sourceIndexBuildGuard(this.database, generation);
      if (guard !== null) return rejected(guard);
      verifySourceIndexTargetCoverage(this.database, workspaceId, generationId);
      generation = requireSourceIndexGeneration(this.database, workspaceId, generationId);
      if (generation.status === "failed" || !generation.enumeration_complete || generation.completed_count !== generation.target_count) {
        return rejected("incomplete");
      }
      this.database.connection.prepare(`UPDATE source_index_generations SET status='retired', reason='replaced'
        WHERE workspace_id=? AND generation_id != ? AND status != 'retired'`).run(workspaceId, generationId);
      this.database.connection.prepare(`UPDATE source_index_generations SET status=?,reason=NULL WHERE workspace_id=? AND generation_id=?`)
        .run(generation.target_count === 0 ? "valid_empty" : "ready", workspaceId, generationId);
      this.database.connection.prepare(`UPDATE source_index_selections SET active_generation_id=?
        WHERE workspace_id=? AND selection_revision=? AND config_id=?`).run(generationId, workspaceId,
        generation.selection.selection_revision, generation.selection.config_id);
      return { status: "accepted" };
    });
  }

  public fail(workspaceId: string, generationId: string, reason: string): void {
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 256) {
      throw new StorageError("VALIDATION_FAILED", "source index failure reason must be bounded");
    }
    this.atomic(() => {
      const generation = requireSourceIndexGeneration(this.database, workspaceId, generationId);
      if (sourceIndexBuildGuard(this.database, generation) !== null) return;
      this.database.connection.prepare(`UPDATE source_index_generations SET status='failed',reason=?
        WHERE workspace_id=? AND generation_id=?`).run(reason, workspaceId, generationId);
      this.database.connection.prepare(`UPDATE source_index_selections SET active_generation_id=NULL
        WHERE workspace_id=? AND active_generation_id=?`).run(workspaceId, generationId);
    });
  }

  private atomic<T>(operation: () => T, mode: "read" | "write" = "write"): T {
    this.database.reopenIfClosed();
    if (this.connectionVersion !== this.database.getConnectionVersion()) {
      this.records = new SqliteFieldSourceRecordRepo(this.database, this.sha256);
      this.connectionVersion = this.database.getConnectionVersion();
    }
    const transaction = this.database.connection.transaction(operation);
    return mode === "read" ? transaction() : transaction.immediate();
  }
}
function rejected(reason: Extract<SourceIndexWriteResult, { status: "rejected" }>["reason"]): SourceIndexWriteResult {
  return { status: "rejected", reason };
}
