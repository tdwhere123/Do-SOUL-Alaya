import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { StorageError } from "./errors.js";
import { type JsonValue, parseJsonField, stringifyJson } from "./json.js";
import { getSchemaVersion, migrateStorage } from "./schema.js";

type SqliteModule = typeof import("node:sqlite");

const require = createRequire(import.meta.url);
let sqliteModule: SqliteModule | undefined;

export type MemoryPlane = "global_personal" | "project_local";
export type MemoryLifecycleState = "active" | "rejected" | "retired";
export type MemoryGovernanceState = "pending" | "accepted" | "rejected" | "retired";
export type MemorySensitivity = "normal" | "sensitive";
export type SessionMode = "connect" | "attach" | "gateway";
export type UsageRecommendation = "blocking" | "advisory" | "historical";
export type ViolationSeverity = "info" | "warning" | "error";
export type PortabilityOperationType = "export" | "import" | "backup" | "restore";
export type PortabilityOperationStatus = "started" | "completed" | "failed";

type SqlParam = string | number | null;

export interface SoulMemoryStorageOptions {
  readonly path?: string;
  readonly now?: () => string;
  readonly migrate?: boolean;
}

export interface StorageHealth {
  readonly ok: boolean;
  readonly schemaVersion: number;
  readonly path: string;
}

export interface CreateScopeInput {
  readonly scopeId?: string;
  readonly plane: MemoryPlane;
  readonly scopeKind: string;
  readonly scopeRef: string;
  readonly parentScopeId?: string | null;
  readonly metadata?: JsonValue;
  readonly createdAt?: string;
}

export interface ScopeRecord {
  readonly scopeId: string;
  readonly plane: MemoryPlane;
  readonly scopeKind: string;
  readonly scopeRef: string;
  readonly parentScopeId: string | null;
  readonly metadata: JsonValue;
  readonly createdAt: string;
}

export interface CreateMemoryInput {
  readonly memoryId?: string;
  readonly plane: MemoryPlane;
  readonly scopeId?: string | null;
  readonly title: string;
  readonly body: string;
  readonly sourceType: string;
  readonly sourceRef: string;
  readonly lifecycleState?: MemoryLifecycleState;
  readonly governanceState?: MemoryGovernanceState;
  readonly strength?: number;
  readonly sensitivity?: MemorySensitivity;
  readonly metadata?: JsonValue;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface MemoryRecord {
  readonly memoryId: string;
  readonly plane: MemoryPlane;
  readonly scopeId: string | null;
  readonly title: string;
  readonly body: string;
  readonly sourceType: string;
  readonly sourceRef: string;
  readonly lifecycleState: MemoryLifecycleState;
  readonly governanceState: MemoryGovernanceState;
  readonly strength: number;
  readonly sensitivity: MemorySensitivity;
  readonly metadata: JsonValue;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateMemoryInput {
  readonly title?: string;
  readonly body?: string;
  readonly lifecycleState?: MemoryLifecycleState;
  readonly governanceState?: MemoryGovernanceState;
  readonly strength?: number;
  readonly sensitivity?: MemorySensitivity;
  readonly metadata?: JsonValue;
  readonly updatedAt?: string;
}

export interface ListMemoryFilter {
  readonly plane?: MemoryPlane;
  readonly scopeId?: string;
  readonly lifecycleState?: MemoryLifecycleState;
  readonly governanceState?: MemoryGovernanceState;
  readonly limit?: number;
}

export interface CreateEvidenceInput {
  readonly evidenceId?: string;
  readonly memoryId: string;
  readonly sourceType: string;
  readonly sourceRef: string;
  readonly payload: JsonValue;
  readonly createdAt?: string;
}

export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly memoryId: string;
  readonly sourceType: string;
  readonly sourceRef: string;
  readonly payload: JsonValue;
  readonly createdAt: string;
}

export interface CreateAuditEventInput {
  readonly auditEventId?: string;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorRef?: string | null;
  readonly payload?: JsonValue;
  readonly createdAt?: string;
}

export interface AuditEventRecord {
  readonly auditEventId: string;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorRef: string | null;
  readonly payload: JsonValue;
  readonly createdAt: string;
}

export interface AuditEventFilter {
  readonly entityType?: string;
  readonly entityId?: string;
  readonly eventType?: string;
  readonly limit?: number;
}

export interface CreateMemoryEdgeInput {
  readonly edgeId?: string;
  readonly fromMemoryId: string;
  readonly toMemoryId: string;
  readonly edgeType: string;
  readonly strength?: number;
  readonly metadata?: JsonValue;
  readonly createdAt?: string;
}

export interface MemoryEdgeRecord {
  readonly edgeId: string;
  readonly fromMemoryId: string;
  readonly toMemoryId: string;
  readonly edgeType: string;
  readonly strength: number;
  readonly metadata: JsonValue;
  readonly createdAt: string;
}

export interface StartMemorySessionInput {
  readonly sessionId?: string;
  readonly agentKind: string;
  readonly clientVersion?: string | null;
  readonly mode: SessionMode;
  readonly hostRef?: string | null;
  readonly projectRef?: string | null;
  readonly workspaceRef?: string | null;
  readonly contextPackId?: string | null;
  readonly usageState?: string;
  readonly postRunIngestState?: string;
  readonly violationSummary?: JsonValue;
  readonly metadata?: JsonValue;
  readonly startedAt?: string;
}

export interface FinishMemorySessionInput {
  readonly finishedAt?: string;
  readonly contextPackId?: string | null;
  readonly usageState?: string;
  readonly postRunIngestState?: string;
  readonly violationSummary?: JsonValue;
}

export interface UpdateMemorySessionInput {
  readonly contextPackId?: string | null;
  readonly usageState?: string;
  readonly postRunIngestState?: string;
  readonly violationSummary?: JsonValue;
}

export interface MemorySessionRecord {
  readonly sessionId: string;
  readonly agentKind: string;
  readonly clientVersion: string | null;
  readonly mode: SessionMode;
  readonly hostRef: string | null;
  readonly projectRef: string | null;
  readonly workspaceRef: string | null;
  readonly contextPackId: string | null;
  readonly usageState: string;
  readonly postRunIngestState: string;
  readonly violationSummary: JsonValue;
  readonly metadata: JsonValue;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface CreateContextPackInput {
  readonly contextPackId?: string;
  readonly sessionId?: string | null;
  readonly requestId?: string | null;
  readonly queryText: string;
  readonly taskSummary?: string | null;
  readonly planePolicy?: JsonValue;
  readonly recallPolicyVersion: string;
  readonly explanationSummary: string;
  readonly metadata?: JsonValue;
  readonly createdAt?: string;
}

export interface ContextPackRecord {
  readonly contextPackId: string;
  readonly sessionId: string | null;
  readonly requestId: string | null;
  readonly queryText: string;
  readonly taskSummary: string | null;
  readonly planePolicy: JsonValue;
  readonly recallPolicyVersion: string;
  readonly includedCount: number;
  readonly excludedCount: number;
  readonly explanationSummary: string;
  readonly metadata: JsonValue;
  readonly createdAt: string;
  readonly entries: readonly ContextPackEntryRecord[];
  readonly exclusions: readonly RecallExclusionRecord[];
}

export interface AddContextPackEntryInput {
  readonly entryId?: string;
  readonly contextPackId: string;
  readonly memoryId: string;
  readonly memoryPlane: MemoryPlane;
  readonly usageRecommendation: UsageRecommendation;
  readonly score?: number;
  readonly rank: number;
  readonly reason: string;
  readonly sourceRefs?: JsonValue;
  readonly isStale?: boolean;
  readonly isSensitive?: boolean;
  readonly hasConflict?: boolean;
  readonly metadata?: JsonValue;
  readonly createdAt?: string;
}

export interface ContextPackEntryRecord {
  readonly entryId: string;
  readonly contextPackId: string;
  readonly memoryId: string;
  readonly memoryPlane: MemoryPlane;
  readonly usageRecommendation: UsageRecommendation;
  readonly score: number;
  readonly rank: number;
  readonly reason: string;
  readonly sourceRefs: JsonValue;
  readonly isStale: boolean;
  readonly isSensitive: boolean;
  readonly hasConflict: boolean;
  readonly metadata: JsonValue;
  readonly createdAt: string;
}

export interface AddRecallExclusionInput {
  readonly exclusionId?: string;
  readonly contextPackId?: string | null;
  readonly memoryId?: string | null;
  readonly sourcePlane: MemoryPlane;
  readonly reason: string;
  readonly evidenceId?: string | null;
  readonly lifecycleState?: string | null;
  readonly conflictRef?: string | null;
  readonly supersededByMemoryId?: string | null;
  readonly metadata?: JsonValue;
  readonly createdAt?: string;
}

export interface RecallExclusionRecord {
  readonly exclusionId: string;
  readonly contextPackId: string | null;
  readonly memoryId: string | null;
  readonly sourcePlane: MemoryPlane;
  readonly reason: string;
  readonly evidenceId: string | null;
  readonly lifecycleState: string | null;
  readonly conflictRef: string | null;
  readonly supersededByMemoryId: string | null;
  readonly metadata: JsonValue;
  readonly createdAt: string;
}

export interface RecordMemoryUsageInput {
  readonly usageEventId?: string;
  readonly sessionId?: string | null;
  readonly contextPackId?: string | null;
  readonly memoryId?: string | null;
  readonly eventType: string;
  readonly proofRef?: string | null;
  readonly payload?: JsonValue;
  readonly createdAt?: string;
}

export interface MemoryUsageEventRecord {
  readonly usageEventId: string;
  readonly sessionId: string | null;
  readonly contextPackId: string | null;
  readonly memoryId: string | null;
  readonly eventType: string;
  readonly proofRef: string | null;
  readonly payload: JsonValue;
  readonly createdAt: string;
}

export interface RecordMemoryIngestInput {
  readonly ingestEventId?: string;
  readonly sessionId?: string | null;
  readonly memoryId?: string | null;
  readonly eventType: string;
  readonly outcome: string;
  readonly payload?: JsonValue;
  readonly createdAt?: string;
}

export interface MemoryIngestEventRecord {
  readonly ingestEventId: string;
  readonly sessionId: string | null;
  readonly memoryId: string | null;
  readonly eventType: string;
  readonly outcome: string;
  readonly payload: JsonValue;
  readonly createdAt: string;
}

export interface RecordViolationInput {
  readonly violationId?: string;
  readonly sessionId?: string | null;
  readonly violationType: string;
  readonly severity: ViolationSeverity;
  readonly summary: string;
  readonly payload?: JsonValue;
  readonly createdAt?: string;
  readonly resolvedAt?: string | null;
}

export interface AgentContractViolationRecord {
  readonly violationId: string;
  readonly sessionId: string | null;
  readonly violationType: string;
  readonly severity: ViolationSeverity;
  readonly summary: string;
  readonly payload: JsonValue;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface RecordPortabilityMetadataInput {
  readonly metadataId?: string;
  readonly operationId: string;
  readonly operationType: PortabilityOperationType;
  readonly status: PortabilityOperationStatus;
  readonly filePath?: string | null;
  readonly bundleVersion?: string | null;
  readonly itemCounts?: JsonValue;
  readonly metadata?: JsonValue;
  readonly createdAt?: string;
  readonly finishedAt?: string | null;
}

export interface PortabilityMetadataRecord {
  readonly metadataId: string;
  readonly operationId: string;
  readonly operationType: PortabilityOperationType;
  readonly status: PortabilityOperationStatus;
  readonly filePath: string | null;
  readonly bundleVersion: string | null;
  readonly itemCounts: JsonValue;
  readonly metadata: JsonValue;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

interface ScopeRow {
  readonly scope_id: string;
  readonly plane: string;
  readonly scope_kind: string;
  readonly scope_ref: string;
  readonly parent_scope_id: string | null;
  readonly metadata_json: string;
  readonly created_at: string;
}

interface MemoryRow {
  readonly memory_id: string;
  readonly plane: string;
  readonly scope_id: string | null;
  readonly title: string;
  readonly body: string;
  readonly source_type: string;
  readonly source_ref: string;
  readonly lifecycle_state: string;
  readonly governance_state: string;
  readonly strength: number;
  readonly sensitivity: string;
  readonly metadata_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface EvidenceRow {
  readonly evidence_id: string;
  readonly memory_id: string;
  readonly source_type: string;
  readonly source_ref: string;
  readonly payload_json: string;
  readonly created_at: string;
}

interface AuditEventRow {
  readonly audit_event_id: string;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly actor_ref: string | null;
  readonly payload_json: string;
  readonly created_at: string;
}

interface MemoryEdgeRow {
  readonly edge_id: string;
  readonly from_memory_id: string;
  readonly to_memory_id: string;
  readonly edge_type: string;
  readonly strength: number;
  readonly metadata_json: string;
  readonly created_at: string;
}

interface MemorySessionRow {
  readonly session_id: string;
  readonly agent_kind: string;
  readonly client_version: string | null;
  readonly mode: string;
  readonly host_ref: string | null;
  readonly project_ref: string | null;
  readonly workspace_ref: string | null;
  readonly context_pack_id: string | null;
  readonly usage_state: string;
  readonly post_run_ingest_state: string;
  readonly violation_summary_json: string;
  readonly metadata_json: string;
  readonly started_at: string;
  readonly finished_at: string | null;
}

interface ContextPackRow {
  readonly context_pack_id: string;
  readonly session_id: string | null;
  readonly request_id: string | null;
  readonly query_text: string;
  readonly task_summary: string | null;
  readonly plane_policy_json: string;
  readonly recall_policy_version: string;
  readonly included_count: number;
  readonly excluded_count: number;
  readonly explanation_summary: string;
  readonly metadata_json: string;
  readonly created_at: string;
}

interface ContextPackEntryRow {
  readonly entry_id: string;
  readonly context_pack_id: string;
  readonly memory_id: string;
  readonly memory_plane: string;
  readonly usage_recommendation: string;
  readonly score: number;
  readonly rank: number;
  readonly reason: string;
  readonly source_refs_json: string;
  readonly is_stale: number;
  readonly is_sensitive: number;
  readonly has_conflict: number;
  readonly metadata_json: string;
  readonly created_at: string;
}

interface RecallExclusionRow {
  readonly exclusion_id: string;
  readonly context_pack_id: string | null;
  readonly memory_id: string | null;
  readonly source_plane: string;
  readonly reason: string;
  readonly evidence_id: string | null;
  readonly lifecycle_state: string | null;
  readonly conflict_ref: string | null;
  readonly superseded_by_memory_id: string | null;
  readonly metadata_json: string;
  readonly created_at: string;
}

interface MemoryUsageEventRow {
  readonly usage_event_id: string;
  readonly session_id: string | null;
  readonly context_pack_id: string | null;
  readonly memory_id: string | null;
  readonly event_type: string;
  readonly proof_ref: string | null;
  readonly payload_json: string;
  readonly created_at: string;
}

interface MemoryIngestEventRow {
  readonly ingest_event_id: string;
  readonly session_id: string | null;
  readonly memory_id: string | null;
  readonly event_type: string;
  readonly outcome: string;
  readonly payload_json: string;
  readonly created_at: string;
}

interface AgentContractViolationRow {
  readonly violation_id: string;
  readonly session_id: string | null;
  readonly violation_type: string;
  readonly severity: string;
  readonly summary: string;
  readonly payload_json: string;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

interface PortabilityMetadataRow {
  readonly metadata_id: string;
  readonly operation_id: string;
  readonly operation_type: string;
  readonly status: string;
  readonly file_path: string | null;
  readonly bundle_version: string | null;
  readonly item_counts_json: string;
  readonly metadata_json: string;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export class SqliteSoulMemoryStorage {
  private readonly databasePath: string;
  private readonly now: () => string;

  public constructor(
    private readonly db: DatabaseSync,
    options: Required<Pick<SoulMemoryStorageOptions, "migrate" | "now">> & {
      readonly path: string;
    }
  ) {
    this.databasePath = options.path;
    this.now = options.now;

    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");

    if (options.migrate) {
      migrateStorage(this.db, this.now);
    }
  }

  public close(): void {
    this.db.close();
  }

  public health(): StorageHealth {
    return {
      ok: true,
      schemaVersion: getSchemaVersion(this.db),
      path: this.databasePath
    };
  }

  public transaction<T>(work: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  public createScope(input: CreateScopeInput): ScopeRecord {
    const record = {
      scopeId: input.scopeId ?? randomUUID(),
      plane: input.plane,
      scopeKind: requireNonEmptyString(input.scopeKind, "scope kind"),
      scopeRef: requireNonEmptyString(input.scopeRef, "scope ref"),
      parentScopeId: input.parentScopeId ?? null,
      metadataJson: stringifyJson(input.metadata ?? {}, "scope metadata"),
      createdAt: input.createdAt ?? this.now()
    };

    try {
      this.db
        .prepare(
          `
          INSERT INTO scopes (
            scope_id, plane, scope_kind, scope_ref, parent_scope_id, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          record.scopeId,
          record.plane,
          record.scopeKind,
          record.scopeRef,
          record.parentScopeId,
          record.metadataJson,
          record.createdAt
        );
    } catch (error) {
      throw queryError(`Failed to create scope ${record.scopeId}.`, error);
    }

    const created = this.getScope(record.scopeId);
    if (created === null) {
      throw new StorageError("NOT_FOUND", `Scope ${record.scopeId} was not found after insert.`);
    }

    return created;
  }

  public getScope(scopeId: string): ScopeRecord | null {
    const row = this.db
      .prepare("SELECT * FROM scopes WHERE scope_id = ? LIMIT 1")
      .get(requireNonEmptyString(scopeId, "scope id")) as ScopeRow | undefined;

    return row === undefined ? null : parseScopeRow(row);
  }

  public listScopes(plane?: MemoryPlane): readonly ScopeRecord[] {
    const rows =
      plane === undefined
        ? this.db.prepare("SELECT * FROM scopes ORDER BY created_at ASC, scope_id ASC").all()
        : this.db
            .prepare("SELECT * FROM scopes WHERE plane = ? ORDER BY created_at ASC, scope_id ASC")
            .all(plane);

    return (rows as unknown as ScopeRow[]).map(parseScopeRow);
  }

  public createMemory(input: CreateMemoryInput): MemoryRecord {
    const timestamp = input.createdAt ?? this.now();
    const record = {
      memoryId: input.memoryId ?? randomUUID(),
      plane: input.plane,
      scopeId: input.scopeId ?? null,
      title: requireNonEmptyString(input.title, "memory title"),
      body: requireNonEmptyString(input.body, "memory body"),
      sourceType: requireNonEmptyString(input.sourceType, "memory source type"),
      sourceRef: requireNonEmptyString(input.sourceRef, "memory source ref"),
      lifecycleState: input.lifecycleState ?? "active",
      governanceState: input.governanceState ?? "pending",
      strength: input.strength ?? 1,
      sensitivity: input.sensitivity ?? "normal",
      metadataJson: stringifyJson(input.metadata ?? {}, "memory metadata"),
      createdAt: timestamp,
      updatedAt: input.updatedAt ?? timestamp
    };

    try {
      this.db
        .prepare(
          `
          INSERT INTO memories (
            memory_id, plane, scope_id, title, body, source_type, source_ref,
            lifecycle_state, governance_state, strength, sensitivity, metadata_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          record.memoryId,
          record.plane,
          record.scopeId,
          record.title,
          record.body,
          record.sourceType,
          record.sourceRef,
          record.lifecycleState,
          record.governanceState,
          record.strength,
          record.sensitivity,
          record.metadataJson,
          record.createdAt,
          record.updatedAt
        );
    } catch (error) {
      throw queryError(`Failed to create memory ${record.memoryId}.`, error);
    }

    const created = this.getMemory(record.memoryId);
    if (created === null) {
      throw new StorageError("NOT_FOUND", `Memory ${record.memoryId} was not found after insert.`);
    }

    return created;
  }

  public getMemory(memoryId: string): MemoryRecord | null {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE memory_id = ? LIMIT 1")
      .get(requireNonEmptyString(memoryId, "memory id")) as MemoryRow | undefined;

    return row === undefined ? null : parseMemoryRow(row);
  }

  public updateMemory(memoryId: string, input: UpdateMemoryInput): MemoryRecord {
    const current = this.getMemory(memoryId);
    if (current === null) {
      throw new StorageError("NOT_FOUND", `Memory ${memoryId} was not found.`);
    }

    const next = {
      title: input.title ?? current.title,
      body: input.body ?? current.body,
      lifecycleState: input.lifecycleState ?? current.lifecycleState,
      governanceState: input.governanceState ?? current.governanceState,
      strength: input.strength ?? current.strength,
      sensitivity: input.sensitivity ?? current.sensitivity,
      metadataJson: stringifyJson(input.metadata ?? current.metadata, "memory metadata"),
      updatedAt: input.updatedAt ?? this.now()
    };

    try {
      this.db
        .prepare(
          `
          UPDATE memories
          SET title = ?,
              body = ?,
              lifecycle_state = ?,
              governance_state = ?,
              strength = ?,
              sensitivity = ?,
              metadata_json = ?,
              updated_at = ?
          WHERE memory_id = ?
        `
        )
        .run(
          next.title,
          next.body,
          next.lifecycleState,
          next.governanceState,
          next.strength,
          next.sensitivity,
          next.metadataJson,
          next.updatedAt,
          current.memoryId
        );
    } catch (error) {
      throw queryError(`Failed to update memory ${current.memoryId}.`, error);
    }

    const updated = this.getMemory(current.memoryId);
    if (updated === null) {
      throw new StorageError("NOT_FOUND", `Memory ${current.memoryId} was not found after update.`);
    }

    return updated;
  }

  public listMemories(filter: ListMemoryFilter = {}): readonly MemoryRecord[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];

    addOptionalWhere(clauses, params, "plane = ?", filter.plane);
    addOptionalWhere(clauses, params, "scope_id = ?", filter.scopeId);
    addOptionalWhere(clauses, params, "lifecycle_state = ?", filter.lifecycleState);
    addOptionalWhere(clauses, params, "governance_state = ?", filter.governanceState);

    const limit = normalizeLimit(filter.limit);
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM memories
        ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY updated_at DESC, memory_id ASC
        LIMIT ?
      `
      )
      .all(...params, limit) as unknown as MemoryRow[];

    return rows.map(parseMemoryRow);
  }

  public searchMemories(query: string, filter: ListMemoryFilter = {}): readonly MemoryRecord[] {
    const terms = requireNonEmptyString(query, "memory search query")
      .split(/\s+/u)
      .map((term) => term.trim())
      .filter((term) => term.length > 0);
    const clauses: string[] = [];
    const params: SqlParam[] = [];

    for (const term of terms) {
      const pattern = `%${escapeLike(term)}%`;
      clauses.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }

    addOptionalWhere(clauses, params, "plane = ?", filter.plane);
    addOptionalWhere(clauses, params, "scope_id = ?", filter.scopeId);
    addOptionalWhere(clauses, params, "lifecycle_state = ?", filter.lifecycleState);
    addOptionalWhere(clauses, params, "governance_state = ?", filter.governanceState);

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM memories
        WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC, memory_id ASC
        LIMIT ?
      `
      )
      .all(...params, normalizeLimit(filter.limit)) as unknown as MemoryRow[];

    return rows.map(parseMemoryRow);
  }

  public addEvidence(input: CreateEvidenceInput): EvidenceRecord {
    const evidenceId = input.evidenceId ?? randomUUID();

    try {
      this.db
        .prepare(
          `
          INSERT INTO evidence (
            evidence_id, memory_id, source_type, source_ref, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          evidenceId,
          requireNonEmptyString(input.memoryId, "memory id"),
          requireNonEmptyString(input.sourceType, "evidence source type"),
          requireNonEmptyString(input.sourceRef, "evidence source ref"),
          stringifyJson(input.payload, "evidence payload"),
          input.createdAt ?? this.now()
        );
    } catch (error) {
      throw queryError(`Failed to add evidence ${evidenceId}.`, error);
    }

    const created = this.getEvidence(evidenceId);
    if (created === null) {
      throw new StorageError("NOT_FOUND", `Evidence ${evidenceId} was not found after insert.`);
    }

    return created;
  }

  public getEvidence(evidenceId: string): EvidenceRecord | null {
    const row = this.db
      .prepare("SELECT * FROM evidence WHERE evidence_id = ? LIMIT 1")
      .get(requireNonEmptyString(evidenceId, "evidence id")) as EvidenceRow | undefined;

    return row === undefined ? null : parseEvidenceRow(row);
  }

  public listEvidence(memoryId: string): readonly EvidenceRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM evidence WHERE memory_id = ? ORDER BY created_at ASC, evidence_id ASC")
      .all(requireNonEmptyString(memoryId, "memory id")) as unknown as EvidenceRow[];

    return rows.map(parseEvidenceRow);
  }

  public addAuditEvent(input: CreateAuditEventInput): AuditEventRecord {
    const auditEventId = input.auditEventId ?? randomUUID();

    try {
      this.db
        .prepare(
          `
          INSERT INTO audit_events (
            audit_event_id, event_type, entity_type, entity_id, actor_ref, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          auditEventId,
          requireNonEmptyString(input.eventType, "audit event type"),
          requireNonEmptyString(input.entityType, "audit entity type"),
          requireNonEmptyString(input.entityId, "audit entity id"),
          input.actorRef ?? null,
          stringifyJson(input.payload ?? {}, "audit event payload"),
          input.createdAt ?? this.now()
        );
    } catch (error) {
      throw queryError(`Failed to add audit event ${auditEventId}.`, error);
    }

    const created = this.getAuditEvent(auditEventId);
    if (created === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Audit event ${auditEventId} was not found after insert.`
      );
    }

    return created;
  }

  public getAuditEvent(auditEventId: string): AuditEventRecord | null {
    const row = this.db
      .prepare("SELECT * FROM audit_events WHERE audit_event_id = ? LIMIT 1")
      .get(requireNonEmptyString(auditEventId, "audit event id")) as AuditEventRow | undefined;

    return row === undefined ? null : parseAuditEventRow(row);
  }

  public listAuditEvents(filter: AuditEventFilter = {}): readonly AuditEventRecord[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];

    addOptionalWhere(clauses, params, "entity_type = ?", filter.entityType);
    addOptionalWhere(clauses, params, "entity_id = ?", filter.entityId);
    addOptionalWhere(clauses, params, "event_type = ?", filter.eventType);

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM audit_events
        ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at DESC, audit_event_id ASC
        LIMIT ?
      `
      )
      .all(...params, normalizeLimit(filter.limit)) as unknown as AuditEventRow[];

    return rows.map(parseAuditEventRow);
  }

  public createMemoryEdge(input: CreateMemoryEdgeInput): MemoryEdgeRecord {
    const edgeId = input.edgeId ?? randomUUID();

    try {
      this.db
        .prepare(
          `
          INSERT INTO memory_edges (
            edge_id, from_memory_id, to_memory_id, edge_type, strength, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          edgeId,
          requireNonEmptyString(input.fromMemoryId, "from memory id"),
          requireNonEmptyString(input.toMemoryId, "to memory id"),
          requireNonEmptyString(input.edgeType, "edge type"),
          input.strength ?? 1,
          stringifyJson(input.metadata ?? {}, "memory edge metadata"),
          input.createdAt ?? this.now()
        );
    } catch (error) {
      throw queryError(`Failed to create memory edge ${edgeId}.`, error);
    }

    const created = this.getMemoryEdge(edgeId);
    if (created === null) {
      throw new StorageError("NOT_FOUND", `Memory edge ${edgeId} was not found after insert.`);
    }

    return created;
  }

  public getMemoryEdge(edgeId: string): MemoryEdgeRecord | null {
    const row = this.db
      .prepare("SELECT * FROM memory_edges WHERE edge_id = ? LIMIT 1")
      .get(requireNonEmptyString(edgeId, "edge id")) as MemoryEdgeRow | undefined;

    return row === undefined ? null : parseMemoryEdgeRow(row);
  }

  public listMemoryEdges(memoryId?: string): readonly MemoryEdgeRecord[] {
    const rows =
      memoryId === undefined
        ? this.db
            .prepare("SELECT * FROM memory_edges ORDER BY created_at ASC, edge_id ASC")
            .all()
        : this.db
            .prepare(
              `
              SELECT *
              FROM memory_edges
              WHERE from_memory_id = ? OR to_memory_id = ?
              ORDER BY created_at ASC, edge_id ASC
            `
            )
            .all(memoryId, memoryId);

    return (rows as unknown as MemoryEdgeRow[]).map(parseMemoryEdgeRow);
  }

  public startMemorySession(input: StartMemorySessionInput): MemorySessionRecord {
    const sessionId = input.sessionId ?? randomUUID();

    try {
      this.db
        .prepare(
          `
          INSERT INTO memory_sessions (
            session_id, agent_kind, client_version, mode, host_ref, project_ref,
            workspace_ref, context_pack_id, usage_state, post_run_ingest_state,
            violation_summary_json, metadata_json, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `
        )
        .run(
          sessionId,
          requireNonEmptyString(input.agentKind, "agent kind"),
          input.clientVersion ?? null,
          input.mode,
          input.hostRef ?? null,
          input.projectRef ?? null,
          input.workspaceRef ?? null,
          input.contextPackId ?? null,
          input.usageState ?? "pending",
          input.postRunIngestState ?? "pending",
          stringifyJson(input.violationSummary ?? {}, "violation summary"),
          stringifyJson(input.metadata ?? {}, "session metadata"),
          input.startedAt ?? this.now()
        );
    } catch (error) {
      throw queryError(`Failed to start memory session ${sessionId}.`, error);
    }

    const created = this.getMemorySession(sessionId);
    if (created === null) {
      throw new StorageError("NOT_FOUND", `Session ${sessionId} was not found after insert.`);
    }

    return created;
  }

  public finishMemorySession(
    sessionId: string,
    input: FinishMemorySessionInput
  ): MemorySessionRecord {
    const current = this.getMemorySession(sessionId);
    if (current === null) {
      throw new StorageError("NOT_FOUND", `Session ${sessionId} was not found.`);
    }

    try {
      this.db
        .prepare(
          `
          UPDATE memory_sessions
          SET context_pack_id = ?,
              usage_state = ?,
              post_run_ingest_state = ?,
              violation_summary_json = ?,
              finished_at = ?
          WHERE session_id = ?
        `
        )
        .run(
          input.contextPackId ?? current.contextPackId,
          input.usageState ?? current.usageState,
          input.postRunIngestState ?? current.postRunIngestState,
          stringifyJson(
            input.violationSummary ?? current.violationSummary,
            "session violation summary"
          ),
          input.finishedAt ?? this.now(),
          current.sessionId
        );
    } catch (error) {
      throw queryError(`Failed to finish memory session ${current.sessionId}.`, error);
    }

    const updated = this.getMemorySession(current.sessionId);
    if (updated === null) {
      throw new StorageError("NOT_FOUND", `Session ${current.sessionId} was not found.`);
    }

    return updated;
  }

  public updateMemorySession(
    sessionId: string,
    input: UpdateMemorySessionInput
  ): MemorySessionRecord {
    const current = this.getMemorySession(sessionId);
    if (current === null) {
      throw new StorageError("NOT_FOUND", `Session ${sessionId} was not found.`);
    }

    try {
      this.db
        .prepare(
          `
          UPDATE memory_sessions
          SET context_pack_id = ?,
              usage_state = ?,
              post_run_ingest_state = ?,
              violation_summary_json = ?
          WHERE session_id = ?
        `
        )
        .run(
          input.contextPackId ?? current.contextPackId,
          input.usageState ?? current.usageState,
          input.postRunIngestState ?? current.postRunIngestState,
          stringifyJson(
            input.violationSummary ?? current.violationSummary,
            "session violation summary"
          ),
          current.sessionId
        );
    } catch (error) {
      throw queryError(`Failed to update memory session ${current.sessionId}.`, error);
    }

    const updated = this.getMemorySession(current.sessionId);
    if (updated === null) {
      throw new StorageError("NOT_FOUND", `Session ${current.sessionId} was not found.`);
    }

    return updated;
  }

  public getMemorySession(sessionId: string): MemorySessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM memory_sessions WHERE session_id = ? LIMIT 1")
      .get(requireNonEmptyString(sessionId, "session id")) as MemorySessionRow | undefined;

    return row === undefined ? null : parseMemorySessionRow(row);
  }

  public listMemorySessions(limit?: number): readonly MemorySessionRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM memory_sessions
        ORDER BY started_at ASC, session_id ASC
        LIMIT ?
      `
      )
      .all(normalizeLimit(limit)) as unknown as MemorySessionRow[];

    return rows.map(parseMemorySessionRow);
  }

  public createContextPack(input: CreateContextPackInput): ContextPackRecord {
    const contextPackId = input.contextPackId ?? randomUUID();

    try {
      this.db
        .prepare(
          `
          INSERT INTO context_packs (
            context_pack_id, session_id, request_id, query_text, task_summary,
            plane_policy_json, recall_policy_version, explanation_summary,
            metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          contextPackId,
          input.sessionId ?? null,
          input.requestId ?? null,
          requireNonEmptyString(input.queryText, "context pack query text"),
          input.taskSummary ?? null,
          stringifyJson(input.planePolicy ?? {}, "context pack plane policy"),
          requireNonEmptyString(input.recallPolicyVersion, "recall policy version"),
          requireNonEmptyString(input.explanationSummary, "context pack explanation"),
          stringifyJson(input.metadata ?? {}, "context pack metadata"),
          input.createdAt ?? this.now()
        );
    } catch (error) {
      throw queryError(`Failed to create context pack ${contextPackId}.`, error);
    }

    const created = this.getContextPack(contextPackId);
    if (created === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Context pack ${contextPackId} was not found after insert.`
      );
    }

    return created;
  }

  public addContextPackEntry(input: AddContextPackEntryInput): ContextPackEntryRecord {
    const entryId = input.entryId ?? randomUUID();

    try {
      this.db
        .prepare(
          `
          INSERT INTO context_pack_entries (
            entry_id, context_pack_id, memory_id, memory_plane, usage_recommendation,
            score, rank, reason, source_refs_json, is_stale, is_sensitive, has_conflict,
            metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          entryId,
          requireNonEmptyString(input.contextPackId, "context pack id"),
          requireNonEmptyString(input.memoryId, "memory id"),
          input.memoryPlane,
          input.usageRecommendation,
          input.score ?? 0,
          input.rank,
          requireNonEmptyString(input.reason, "context pack entry reason"),
          stringifyJson(input.sourceRefs ?? [], "context pack source refs"),
          toSqliteBoolean(input.isStale ?? false),
          toSqliteBoolean(input.isSensitive ?? false),
          toSqliteBoolean(input.hasConflict ?? false),
          stringifyJson(input.metadata ?? {}, "context pack entry metadata"),
          input.createdAt ?? this.now()
        );

      this.refreshContextPackCounts(input.contextPackId);
    } catch (error) {
      throw queryError(`Failed to add context pack entry ${entryId}.`, error);
    }

    const created = this.getContextPackEntry(entryId);
    if (created === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Context pack entry ${entryId} was not found after insert.`
      );
    }

    return created;
  }

  public addRecallExclusion(input: AddRecallExclusionInput): RecallExclusionRecord {
    const exclusionId = input.exclusionId ?? randomUUID();

    try {
      this.db
        .prepare(
          `
          INSERT INTO recall_exclusions (
            exclusion_id, context_pack_id, memory_id, source_plane, reason, evidence_id,
            lifecycle_state, conflict_ref, superseded_by_memory_id, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          exclusionId,
          input.contextPackId ?? null,
          input.memoryId ?? null,
          input.sourcePlane,
          requireNonEmptyString(input.reason, "recall exclusion reason"),
          input.evidenceId ?? null,
          input.lifecycleState ?? null,
          input.conflictRef ?? null,
          input.supersededByMemoryId ?? null,
          stringifyJson(input.metadata ?? {}, "recall exclusion metadata"),
          input.createdAt ?? this.now()
        );

      if (input.contextPackId !== undefined && input.contextPackId !== null) {
        this.refreshContextPackCounts(input.contextPackId);
      }
    } catch (error) {
      throw queryError(`Failed to add recall exclusion ${exclusionId}.`, error);
    }

    const created = this.getRecallExclusion(exclusionId);
    if (created === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Recall exclusion ${exclusionId} was not found after insert.`
      );
    }

    return created;
  }

  public getContextPack(contextPackId: string): ContextPackRecord | null {
    const row = this.db
      .prepare("SELECT * FROM context_packs WHERE context_pack_id = ? LIMIT 1")
      .get(requireNonEmptyString(contextPackId, "context pack id")) as
      | ContextPackRow
      | undefined;

    if (row === undefined) {
      return null;
    }

    return parseContextPackRow(row, {
      entries: this.listContextPackEntries(row.context_pack_id),
      exclusions: this.listRecallExclusions({ contextPackId: row.context_pack_id })
    });
  }

  public listContextPacks(filter: {
    readonly sessionId?: string;
    readonly limit?: number;
  } = {}): readonly ContextPackRecord[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];

    addOptionalWhere(clauses, params, "session_id = ?", filter.sessionId);

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM context_packs
        ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at ASC, context_pack_id ASC
        LIMIT ?
      `
      )
      .all(...params, normalizeLimit(filter.limit)) as unknown as ContextPackRow[];

    return rows.map((row) =>
      parseContextPackRow(row, {
        entries: this.listContextPackEntries(row.context_pack_id),
        exclusions: this.listRecallExclusions({ contextPackId: row.context_pack_id })
      })
    );
  }

  public getContextPackEntry(entryId: string): ContextPackEntryRecord | null {
    const row = this.db
      .prepare("SELECT * FROM context_pack_entries WHERE entry_id = ? LIMIT 1")
      .get(requireNonEmptyString(entryId, "context pack entry id")) as
      | ContextPackEntryRow
      | undefined;

    return row === undefined ? null : parseContextPackEntryRow(row);
  }

  public listContextPackEntries(contextPackId: string): readonly ContextPackEntryRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM context_pack_entries
        WHERE context_pack_id = ?
        ORDER BY rank ASC, created_at ASC, entry_id ASC
      `
      )
      .all(requireNonEmptyString(contextPackId, "context pack id")) as unknown as ContextPackEntryRow[];

    return rows.map(parseContextPackEntryRow);
  }

  public getRecallExclusion(exclusionId: string): RecallExclusionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM recall_exclusions WHERE exclusion_id = ? LIMIT 1")
      .get(requireNonEmptyString(exclusionId, "recall exclusion id")) as
      | RecallExclusionRow
      | undefined;

    return row === undefined ? null : parseRecallExclusionRow(row);
  }

  public listRecallExclusions(filter: {
    readonly contextPackId?: string;
    readonly memoryId?: string;
    readonly limit?: number;
  } = {}): readonly RecallExclusionRecord[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];

    addOptionalWhere(clauses, params, "context_pack_id = ?", filter.contextPackId);
    addOptionalWhere(clauses, params, "memory_id = ?", filter.memoryId);

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM recall_exclusions
        ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at DESC, exclusion_id ASC
        LIMIT ?
      `
      )
      .all(...params, normalizeLimit(filter.limit)) as unknown as RecallExclusionRow[];

    return rows.map(parseRecallExclusionRow);
  }

  public recordMemoryUsage(input: RecordMemoryUsageInput): MemoryUsageEventRecord {
    const usageEventId = input.usageEventId ?? randomUUID();

    try {
      this.db
        .prepare(
          `
          INSERT INTO memory_usage_events (
            usage_event_id, session_id, context_pack_id, memory_id, event_type,
            proof_ref, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          usageEventId,
          input.sessionId ?? null,
          input.contextPackId ?? null,
          input.memoryId ?? null,
          requireNonEmptyString(input.eventType, "memory usage event type"),
          input.proofRef ?? null,
          stringifyJson(input.payload ?? {}, "memory usage payload"),
          input.createdAt ?? this.now()
        );
    } catch (error) {
      throw queryError(`Failed to record memory usage event ${usageEventId}.`, error);
    }

    const created = this.getMemoryUsageEvent(usageEventId);
    if (created === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Memory usage event ${usageEventId} was not found after insert.`
      );
    }

    return created;
  }

  public getMemoryUsageEvent(usageEventId: string): MemoryUsageEventRecord | null {
    const row = this.db
      .prepare("SELECT * FROM memory_usage_events WHERE usage_event_id = ? LIMIT 1")
      .get(requireNonEmptyString(usageEventId, "usage event id")) as
      | MemoryUsageEventRow
      | undefined;

    return row === undefined ? null : parseMemoryUsageEventRow(row);
  }

  public listMemoryUsageEvents(filter: {
    readonly sessionId?: string;
    readonly contextPackId?: string;
    readonly memoryId?: string;
    readonly limit?: number;
  } = {}): readonly MemoryUsageEventRecord[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];

    addOptionalWhere(clauses, params, "session_id = ?", filter.sessionId);
    addOptionalWhere(clauses, params, "context_pack_id = ?", filter.contextPackId);
    addOptionalWhere(clauses, params, "memory_id = ?", filter.memoryId);

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM memory_usage_events
        ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at ASC, usage_event_id ASC
        LIMIT ?
      `
      )
      .all(...params, normalizeLimit(filter.limit)) as unknown as MemoryUsageEventRow[];

    return rows.map(parseMemoryUsageEventRow);
  }

  public recordMemoryIngest(input: RecordMemoryIngestInput): MemoryIngestEventRecord {
    const ingestEventId = input.ingestEventId ?? randomUUID();

    try {
      this.db
        .prepare(
          `
          INSERT INTO memory_ingest_events (
            ingest_event_id, session_id, memory_id, event_type, outcome, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          ingestEventId,
          input.sessionId ?? null,
          input.memoryId ?? null,
          requireNonEmptyString(input.eventType, "memory ingest event type"),
          requireNonEmptyString(input.outcome, "memory ingest outcome"),
          stringifyJson(input.payload ?? {}, "memory ingest payload"),
          input.createdAt ?? this.now()
        );
    } catch (error) {
      throw queryError(`Failed to record memory ingest event ${ingestEventId}.`, error);
    }

    const created = this.getMemoryIngestEvent(ingestEventId);
    if (created === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Memory ingest event ${ingestEventId} was not found after insert.`
      );
    }

    return created;
  }

  public getMemoryIngestEvent(ingestEventId: string): MemoryIngestEventRecord | null {
    const row = this.db
      .prepare("SELECT * FROM memory_ingest_events WHERE ingest_event_id = ? LIMIT 1")
      .get(requireNonEmptyString(ingestEventId, "ingest event id")) as
      | MemoryIngestEventRow
      | undefined;

    return row === undefined ? null : parseMemoryIngestEventRow(row);
  }

  public listMemoryIngestEvents(filter: {
    readonly sessionId?: string;
    readonly memoryId?: string;
    readonly limit?: number;
  } = {}): readonly MemoryIngestEventRecord[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];

    addOptionalWhere(clauses, params, "session_id = ?", filter.sessionId);
    addOptionalWhere(clauses, params, "memory_id = ?", filter.memoryId);

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM memory_ingest_events
        ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at ASC, ingest_event_id ASC
        LIMIT ?
      `
      )
      .all(...params, normalizeLimit(filter.limit)) as unknown as MemoryIngestEventRow[];

    return rows.map(parseMemoryIngestEventRow);
  }

  public recordViolation(input: RecordViolationInput): AgentContractViolationRecord {
    const violationId = input.violationId ?? randomUUID();

    try {
      this.db
        .prepare(
          `
          INSERT INTO agent_contract_violations (
            violation_id, session_id, violation_type, severity, summary, payload_json,
            created_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          violationId,
          input.sessionId ?? null,
          requireNonEmptyString(input.violationType, "violation type"),
          input.severity,
          requireNonEmptyString(input.summary, "violation summary"),
          stringifyJson(input.payload ?? {}, "violation payload"),
          input.createdAt ?? this.now(),
          input.resolvedAt ?? null
        );
    } catch (error) {
      throw queryError(`Failed to record violation ${violationId}.`, error);
    }

    const created = this.getViolation(violationId);
    if (created === null) {
      throw new StorageError("NOT_FOUND", `Violation ${violationId} was not found after insert.`);
    }

    return created;
  }

  public getViolation(violationId: string): AgentContractViolationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM agent_contract_violations WHERE violation_id = ? LIMIT 1")
      .get(requireNonEmptyString(violationId, "violation id")) as
      | AgentContractViolationRow
      | undefined;

    return row === undefined ? null : parseViolationRow(row);
  }

  public listSessionViolations(sessionId: string): readonly AgentContractViolationRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM agent_contract_violations
        WHERE session_id = ?
        ORDER BY created_at DESC, violation_id ASC
      `
      )
      .all(requireNonEmptyString(sessionId, "session id")) as unknown as AgentContractViolationRow[];

    return rows.map(parseViolationRow);
  }

  public recordPortabilityMetadata(
    input: RecordPortabilityMetadataInput
  ): PortabilityMetadataRecord {
    const metadataId = input.metadataId ?? randomUUID();

    try {
      this.db
        .prepare(
          `
          INSERT INTO export_import_metadata (
            metadata_id, operation_id, operation_type, status, file_path, bundle_version,
            item_counts_json, metadata_json, created_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          metadataId,
          requireNonEmptyString(input.operationId, "operation id"),
          input.operationType,
          input.status,
          input.filePath ?? null,
          input.bundleVersion ?? null,
          stringifyJson(input.itemCounts ?? {}, "portability item counts"),
          stringifyJson(input.metadata ?? {}, "portability metadata"),
          input.createdAt ?? this.now(),
          input.finishedAt ?? null
        );
    } catch (error) {
      throw queryError(`Failed to record portability metadata ${metadataId}.`, error);
    }

    const created = this.getPortabilityMetadata(metadataId);
    if (created === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Portability metadata ${metadataId} was not found after insert.`
      );
    }

    return created;
  }

  public finishPortabilityMetadata(
    metadataId: string,
    input: {
      readonly status: PortabilityOperationStatus;
      readonly itemCounts?: JsonValue;
      readonly metadata?: JsonValue;
      readonly finishedAt?: string;
    }
  ): PortabilityMetadataRecord {
    const current = this.getPortabilityMetadata(metadataId);
    if (current === null) {
      throw new StorageError("NOT_FOUND", `Portability metadata ${metadataId} was not found.`);
    }

    try {
      this.db
        .prepare(
          `
          UPDATE export_import_metadata
          SET status = ?,
              item_counts_json = ?,
              metadata_json = ?,
              finished_at = ?
          WHERE metadata_id = ?
        `
        )
        .run(
          input.status,
          stringifyJson(input.itemCounts ?? current.itemCounts, "portability item counts"),
          stringifyJson(input.metadata ?? current.metadata, "portability metadata"),
          input.finishedAt ?? this.now(),
          current.metadataId
        );
    } catch (error) {
      throw queryError(`Failed to finish portability metadata ${current.metadataId}.`, error);
    }

    const updated = this.getPortabilityMetadata(current.metadataId);
    if (updated === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Portability metadata ${current.metadataId} was not found after update.`
      );
    }

    return updated;
  }

  public getPortabilityMetadata(metadataId: string): PortabilityMetadataRecord | null {
    const row = this.db
      .prepare("SELECT * FROM export_import_metadata WHERE metadata_id = ? LIMIT 1")
      .get(requireNonEmptyString(metadataId, "metadata id")) as
      | PortabilityMetadataRow
      | undefined;

    return row === undefined ? null : parsePortabilityMetadataRow(row);
  }

  public listPortabilityMetadata(
    operationId?: string
  ): readonly PortabilityMetadataRecord[] {
    const rows =
      operationId === undefined
        ? this.db
            .prepare("SELECT * FROM export_import_metadata ORDER BY created_at DESC, metadata_id ASC")
            .all()
        : this.db
            .prepare(
              `
              SELECT *
              FROM export_import_metadata
              WHERE operation_id = ?
              ORDER BY created_at DESC, metadata_id ASC
            `
            )
            .all(operationId);

    return (rows as unknown as PortabilityMetadataRow[]).map(parsePortabilityMetadataRow);
  }

  public async backupTo(targetPath: string): Promise<PortabilityMetadataRecord> {
    const backupPath = requireNonEmptyString(targetPath, "backup target path");
    await mkdir(dirname(backupPath), { recursive: true });

    const metadata = this.recordPortabilityMetadata({
      operationId: randomUUID(),
      operationType: "backup",
      status: "started",
      filePath: backupPath,
      bundleVersion: String(this.health().schemaVersion),
      createdAt: this.now()
    });

    try {
      await loadSqlite().backup(this.db, backupPath);
      return this.finishPortabilityMetadata(metadata.metadataId, {
        status: "completed",
        finishedAt: this.now()
      });
    } catch (error) {
      this.finishPortabilityMetadata(metadata.metadataId, {
        status: "failed",
        metadata: { error: error instanceof Error ? error.message : String(error) },
        finishedAt: this.now()
      });
      throw queryError(`Failed to back up database to ${backupPath}.`, error);
    }
  }

  private getContextPackEntryCount(contextPackId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM context_pack_entries WHERE context_pack_id = ?"
      )
      .get(contextPackId) as { readonly count: number } | undefined;

    return row?.count ?? 0;
  }

  private getRecallExclusionCount(contextPackId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM recall_exclusions WHERE context_pack_id = ?")
      .get(contextPackId) as { readonly count: number } | undefined;

    return row?.count ?? 0;
  }

  private refreshContextPackCounts(contextPackId: string): void {
    this.db
      .prepare(
        `
        UPDATE context_packs
        SET included_count = ?,
            excluded_count = ?
        WHERE context_pack_id = ?
      `
      )
      .run(
        this.getContextPackEntryCount(contextPackId),
        this.getRecallExclusionCount(contextPackId),
        contextPackId
      );
  }
}

export function createSoulMemoryStorage(
  options: SoulMemoryStorageOptions = {}
): SqliteSoulMemoryStorage {
  const databasePath = options.path ?? ":memory:";
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const db = new (loadSqlite().DatabaseSync)(databasePath);

  return new SqliteSoulMemoryStorage(db, {
    path: databasePath,
    now: options.now ?? (() => new Date().toISOString()),
    migrate: options.migrate ?? true
  });
}

function loadSqlite(): SqliteModule {
  sqliteModule ??= require("node:sqlite") as SqliteModule;
  return sqliteModule;
}

function parseScopeRow(row: ScopeRow): ScopeRecord {
  return {
    scopeId: row.scope_id,
    plane: row.plane as MemoryPlane,
    scopeKind: row.scope_kind,
    scopeRef: row.scope_ref,
    parentScopeId: row.parent_scope_id,
    metadata: parseJsonField(row.metadata_json, "scope metadata"),
    createdAt: row.created_at
  };
}

function parseMemoryRow(row: MemoryRow): MemoryRecord {
  return {
    memoryId: row.memory_id,
    plane: row.plane as MemoryPlane,
    scopeId: row.scope_id,
    title: row.title,
    body: row.body,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    lifecycleState: row.lifecycle_state as MemoryLifecycleState,
    governanceState: row.governance_state as MemoryGovernanceState,
    strength: row.strength,
    sensitivity: row.sensitivity as MemorySensitivity,
    metadata: parseJsonField(row.metadata_json, "memory metadata"),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseEvidenceRow(row: EvidenceRow): EvidenceRecord {
  return {
    evidenceId: row.evidence_id,
    memoryId: row.memory_id,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    payload: parseJsonField(row.payload_json, "evidence payload"),
    createdAt: row.created_at
  };
}

function parseAuditEventRow(row: AuditEventRow): AuditEventRecord {
  return {
    auditEventId: row.audit_event_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorRef: row.actor_ref,
    payload: parseJsonField(row.payload_json, "audit event payload"),
    createdAt: row.created_at
  };
}

function parseMemoryEdgeRow(row: MemoryEdgeRow): MemoryEdgeRecord {
  return {
    edgeId: row.edge_id,
    fromMemoryId: row.from_memory_id,
    toMemoryId: row.to_memory_id,
    edgeType: row.edge_type,
    strength: row.strength,
    metadata: parseJsonField(row.metadata_json, "memory edge metadata"),
    createdAt: row.created_at
  };
}

function parseMemorySessionRow(row: MemorySessionRow): MemorySessionRecord {
  return {
    sessionId: row.session_id,
    agentKind: row.agent_kind,
    clientVersion: row.client_version,
    mode: row.mode as SessionMode,
    hostRef: row.host_ref,
    projectRef: row.project_ref,
    workspaceRef: row.workspace_ref,
    contextPackId: row.context_pack_id,
    usageState: row.usage_state,
    postRunIngestState: row.post_run_ingest_state,
    violationSummary: parseJsonField(row.violation_summary_json, "session violation summary"),
    metadata: parseJsonField(row.metadata_json, "session metadata"),
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function parseContextPackRow(
  row: ContextPackRow,
  nested: {
    readonly entries: readonly ContextPackEntryRecord[];
    readonly exclusions: readonly RecallExclusionRecord[];
  }
): ContextPackRecord {
  return {
    contextPackId: row.context_pack_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    queryText: row.query_text,
    taskSummary: row.task_summary,
    planePolicy: parseJsonField(row.plane_policy_json, "context pack plane policy"),
    recallPolicyVersion: row.recall_policy_version,
    includedCount: row.included_count,
    excludedCount: row.excluded_count,
    explanationSummary: row.explanation_summary,
    metadata: parseJsonField(row.metadata_json, "context pack metadata"),
    createdAt: row.created_at,
    entries: nested.entries,
    exclusions: nested.exclusions
  };
}

function parseContextPackEntryRow(row: ContextPackEntryRow): ContextPackEntryRecord {
  return {
    entryId: row.entry_id,
    contextPackId: row.context_pack_id,
    memoryId: row.memory_id,
    memoryPlane: row.memory_plane as MemoryPlane,
    usageRecommendation: row.usage_recommendation as UsageRecommendation,
    score: row.score,
    rank: row.rank,
    reason: row.reason,
    sourceRefs: parseJsonField(row.source_refs_json, "context pack source refs"),
    isStale: fromSqliteBoolean(row.is_stale),
    isSensitive: fromSqliteBoolean(row.is_sensitive),
    hasConflict: fromSqliteBoolean(row.has_conflict),
    metadata: parseJsonField(row.metadata_json, "context pack entry metadata"),
    createdAt: row.created_at
  };
}

function parseRecallExclusionRow(row: RecallExclusionRow): RecallExclusionRecord {
  return {
    exclusionId: row.exclusion_id,
    contextPackId: row.context_pack_id,
    memoryId: row.memory_id,
    sourcePlane: row.source_plane as MemoryPlane,
    reason: row.reason,
    evidenceId: row.evidence_id,
    lifecycleState: row.lifecycle_state,
    conflictRef: row.conflict_ref,
    supersededByMemoryId: row.superseded_by_memory_id,
    metadata: parseJsonField(row.metadata_json, "recall exclusion metadata"),
    createdAt: row.created_at
  };
}

function parseMemoryUsageEventRow(row: MemoryUsageEventRow): MemoryUsageEventRecord {
  return {
    usageEventId: row.usage_event_id,
    sessionId: row.session_id,
    contextPackId: row.context_pack_id,
    memoryId: row.memory_id,
    eventType: row.event_type,
    proofRef: row.proof_ref,
    payload: parseJsonField(row.payload_json, "memory usage payload"),
    createdAt: row.created_at
  };
}

function parseMemoryIngestEventRow(row: MemoryIngestEventRow): MemoryIngestEventRecord {
  return {
    ingestEventId: row.ingest_event_id,
    sessionId: row.session_id,
    memoryId: row.memory_id,
    eventType: row.event_type,
    outcome: row.outcome,
    payload: parseJsonField(row.payload_json, "memory ingest payload"),
    createdAt: row.created_at
  };
}

function parseViolationRow(row: AgentContractViolationRow): AgentContractViolationRecord {
  return {
    violationId: row.violation_id,
    sessionId: row.session_id,
    violationType: row.violation_type,
    severity: row.severity as ViolationSeverity,
    summary: row.summary,
    payload: parseJsonField(row.payload_json, "violation payload"),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}

function parsePortabilityMetadataRow(row: PortabilityMetadataRow): PortabilityMetadataRecord {
  return {
    metadataId: row.metadata_id,
    operationId: row.operation_id,
    operationType: row.operation_type as PortabilityOperationType,
    status: row.status as PortabilityOperationStatus,
    filePath: row.file_path,
    bundleVersion: row.bundle_version,
    itemCounts: parseJsonField(row.item_counts_json, "portability item counts"),
    metadata: parseJsonField(row.metadata_json, "portability metadata"),
    createdAt: row.created_at,
    finishedAt: row.finished_at
  };
}

function requireNonEmptyString(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new StorageError("VALIDATION_FAILED", `Expected ${fieldName} to be non-empty.`);
  }

  return value;
}

function addOptionalWhere(
  clauses: string[],
  params: SqlParam[],
  clause: string,
  value: SqlParam | undefined
): void {
  if (value === undefined) {
    return;
  }

  clauses.push(clause);
  params.push(value);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 100;
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new StorageError("VALIDATION_FAILED", "Expected limit to be an integer from 1 to 1000.");
  }

  return limit;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function toSqliteBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function fromSqliteBoolean(value: number): boolean {
  return value === 1;
}

function queryError(message: string, error: unknown): StorageError {
  if (error instanceof StorageError) {
    return error;
  }

  return new StorageError("QUERY_FAILED", message, error);
}
