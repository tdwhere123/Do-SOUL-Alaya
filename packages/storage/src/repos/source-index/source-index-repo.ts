import {
  SOURCE_INDEX_PREPARATION_REVISION, SourceIndexConfigurationSchema, SourceIndexTargetSchema, SourceIndexOperationError, BoundedIdSchema, canonicalJson,
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
import { SOURCE_INDEX_STANDALONE_BUDGET, assertIndexBudget, assertIndexPageLimit, guardSourceIndexTarget, readSourceIndexDocument, readSourceIndexMessageStructure,
} from "./native-source.js";
import { captureSourceIndexTargets, persistSourceIndexLexical } from "./capture-targets.js";
import { SqliteSourceIndexLexicalStore } from "./lexical-generation.js";
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
  public readonly lexical: SqliteSourceIndexLexicalStore;
  private records: SqliteFieldSourceRecordRepo;
  private connectionVersion: number;
  private readonly targetCapture: SourceIndexTargetCapture | undefined;
  public constructor(private readonly database: StorageDatabase, private readonly sha256: FieldContractSha256,
    options: Readonly<{ captureReadTargets?: boolean }> = {}) {
    this.lexical = new SqliteSourceIndexLexicalStore(database, sha256);
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
        (workspace_id,generation_id,selection_revision,config_id,profile_id,configuration_json,source_epoch,status,preparation_revision)
        VALUES(?,?,?,?,?,?,?,'building',?) ON CONFLICT(workspace_id,generation_id) DO NOTHING`).run(current.workspace_id,
        generationId, current.selection_revision, current.config_id, current.profile_id, canonicalJson(current.configuration), epoch, SOURCE_INDEX_PREPARATION_REVISION);
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
    const resources = { work: 0, native_bytes: 0 };
    try { return this.atomic(() => captureSourceIndexTargets(this.database, this.records, captured, resources)); }
    catch (error) { throw new SourceIndexOperationError(error, resources); }
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
      const read = readSourceIndexDocument(this.database, this.records, source, input.maxBytes, input.budget);
      if (read.status !== "ready" || generation.selection.configuration.profile.windowing === "utf8-byte-windows.v1") return read;
      try {
        const structure = readSourceIndexMessageStructure(this.records, source, {
          work: input.budget.work - read.resources.work, native_bytes: input.budget.native_bytes - read.resources.native_bytes
        });
        const resources = { work: read.resources.work + structure.resources.work,
          native_bytes: read.resources.native_bytes + structure.resources.native_bytes };
        return structure.status === "ready" ? { ...read, message_structure: structure.structure, resources }
          : { status: "partial", reason: structure.reason, resources };
      } catch (error) { throw new SourceIndexOperationError(error, read.resources); }
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
        if (!persistSourceIndexLexical(this.database, lexical.source, lexical.body, guard.dependencies, captured.budget, guard.resources)) {
          return { status: "rejected", reason: "read_budget", resources: guard.resources };
        }
        return { status: "accepted", resources: guard.resources };
      });
    } catch (error) {
      throw new SourceIndexOperationError(error, completed);
    }
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
        const profile = generation.selection.configuration.profile;
        // Reread admitted facts inside this write transaction; caller-supplied boundaries are not authority.
        const structure = profile.windowing === "recorded-message-windows.v1"
          ? readSourceIndexMessageStructure(this.records, source, input.budget) : undefined;
        if (structure !== undefined) Object.assign(resources, structure.resources);
        completed = resources;
        if (structure?.status === "partial") return { status: "rejected",
          reason: structure.reason === "read_budget" ? "read_budget" : "native_source_unavailable", resources };
        const expected = prepareSourceIndexDocument({ source, body: input.document.body, profile,
          ...(structure === undefined ? {} : { message_structure: structure.structure }) }, this.sha256);
        if (canonicalJson(expected) !== canonicalJson(input.document)) {
          throw new StorageError("VALIDATION_FAILED", "source index window manifest mismatch");
        }
        const guard = guardSourceIndexTarget(this.database, this.records, source, {
          work: input.budget.work - resources.work, native_bytes: input.budget.native_bytes - resources.native_bytes
        });
        resources.work += guard.resources.work; resources.native_bytes += guard.resources.native_bytes;
        if (guard.status !== "ready") return { status: "rejected",
          reason: guard.status === "partial" ? guard.reason : "stale", resources };
        if (!persistSourceIndexLexical(this.database, source, expected.body, guard.dependencies, input.budget, resources)) {
          return { status: "rejected", reason: "read_budget", resources };
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
        return { status: "accepted", resources };
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
    // A read inside the caller's snapshot needs no nested savepoint: it writes nothing to undo.
    if (mode === "read" && this.database.connection.inTransaction) return operation();
    const transaction = this.database.connection.transaction(operation);
    return mode === "read" ? transaction() : transaction.immediate();
  }
}
function rejected(reason: Extract<SourceIndexWriteResult, { status: "rejected" }>["reason"]): SourceIndexWriteResult {
  return { status: "rejected", reason };
}
