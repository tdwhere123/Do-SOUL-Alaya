import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuditEventWrite, AuditLogWriter } from "../runtime/audited-mutation.js";
import type { AtomicAuditLogWriter } from "../runtime/audited-mutation.js";
import type {
  AlayaAuditEvidence,
  AlayaAuditSource,
  AlayaAuditTarget,
  AuditedMutationPhase,
  AuditedMutationRecord,
  AuditedMutationStatus
} from "../runtime/audit-types.js";
import type { JsonObject } from "../runtime/json.js";
import { redactJsonObject, redactString } from "../runtime/redaction.js";

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (location: string) => SqliteDatabase;
}

export interface SqliteStorageOptions {
  readonly dataDir: string;
}

export interface AppliedMigration {
  readonly id: string;
  readonly appliedAt: string;
}

export interface StorageDoctorSnapshot {
  readonly driver: "node:sqlite";
  readonly database: "initialized";
  readonly migrations: readonly AppliedMigration[];
}

export type OntologyObjectKind =
  | "evidence_capsule"
  | "memory_entry"
  | "synthesis_capsule"
  | "claim_form";

export interface OntologyRecordWrite {
  readonly objectKind: OntologyObjectKind;
  readonly objectId: string;
  readonly workspaceId: string;
  readonly lifecycleState: string;
  readonly evidenceHealthState?: string | null;
  readonly payload: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OntologyRecordRead extends OntologyRecordWrite {}

export interface PathRelationRecordWrite {
  readonly pathId: string;
  readonly workspaceId: string;
  readonly sourceAnchorKey: string;
  readonly targetAnchorKey: string;
  readonly lifecycleState: string;
  readonly anchors: JsonObject;
  readonly constitution: JsonObject;
  readonly effectVector: JsonObject;
  readonly plasticityState: JsonObject;
  readonly lifecycle: JsonObject;
  readonly legitimacy: JsonObject;
  readonly payload: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PathRelationRecordRead extends PathRelationRecordWrite {}

export interface GovernanceRecordWrite {
  readonly governanceEventId: string;
  readonly workspaceId: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly outcome: string;
  readonly reason: string;
  readonly payload: JsonObject;
  readonly createdAt: string;
}

export interface GovernanceRecordRead extends GovernanceRecordWrite {}

export interface MemoryContentSearchRecord {
  readonly objectId: string;
  readonly workspaceId: string;
  readonly content: string;
  readonly lexicalScore: number;
}

export interface ContextPackRecordWrite {
  readonly contextPackId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly queryText: string;
  readonly includedMemoryIds: readonly string[];
  readonly payload: JsonObject;
  readonly replayFingerprint: string;
  readonly createdAt: string;
}

export interface ContextPackRecordRead extends ContextPackRecordWrite {}

export interface ProviderDecisionRecordWrite {
  readonly decisionId: string;
  readonly workspaceId: string;
  readonly capability: string;
  readonly selectedProviderId?: string | null;
  readonly outcome: string;
  readonly reason: string;
  readonly payload: JsonObject;
  readonly createdAt: string;
}

export interface ProviderDecisionRecordRead extends ProviderDecisionRecordWrite {}

export interface ProviderDecisionReplayScope {
  readonly requestFingerprint: string;
  readonly providersFingerprint: string;
}

export interface ProposalStorageRecordWrite {
  readonly proposalId: string;
  readonly workspaceId: string;
  readonly providerDecisionId?: string | null;
  readonly runId?: string | null;
  readonly status: string;
  readonly targetId?: string | null;
  readonly payload: JsonObject;
  readonly replayFingerprint: string;
  readonly createdAt: string;
}

export interface ProposalStorageRecordRead extends ProposalStorageRecordWrite {}

export interface SessionEventRecordWrite {
  readonly eventId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly eventKind: string;
  readonly terminal: boolean;
  readonly payload: JsonObject;
  readonly occurredAt: string;
}

export interface SessionEventRecordRead extends SessionEventRecordWrite {}

export interface ContextDeliveryStorageRecordWrite {
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly contextPackId: string;
  readonly outcome: string;
  readonly payload: JsonObject;
  readonly deliveredAt: string;
}

export interface ContextDeliveryStorageRecordRead extends ContextDeliveryStorageRecordWrite {}

export interface UsageProofStorageRecordWrite {
  readonly proofId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly proofKind: string;
  readonly strength: string;
  readonly payload: JsonObject;
  readonly observedAt: string;
}

export interface UsageProofStorageRecordRead extends UsageProofStorageRecordWrite {}

export interface TrustSummaryStorageRecordWrite {
  readonly summaryId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly trustState: string;
  readonly payload: JsonObject;
  readonly replayFingerprint: string;
  readonly generatedAt: string;
}

export interface TrustSummaryStorageRecordRead extends TrustSummaryStorageRecordWrite {}

const databaseFileName = "alaya.sqlite";

const migrations: readonly { id: string; sql: string }[] = [
  {
    id: "001-runtime-truth-kernel-baseline",
    sql: `
      CREATE TABLE IF NOT EXISTS alaya_audit_events (
        audit_event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_event_id TEXT NOT NULL UNIQUE,
        mutation_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        mutation_kind TEXT NOT NULL,
        source_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        actor TEXT,
        target_json TEXT,
        payload_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_alaya_audit_events_mutation
        ON alaya_audit_events (mutation_id, audit_event_sequence);
    `
  },
  {
    id: "002-ontology",
    sql: `
      CREATE TABLE IF NOT EXISTS ontology_records (
        object_kind TEXT NOT NULL,
        object_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL,
        evidence_health_state TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (object_kind, object_id),
        CHECK (object_kind IN ('evidence_capsule', 'memory_entry', 'synthesis_capsule', 'claim_form'))
      );

      CREATE INDEX IF NOT EXISTS idx_ontology_records_workspace_kind
        ON ontology_records (workspace_id, object_kind, created_at, object_id);

      CREATE INDEX IF NOT EXISTS idx_ontology_records_evidence_health
        ON ontology_records (object_kind, evidence_health_state)
        WHERE object_kind = 'evidence_capsule';
    `
  },
  {
    id: "003-structure",
    sql: `
      CREATE TABLE IF NOT EXISTS path_relations (
        path_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_anchor_key TEXT NOT NULL,
        target_anchor_key TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL,
        anchors_json TEXT NOT NULL,
        constitution_json TEXT NOT NULL,
        effect_vector_json TEXT NOT NULL,
        plasticity_state_json TEXT NOT NULL,
        lifecycle_json TEXT NOT NULL,
        legitimacy_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_path_relations_workspace_created
        ON path_relations (workspace_id, created_at, path_id);

      CREATE INDEX IF NOT EXISTS idx_path_relations_workspace_active
        ON path_relations (workspace_id, lifecycle_state, created_at, path_id);

      CREATE INDEX IF NOT EXISTS idx_path_relations_source_anchor
        ON path_relations (workspace_id, source_anchor_key, created_at, path_id);

      CREATE INDEX IF NOT EXISTS idx_path_relations_target_anchor
        ON path_relations (workspace_id, target_anchor_key, created_at, path_id);
    `
  },
  {
    id: "004-governance",
    sql: `
      CREATE TABLE IF NOT EXISTS governance_records (
        governance_event_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_governance_records_workspace_created
        ON governance_records (workspace_id, created_at, governance_event_id);

      CREATE INDEX IF NOT EXISTS idx_governance_records_target
        ON governance_records (target_type, target_id);
    `
  },
  {
    id: "005-recall-context",
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_content_fts USING fts5(
        object_id UNINDEXED,
        workspace_id UNINDEXED,
        content,
        tokenize = 'trigram'
      );

      INSERT INTO memory_content_fts (rowid, object_id, workspace_id, content)
      SELECT rowid, object_id, workspace_id, json_extract(payload_json, '$.content')
      FROM ontology_records
      WHERE object_kind = 'memory_entry'
        AND json_extract(payload_json, '$.content') IS NOT NULL;

      CREATE TRIGGER IF NOT EXISTS memory_content_fts_ai
      AFTER INSERT ON ontology_records
      WHEN new.object_kind = 'memory_entry'
      BEGIN
        INSERT INTO memory_content_fts (rowid, object_id, workspace_id, content)
        VALUES (new.rowid, new.object_id, new.workspace_id, json_extract(new.payload_json, '$.content'));
      END;

      CREATE TRIGGER IF NOT EXISTS memory_content_fts_ad
      AFTER DELETE ON ontology_records
      WHEN old.object_kind = 'memory_entry'
      BEGIN
        DELETE FROM memory_content_fts WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS memory_content_fts_au
      AFTER UPDATE OF object_id, workspace_id, payload_json ON ontology_records
      WHEN old.object_kind = 'memory_entry' OR new.object_kind = 'memory_entry'
      BEGIN
        DELETE FROM memory_content_fts WHERE rowid = old.rowid;
        INSERT INTO memory_content_fts (rowid, object_id, workspace_id, content)
        SELECT new.rowid, new.object_id, new.workspace_id, json_extract(new.payload_json, '$.content')
        WHERE new.object_kind = 'memory_entry'
          AND json_extract(new.payload_json, '$.content') IS NOT NULL;
      END;

      CREATE TABLE IF NOT EXISTS context_pack_records (
        context_pack_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        query_text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_context_pack_records_workspace_run
        ON context_pack_records (workspace_id, run_id, created_at, context_pack_id);
    `
  },
  {
    id: "006-provider-proposal",
    sql: `
      CREATE TABLE IF NOT EXISTS provider_decision_records (
        decision_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        selected_provider_id TEXT,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_provider_decision_records_workspace
        ON provider_decision_records (workspace_id, created_at, decision_id);

      CREATE TABLE IF NOT EXISTS proposal_records (
        proposal_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        provider_decision_id TEXT,
        status TEXT NOT NULL,
        target_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_proposal_records_workspace
        ON proposal_records (workspace_id, created_at, proposal_id);

      CREATE INDEX IF NOT EXISTS idx_proposal_records_provider_decision
        ON proposal_records (provider_decision_id);
    `
  },
  {
    id: "007-session-trust",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_session_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_session_events_session
        ON memory_session_events (session_id, occurred_at, event_id);

      CREATE TABLE IF NOT EXISTS context_delivery_records (
        delivery_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        context_pack_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        delivered_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_context_delivery_records_session
        ON context_delivery_records (session_id, delivered_at, delivery_id);

      CREATE TABLE IF NOT EXISTS usage_proof_records (
        proof_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        proof_kind TEXT NOT NULL,
        strength TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_proof_records_session
        ON usage_proof_records (session_id, observed_at, proof_id);

      CREATE TABLE IF NOT EXISTS trust_summary_records (
        summary_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        trust_state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trust_summary_records_session
        ON trust_summary_records (session_id, generated_at, summary_id);
    `
  },
  {
    id: "008-runtime-use-proof-lineage-replay",
    sql: `
      ALTER TABLE context_pack_records
        ADD COLUMN included_memory_ids_json TEXT NOT NULL DEFAULT '[]';

      ALTER TABLE context_pack_records
        ADD COLUMN replay_fingerprint TEXT NOT NULL DEFAULT '';

      ALTER TABLE proposal_records
        ADD COLUMN run_id TEXT;

      ALTER TABLE proposal_records
        ADD COLUMN replay_fingerprint TEXT NOT NULL DEFAULT '';

      ALTER TABLE trust_summary_records
        ADD COLUMN replay_fingerprint TEXT NOT NULL DEFAULT '';
    `
  }
];

export class SqliteAlayaStorage implements AtomicAuditLogWriter {
  private constructor(
    private readonly database: SqliteDatabase,
    public readonly databasePath: string
  ) {}

  public static async open(options: SqliteStorageOptions): Promise<SqliteAlayaStorage> {
    if (options.dataDir.trim().length === 0) {
      throw new Error("dataDir is required.");
    }

    const dataDir = resolve(options.dataDir);
    await mkdir(dataDir, { recursive: true });
    const sqlite = await loadSqlite();
    const databasePath = join(dataDir, databaseFileName);
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON;");
    const storage = new SqliteAlayaStorage(database, databasePath);
    storage.runMigrations();
    return storage;
  }

  public async appendAuditEvent(event: AuditEventWrite): Promise<AuditedMutationRecord> {
    const record = toAuditRecord(event);
    this.database.prepare(
      `INSERT INTO alaya_audit_events (
        audit_event_id,
        mutation_id,
        phase,
        status,
        mutation_kind,
        source_json,
        evidence_json,
        actor,
        target_json,
        payload_json,
        error_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.auditEventId,
      record.mutationId,
      record.phase,
      record.status,
      record.mutationKind,
      JSON.stringify(record.source),
      JSON.stringify(record.evidence),
      record.actor ?? null,
      record.target === undefined ? null : JSON.stringify(record.target),
      record.payload === undefined ? null : JSON.stringify(record.payload),
      record.error === undefined ? null : JSON.stringify(record.error),
      record.createdAt
    );
    return record;
  }

  public async executeAtomic<T>(operation: () => Promise<T> | T): Promise<T> {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = await operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  public listAuditEventsForMutation(mutationId: string): readonly AuditedMutationRecord[] {
    return this.database
      .prepare(
        `SELECT
          audit_event_id,
          mutation_id,
          phase,
          status,
          mutation_kind,
          source_json,
          evidence_json,
          actor,
          target_json,
          payload_json,
          error_json,
          created_at
        FROM alaya_audit_events
        WHERE mutation_id = ?
        ORDER BY audit_event_sequence ASC`
      )
      .all(mutationId)
      .map(rowToAuditRecord);
  }

  public createOntologyRecord(record: OntologyRecordWrite): OntologyRecordRead {
    this.database.prepare(
      `INSERT INTO ontology_records (
        object_kind,
        object_id,
        workspace_id,
        lifecycle_state,
        evidence_health_state,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.objectKind,
      record.objectId,
      record.workspaceId,
      record.lifecycleState,
      record.evidenceHealthState ?? null,
      JSON.stringify(record.payload),
      record.createdAt,
      record.updatedAt
    );

    const inserted = this.findOntologyRecord(record.objectKind, record.objectId);
    if (inserted === null) {
      throw new Error(`Ontology record ${record.objectKind}:${record.objectId} was not found after insert.`);
    }
    return inserted;
  }

  public findOntologyRecord(
    objectKind: OntologyObjectKind,
    objectId: string
  ): OntologyRecordRead | null {
    const row = this.database
      .prepare(
        `SELECT
          object_kind,
          object_id,
          workspace_id,
          lifecycle_state,
          evidence_health_state,
          payload_json,
          created_at,
          updated_at
        FROM ontology_records
        WHERE object_kind = ? AND object_id = ?
        LIMIT 1`
      )
      .get(objectKind, objectId);
    return row === undefined ? null : rowToOntologyRecord(row);
  }

  public listOntologyRecords(
    objectKind: OntologyObjectKind,
    workspaceId?: string
  ): readonly OntologyRecordRead[] {
    if (workspaceId === undefined) {
      return this.database
        .prepare(
          `SELECT
            object_kind,
            object_id,
            workspace_id,
            lifecycle_state,
            evidence_health_state,
            payload_json,
            created_at,
            updated_at
          FROM ontology_records
          WHERE object_kind = ?
          ORDER BY created_at ASC, object_id ASC`
        )
        .all(objectKind)
        .map(rowToOntologyRecord);
    }

    return this.database
      .prepare(
        `SELECT
          object_kind,
          object_id,
          workspace_id,
          lifecycle_state,
          evidence_health_state,
          payload_json,
          created_at,
          updated_at
        FROM ontology_records
        WHERE object_kind = ? AND workspace_id = ?
        ORDER BY created_at ASC, object_id ASC`
      )
      .all(objectKind, workspaceId)
      .map(rowToOntologyRecord);
  }

  public searchMemoryContent(
    workspaceId: string,
    queryText: string,
    limit: number
  ): readonly MemoryContentSearchRecord[] {
    const normalizedQuery = queryText.trim();
    if (normalizedQuery.length === 0 || limit < 1) {
      return [];
    }

    const exactStatement = this.database.prepare(
      `SELECT
        object_id,
        workspace_id,
        content,
        0 AS lexical_score
      FROM memory_content_fts
      WHERE workspace_id = ? AND content LIKE ? ESCAPE '^'
      ORDER BY object_id ASC
      LIMIT ?`
    );
    const exactRows = mergeSearchRows([], searchTerms(normalizedQuery).flatMap((term) => exactStatement
      .all(workspaceId, `%${escapeLike(term)}%`, limit)
      .map(rowToMemoryContentSearchRecord)), limit);

    if ([...normalizedQuery].length < 3) {
      return exactRows;
    }

    try {
      const ftsRows = this.database
        .prepare(
          `SELECT
            object_id,
            workspace_id,
            content,
            bm25(memory_content_fts) AS lexical_score
          FROM memory_content_fts
          WHERE workspace_id = ? AND memory_content_fts MATCH ?
          ORDER BY lexical_score ASC, object_id ASC
          LIMIT ?`
        )
        .all(workspaceId, quoteFtsPhrase(normalizedQuery), limit)
        .map(rowToMemoryContentSearchRecord);
      return mergeSearchRows(exactRows, ftsRows, limit);
    } catch {
      return exactRows;
    }
  }

  public createPathRelationRecord(record: PathRelationRecordWrite): PathRelationRecordRead {
    this.database.prepare(
      `INSERT INTO path_relations (
        path_id,
        workspace_id,
        source_anchor_key,
        target_anchor_key,
        lifecycle_state,
        anchors_json,
        constitution_json,
        effect_vector_json,
        plasticity_state_json,
        lifecycle_json,
        legitimacy_json,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.pathId,
      record.workspaceId,
      record.sourceAnchorKey,
      record.targetAnchorKey,
      record.lifecycleState,
      JSON.stringify(record.anchors),
      JSON.stringify(record.constitution),
      JSON.stringify(record.effectVector),
      JSON.stringify(record.plasticityState),
      JSON.stringify(record.lifecycle),
      JSON.stringify(record.legitimacy),
      JSON.stringify(record.payload),
      record.createdAt,
      record.updatedAt
    );

    const inserted = this.findPathRelationRecordById(record.pathId);
    if (inserted === null) {
      throw new Error(`Path relation ${record.pathId} was not found after insert.`);
    }
    return inserted;
  }

  public findPathRelationRecordById(pathId: string): PathRelationRecordRead | null {
    const row = this.database
      .prepare(
        `SELECT
          path_id,
          workspace_id,
          source_anchor_key,
          target_anchor_key,
          lifecycle_state,
          anchors_json,
          constitution_json,
          effect_vector_json,
          plasticity_state_json,
          lifecycle_json,
          legitimacy_json,
          payload_json,
          created_at,
          updated_at
        FROM path_relations
        WHERE path_id = ?
        LIMIT 1`
      )
      .get(pathId);
    return row === undefined ? null : rowToPathRelationRecord(row);
  }

  public listPathRelationRecords(workspaceId: string): readonly PathRelationRecordRead[] {
    return this.database
      .prepare(
        `SELECT
          path_id,
          workspace_id,
          source_anchor_key,
          target_anchor_key,
          lifecycle_state,
          anchors_json,
          constitution_json,
          effect_vector_json,
          plasticity_state_json,
          lifecycle_json,
          legitimacy_json,
          payload_json,
          created_at,
          updated_at
        FROM path_relations
        WHERE workspace_id = ?
        ORDER BY created_at ASC, path_id ASC`
      )
      .all(workspaceId)
      .map(rowToPathRelationRecord);
  }

  public listActivePathRelationRecords(workspaceId: string): readonly PathRelationRecordRead[] {
    return this.database
      .prepare(
        `SELECT
          path_id,
          workspace_id,
          source_anchor_key,
          target_anchor_key,
          lifecycle_state,
          anchors_json,
          constitution_json,
          effect_vector_json,
          plasticity_state_json,
          lifecycle_json,
          legitimacy_json,
          payload_json,
          created_at,
          updated_at
        FROM path_relations
        WHERE workspace_id = ? AND lifecycle_state = 'active'
        ORDER BY created_at ASC, path_id ASC`
      )
      .all(workspaceId)
      .map(rowToPathRelationRecord);
  }

  public listPathRelationRecordsByAnchor(
    workspaceId: string,
    anchorKey: string
  ): readonly PathRelationRecordRead[] {
    return this.database
      .prepare(
        `SELECT
          path_id,
          workspace_id,
          source_anchor_key,
          target_anchor_key,
          lifecycle_state,
          anchors_json,
          constitution_json,
          effect_vector_json,
          plasticity_state_json,
          lifecycle_json,
          legitimacy_json,
          payload_json,
          created_at,
          updated_at
        FROM path_relations
        WHERE workspace_id = ?
          AND (source_anchor_key = ? OR target_anchor_key = ?)
        ORDER BY created_at ASC, path_id ASC`
      )
      .all(workspaceId, anchorKey, anchorKey)
      .map(rowToPathRelationRecord);
  }

  public createGovernanceRecord(record: GovernanceRecordWrite): GovernanceRecordRead {
    this.database.prepare(
      `INSERT INTO governance_records (
        governance_event_id,
        workspace_id,
        target_type,
        target_id,
        outcome,
        reason,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.governanceEventId,
      record.workspaceId,
      record.targetType,
      record.targetId ?? null,
      record.outcome,
      record.reason,
      JSON.stringify(redactJsonObject(record.payload)),
      record.createdAt
    );

    return rowToGovernanceRecord(
      this.database
        .prepare(
          `SELECT
            governance_event_id,
            workspace_id,
            target_type,
            target_id,
            outcome,
            reason,
            payload_json,
            created_at
          FROM governance_records
          WHERE governance_event_id = ?
          LIMIT 1`
        )
        .get(record.governanceEventId) ?? failMissingGovernanceRecord(record.governanceEventId)
    );
  }

  public listGovernanceRecords(workspaceId: string): readonly GovernanceRecordRead[] {
    return this.database
      .prepare(
        `SELECT
          governance_event_id,
          workspace_id,
          target_type,
          target_id,
          outcome,
          reason,
          payload_json,
          created_at
        FROM governance_records
        WHERE workspace_id = ?
        ORDER BY created_at ASC, governance_event_id ASC`
      )
      .all(workspaceId)
      .map(rowToGovernanceRecord);
  }

  public findLatestGovernanceRecordForTarget(
    workspaceId: string,
    targetId: string,
    targetType?: string
  ): GovernanceRecordRead | null {
    if (targetType !== undefined) {
      const row = this.database
        .prepare(
          `SELECT
            governance_event_id,
            workspace_id,
            target_type,
            target_id,
            outcome,
            reason,
            payload_json,
            created_at
          FROM governance_records
          WHERE workspace_id = ?
            AND target_id = ?
            AND target_type = ?
          ORDER BY created_at DESC, governance_event_id DESC
          LIMIT 1`
        )
        .get(workspaceId, targetId, targetType);
      return row === undefined ? null : rowToGovernanceRecord(row);
    }

    const row = this.database
      .prepare(
        `SELECT
          governance_event_id,
          workspace_id,
          target_type,
          target_id,
          outcome,
          reason,
          payload_json,
          created_at
        FROM governance_records
        WHERE workspace_id = ?
          AND target_id = ?
        ORDER BY created_at DESC, governance_event_id DESC
        LIMIT 1`
      )
      .get(workspaceId, targetId);
    return row === undefined ? null : rowToGovernanceRecord(row);
  }

  public createContextPackRecord(record: ContextPackRecordWrite): ContextPackRecordRead {
    this.database.prepare(
      `INSERT INTO context_pack_records (
        context_pack_id,
        workspace_id,
        run_id,
        query_text,
        included_memory_ids_json,
        payload_json,
        replay_fingerprint,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.contextPackId,
      record.workspaceId,
      record.runId,
      record.queryText,
      JSON.stringify(record.includedMemoryIds),
      JSON.stringify(redactJsonObject(record.payload)),
      record.replayFingerprint,
      record.createdAt
    );

    return rowToContextPackRecord(
      this.database
        .prepare(
          `SELECT
            context_pack_id,
            workspace_id,
            run_id,
            query_text,
            included_memory_ids_json,
            payload_json,
            replay_fingerprint,
            created_at
          FROM context_pack_records
          WHERE context_pack_id = ?
          LIMIT 1`
        )
        .get(record.contextPackId) ?? failMissingRecord("Context pack", record.contextPackId)
    );
  }

  public findContextPackRecord(
    contextPackId: string,
    workspaceId: string
  ): ContextPackRecordRead | null {
    const row = this.database
      .prepare(
        `SELECT
          context_pack_id,
          workspace_id,
          run_id,
          query_text,
          included_memory_ids_json,
          payload_json,
          replay_fingerprint,
          created_at
        FROM context_pack_records
        WHERE context_pack_id = ?
          AND workspace_id = ?
        LIMIT 1`
      )
      .get(contextPackId, workspaceId);
    return row === undefined ? null : rowToContextPackRecord(row);
  }

  public createProviderDecisionRecord(record: ProviderDecisionRecordWrite): ProviderDecisionRecordRead {
    this.database.prepare(
      `INSERT INTO provider_decision_records (
        decision_id,
        workspace_id,
        capability,
        selected_provider_id,
        outcome,
        reason,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.decisionId,
      record.workspaceId,
      record.capability,
      record.selectedProviderId ?? null,
      record.outcome,
      record.reason,
      JSON.stringify(redactJsonObject(record.payload)),
      record.createdAt
    );

    return rowToProviderDecisionRecord(
      this.database
        .prepare(
          `SELECT
            decision_id,
            workspace_id,
            capability,
            selected_provider_id,
            outcome,
            reason,
            payload_json,
            created_at
          FROM provider_decision_records
          WHERE decision_id = ?
          LIMIT 1`
        )
        .get(record.decisionId) ?? failMissingRecord("Provider decision", record.decisionId)
    );
  }

  public findProviderDecisionRecord(
    decisionId: string,
    workspaceId: string
  ): ProviderDecisionRecordRead | null {
    const row = this.database
      .prepare(
        `SELECT
          decision_id,
          workspace_id,
          capability,
          selected_provider_id,
          outcome,
          reason,
          payload_json,
          created_at
        FROM provider_decision_records
        WHERE decision_id = ?
          AND workspace_id = ?
        LIMIT 1`
      )
      .get(decisionId, workspaceId);
    return row === undefined ? null : rowToProviderDecisionRecord(row);
  }

  public findProviderDecisionReplayScope(
    decisionId: string,
    workspaceId: string
  ): ProviderDecisionReplayScope | null {
    const record = this.findProviderDecisionRecord(decisionId, workspaceId);
    if (record === null) {
      return null;
    }
    const payload = record.payload as {
      readonly replay_scope?: {
        readonly request_fingerprint?: unknown;
        readonly providers_fingerprint?: unknown;
      };
    };
    const requestFingerprint = payload.replay_scope?.request_fingerprint;
    const providersFingerprint = payload.replay_scope?.providers_fingerprint;
    if (typeof requestFingerprint !== "string" || typeof providersFingerprint !== "string") {
      throw new Error(`Provider decision ${decisionId} is missing replay scope.`);
    }
    return {
      providersFingerprint,
      requestFingerprint
    };
  }

  public createProposalRecord(record: ProposalStorageRecordWrite): ProposalStorageRecordRead {
    this.database.prepare(
      `INSERT INTO proposal_records (
        proposal_id,
        workspace_id,
        provider_decision_id,
        run_id,
        status,
        target_id,
        payload_json,
        replay_fingerprint,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.proposalId,
      record.workspaceId,
      record.providerDecisionId ?? null,
      record.runId ?? null,
      record.status,
      record.targetId ?? null,
      JSON.stringify(redactJsonObject(record.payload)),
      record.replayFingerprint,
      record.createdAt
    );

    return rowToProposalStorageRecord(
      this.database
        .prepare(
          `SELECT
            proposal_id,
            workspace_id,
            provider_decision_id,
            run_id,
            status,
            target_id,
            payload_json,
            replay_fingerprint,
            created_at
          FROM proposal_records
          WHERE proposal_id = ?
          LIMIT 1`
        )
        .get(record.proposalId) ?? failMissingRecord("Proposal", record.proposalId)
    );
  }

  public findProposalRecord(
    proposalId: string,
    workspaceId: string
  ): ProposalStorageRecordRead | null {
    const row = this.database
      .prepare(
        `SELECT
          proposal_id,
          workspace_id,
          provider_decision_id,
          run_id,
          status,
          target_id,
          payload_json,
          replay_fingerprint,
          created_at
        FROM proposal_records
        WHERE proposal_id = ?
          AND workspace_id = ?
        LIMIT 1`
      )
      .get(proposalId, workspaceId);
    return row === undefined ? null : rowToProposalStorageRecord(row);
  }

  public createSessionEventRecord(record: SessionEventRecordWrite): SessionEventRecordRead {
    this.database.prepare(
      `INSERT INTO memory_session_events (
        event_id,
        session_id,
        workspace_id,
        run_id,
        event_kind,
        terminal,
        payload_json,
        occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.eventId,
      record.sessionId,
      record.workspaceId,
      record.runId,
      record.eventKind,
      record.terminal ? 1 : 0,
      JSON.stringify(record.payload),
      record.occurredAt
    );

    return rowToSessionEventRecord(
      this.database
        .prepare(
          `SELECT
            event_id,
            session_id,
            workspace_id,
            run_id,
            event_kind,
            terminal,
            payload_json,
            occurred_at
          FROM memory_session_events
          WHERE event_id = ?
          LIMIT 1`
        )
        .get(record.eventId) ?? failMissingRecord("Session event", record.eventId)
    );
  }

  public findSessionEventRecordById(eventId: string): SessionEventRecordRead | null {
    const row = this.database
      .prepare(
        `SELECT
          event_id,
          session_id,
          workspace_id,
          run_id,
          event_kind,
          terminal,
          payload_json,
          occurred_at
        FROM memory_session_events
        WHERE event_id = ?
        LIMIT 1`
      )
      .get(eventId);
    return row === undefined ? null : rowToSessionEventRecord(row);
  }

  public listSessionEventRecords(
    sessionId: string,
    scope?: { readonly workspaceId: string; readonly runId: string }
  ): readonly SessionEventRecordRead[] {
    if (scope !== undefined) {
      return this.database
        .prepare(
          `SELECT
            event_id,
            session_id,
            workspace_id,
            run_id,
            event_kind,
            terminal,
            payload_json,
            occurred_at
          FROM memory_session_events
          WHERE session_id = ?
            AND workspace_id = ?
            AND run_id = ?
          ORDER BY occurred_at ASC, event_id ASC`
        )
        .all(sessionId, scope.workspaceId, scope.runId)
        .map(rowToSessionEventRecord);
    }

    return this.database
      .prepare(
        `SELECT
          event_id,
          session_id,
          workspace_id,
          run_id,
          event_kind,
          terminal,
          payload_json,
          occurred_at
        FROM memory_session_events
        WHERE session_id = ?
        ORDER BY occurred_at ASC, event_id ASC`
      )
      .all(sessionId)
      .map(rowToSessionEventRecord);
  }

  public createContextDeliveryRecord(record: ContextDeliveryStorageRecordWrite): ContextDeliveryStorageRecordRead {
    this.database.prepare(
      `INSERT INTO context_delivery_records (
        delivery_id,
        session_id,
        workspace_id,
        run_id,
        context_pack_id,
        outcome,
        payload_json,
        delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.deliveryId,
      record.sessionId,
      record.workspaceId,
      record.runId,
      record.contextPackId,
      record.outcome,
      JSON.stringify(record.payload),
      record.deliveredAt
    );

    return rowToContextDeliveryStorageRecord(
      this.database
        .prepare(
          `SELECT
            delivery_id,
            session_id,
            workspace_id,
            run_id,
            context_pack_id,
            outcome,
            payload_json,
            delivered_at
          FROM context_delivery_records
          WHERE delivery_id = ?
          LIMIT 1`
        )
        .get(record.deliveryId) ?? failMissingRecord("Context delivery", record.deliveryId)
    );
  }

  public listContextDeliveryRecords(sessionId: string): readonly ContextDeliveryStorageRecordRead[] {
    return this.database
      .prepare(
        `SELECT
          delivery_id,
          session_id,
          workspace_id,
          run_id,
          context_pack_id,
          outcome,
          payload_json,
          delivered_at
        FROM context_delivery_records
        WHERE session_id = ?
        ORDER BY delivered_at ASC, delivery_id ASC`
      )
      .all(sessionId)
      .map(rowToContextDeliveryStorageRecord);
  }

  public createUsageProofRecord(record: UsageProofStorageRecordWrite): UsageProofStorageRecordRead {
    this.database.prepare(
      `INSERT INTO usage_proof_records (
        proof_id,
        session_id,
        workspace_id,
        run_id,
        proof_kind,
        strength,
        payload_json,
        observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.proofId,
      record.sessionId,
      record.workspaceId,
      record.runId,
      record.proofKind,
      record.strength,
      JSON.stringify(record.payload),
      record.observedAt
    );

    return rowToUsageProofStorageRecord(
      this.database
        .prepare(
          `SELECT
            proof_id,
            session_id,
            workspace_id,
            run_id,
            proof_kind,
            strength,
            payload_json,
            observed_at
          FROM usage_proof_records
          WHERE proof_id = ?
          LIMIT 1`
        )
        .get(record.proofId) ?? failMissingRecord("Usage proof", record.proofId)
    );
  }

  public listUsageProofRecords(sessionId: string): readonly UsageProofStorageRecordRead[] {
    return this.database
      .prepare(
        `SELECT
          proof_id,
          session_id,
          workspace_id,
          run_id,
          proof_kind,
          strength,
          payload_json,
          observed_at
        FROM usage_proof_records
        WHERE session_id = ?
        ORDER BY observed_at ASC, proof_id ASC`
      )
      .all(sessionId)
      .map(rowToUsageProofStorageRecord);
  }

  public createTrustSummaryRecord(record: TrustSummaryStorageRecordWrite): TrustSummaryStorageRecordRead {
    this.database.prepare(
      `INSERT INTO trust_summary_records (
        summary_id,
        session_id,
        workspace_id,
        run_id,
        trust_state,
        payload_json,
        replay_fingerprint,
        generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.summaryId,
      record.sessionId,
      record.workspaceId,
      record.runId,
      record.trustState,
      JSON.stringify(record.payload),
      record.replayFingerprint,
      record.generatedAt
    );

    return rowToTrustSummaryStorageRecord(
      this.database
        .prepare(
          `SELECT
            summary_id,
            session_id,
            workspace_id,
            run_id,
            trust_state,
            payload_json,
            replay_fingerprint,
            generated_at
          FROM trust_summary_records
          WHERE summary_id = ?
          LIMIT 1`
        )
        .get(record.summaryId) ?? failMissingRecord("Trust summary", record.summaryId)
    );
  }

  public findTrustSummaryRecord(
    summaryId: string,
    workspaceId: string
  ): TrustSummaryStorageRecordRead | null {
    const row = this.database
      .prepare(
        `SELECT
          summary_id,
          session_id,
          workspace_id,
          run_id,
          trust_state,
          payload_json,
          replay_fingerprint,
          generated_at
        FROM trust_summary_records
        WHERE summary_id = ?
          AND workspace_id = ?
        LIMIT 1`
      )
      .get(summaryId, workspaceId);
    return row === undefined ? null : rowToTrustSummaryStorageRecord(row);
  }

  public listAppliedMigrations(): readonly AppliedMigration[] {
    return this.database
      .prepare("SELECT id, applied_at FROM alaya_migrations ORDER BY id ASC")
      .all()
      .map((row) => ({
        id: textColumn(row, "id"),
        appliedAt: textColumn(row, "applied_at")
      }));
  }

  public getDoctorSnapshot(): StorageDoctorSnapshot {
    return {
      driver: "node:sqlite",
      database: "initialized",
      migrations: this.listAppliedMigrations()
    };
  }

  public close(): void {
    this.database.close();
  }

  private runMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS alaya_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    for (const migration of migrations) {
      const existing = this.database
        .prepare("SELECT id FROM alaya_migrations WHERE id = ?")
        .get(migration.id);
      if (existing !== undefined) {
        continue;
      }

      this.database.exec("BEGIN IMMEDIATE;");
      try {
        this.database.exec(migration.sql);
        this.database
          .prepare("INSERT INTO alaya_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, new Date().toISOString());
        this.database.exec("COMMIT;");
      } catch (error) {
        this.database.exec("ROLLBACK;");
        throw error;
      }
    }
  }
}

function toAuditRecord(event: AuditEventWrite): AuditedMutationRecord {
  return {
    auditEventId: randomUUID(),
    mutationId: event.mutationId,
    phase: event.phase,
    status: event.status,
    mutationKind: event.input.kind,
    source: redactJsonObject(event.input.source) as unknown as AlayaAuditSource,
    evidence: event.input.evidence.map((entry) => redactJsonObject(entry) as unknown as AlayaAuditEvidence),
    ...(event.input.actor === undefined ? {} : { actor: redactString(event.input.actor) }),
    ...(event.input.target === undefined
      ? {}
      : { target: redactJsonObject(event.input.target) as unknown as AlayaAuditTarget }),
    ...(event.input.payload === undefined ? {} : { payload: redactJsonObject(event.input.payload) }),
    ...(event.error === undefined ? {} : { error: event.error }),
    createdAt: new Date().toISOString()
  };
}

function rowToAuditRecord(row: Record<string, unknown>): AuditedMutationRecord {
  const targetJson = nullableTextColumn(row, "target_json");
  const payloadJson = nullableTextColumn(row, "payload_json");
  const errorJson = nullableTextColumn(row, "error_json");
  const actor = nullableTextColumn(row, "actor");
  return {
    auditEventId: textColumn(row, "audit_event_id"),
    mutationId: textColumn(row, "mutation_id"),
    phase: textColumn(row, "phase") as AuditedMutationPhase,
    status: textColumn(row, "status") as AuditedMutationStatus,
    mutationKind: textColumn(row, "mutation_kind"),
    source: JSON.parse(textColumn(row, "source_json")) as AlayaAuditSource,
    evidence: JSON.parse(textColumn(row, "evidence_json")) as AlayaAuditEvidence[],
    ...(actor === null ? {} : { actor }),
    ...(targetJson === null ? {} : { target: JSON.parse(targetJson) as AlayaAuditTarget }),
    ...(payloadJson === null ? {} : { payload: JSON.parse(payloadJson) as JsonObject }),
    ...(errorJson === null ? {} : { error: JSON.parse(errorJson) as JsonObject }),
    createdAt: textColumn(row, "created_at")
  };
}

function rowToOntologyRecord(row: Record<string, unknown>): OntologyRecordRead {
  const evidenceHealthState = nullableTextColumn(row, "evidence_health_state");
  return {
    objectKind: textColumn(row, "object_kind") as OntologyObjectKind,
    objectId: textColumn(row, "object_id"),
    workspaceId: textColumn(row, "workspace_id"),
    lifecycleState: textColumn(row, "lifecycle_state"),
    ...(evidenceHealthState === null ? {} : { evidenceHealthState }),
    payload: JSON.parse(textColumn(row, "payload_json")) as JsonObject,
    createdAt: textColumn(row, "created_at"),
    updatedAt: textColumn(row, "updated_at")
  };
}

function rowToMemoryContentSearchRecord(row: Record<string, unknown>): MemoryContentSearchRecord {
  return {
    objectId: textColumn(row, "object_id"),
    workspaceId: textColumn(row, "workspace_id"),
    content: textColumn(row, "content"),
    lexicalScore: numberColumn(row, "lexical_score")
  };
}

function rowToPathRelationRecord(row: Record<string, unknown>): PathRelationRecordRead {
  return {
    pathId: textColumn(row, "path_id"),
    workspaceId: textColumn(row, "workspace_id"),
    sourceAnchorKey: textColumn(row, "source_anchor_key"),
    targetAnchorKey: textColumn(row, "target_anchor_key"),
    lifecycleState: textColumn(row, "lifecycle_state"),
    anchors: JSON.parse(textColumn(row, "anchors_json")) as JsonObject,
    constitution: JSON.parse(textColumn(row, "constitution_json")) as JsonObject,
    effectVector: JSON.parse(textColumn(row, "effect_vector_json")) as JsonObject,
    plasticityState: JSON.parse(textColumn(row, "plasticity_state_json")) as JsonObject,
    lifecycle: JSON.parse(textColumn(row, "lifecycle_json")) as JsonObject,
    legitimacy: JSON.parse(textColumn(row, "legitimacy_json")) as JsonObject,
    payload: JSON.parse(textColumn(row, "payload_json")) as JsonObject,
    createdAt: textColumn(row, "created_at"),
    updatedAt: textColumn(row, "updated_at")
  };
}

function rowToContextPackRecord(row: Record<string, unknown>): ContextPackRecordRead {
  return {
    contextPackId: textColumn(row, "context_pack_id"),
    workspaceId: textColumn(row, "workspace_id"),
    runId: textColumn(row, "run_id"),
    queryText: textColumn(row, "query_text"),
    includedMemoryIds: JSON.parse(textColumn(row, "included_memory_ids_json")) as readonly string[],
    payload: JSON.parse(textColumn(row, "payload_json")) as JsonObject,
    replayFingerprint: textColumn(row, "replay_fingerprint"),
    createdAt: textColumn(row, "created_at")
  };
}

function rowToGovernanceRecord(row: Record<string, unknown>): GovernanceRecordRead {
  const targetId = nullableTextColumn(row, "target_id");
  return {
    governanceEventId: textColumn(row, "governance_event_id"),
    workspaceId: textColumn(row, "workspace_id"),
    targetType: textColumn(row, "target_type"),
    ...(targetId === null ? {} : { targetId }),
    outcome: textColumn(row, "outcome"),
    reason: textColumn(row, "reason"),
    payload: JSON.parse(textColumn(row, "payload_json")) as JsonObject,
    createdAt: textColumn(row, "created_at")
  };
}

function rowToProviderDecisionRecord(row: Record<string, unknown>): ProviderDecisionRecordRead {
  const selectedProviderId = nullableTextColumn(row, "selected_provider_id");
  return {
    decisionId: textColumn(row, "decision_id"),
    workspaceId: textColumn(row, "workspace_id"),
    capability: textColumn(row, "capability"),
    ...(selectedProviderId === null ? {} : { selectedProviderId }),
    outcome: textColumn(row, "outcome"),
    reason: textColumn(row, "reason"),
    payload: JSON.parse(textColumn(row, "payload_json")) as JsonObject,
    createdAt: textColumn(row, "created_at")
  };
}

function rowToProposalStorageRecord(row: Record<string, unknown>): ProposalStorageRecordRead {
  const providerDecisionId = nullableTextColumn(row, "provider_decision_id");
  const runId = nullableTextColumn(row, "run_id");
  const targetId = nullableTextColumn(row, "target_id");
  return {
    proposalId: textColumn(row, "proposal_id"),
    workspaceId: textColumn(row, "workspace_id"),
    ...(providerDecisionId === null ? {} : { providerDecisionId }),
    ...(runId === null ? {} : { runId }),
    status: textColumn(row, "status"),
    ...(targetId === null ? {} : { targetId }),
    payload: JSON.parse(textColumn(row, "payload_json")) as JsonObject,
    replayFingerprint: textColumn(row, "replay_fingerprint"),
    createdAt: textColumn(row, "created_at")
  };
}

function rowToSessionEventRecord(row: Record<string, unknown>): SessionEventRecordRead {
  return {
    eventId: textColumn(row, "event_id"),
    sessionId: textColumn(row, "session_id"),
    workspaceId: textColumn(row, "workspace_id"),
    runId: textColumn(row, "run_id"),
    eventKind: textColumn(row, "event_kind"),
    terminal: numberColumn(row, "terminal") === 1,
    payload: JSON.parse(textColumn(row, "payload_json")) as JsonObject,
    occurredAt: textColumn(row, "occurred_at")
  };
}

function rowToContextDeliveryStorageRecord(row: Record<string, unknown>): ContextDeliveryStorageRecordRead {
  return {
    deliveryId: textColumn(row, "delivery_id"),
    sessionId: textColumn(row, "session_id"),
    workspaceId: textColumn(row, "workspace_id"),
    runId: textColumn(row, "run_id"),
    contextPackId: textColumn(row, "context_pack_id"),
    outcome: textColumn(row, "outcome"),
    payload: JSON.parse(textColumn(row, "payload_json")) as JsonObject,
    deliveredAt: textColumn(row, "delivered_at")
  };
}

function rowToUsageProofStorageRecord(row: Record<string, unknown>): UsageProofStorageRecordRead {
  return {
    proofId: textColumn(row, "proof_id"),
    sessionId: textColumn(row, "session_id"),
    workspaceId: textColumn(row, "workspace_id"),
    runId: textColumn(row, "run_id"),
    proofKind: textColumn(row, "proof_kind"),
    strength: textColumn(row, "strength"),
    payload: JSON.parse(textColumn(row, "payload_json")) as JsonObject,
    observedAt: textColumn(row, "observed_at")
  };
}

function rowToTrustSummaryStorageRecord(row: Record<string, unknown>): TrustSummaryStorageRecordRead {
  return {
    summaryId: textColumn(row, "summary_id"),
    sessionId: textColumn(row, "session_id"),
    workspaceId: textColumn(row, "workspace_id"),
    runId: textColumn(row, "run_id"),
    trustState: textColumn(row, "trust_state"),
    payload: JSON.parse(textColumn(row, "payload_json")) as JsonObject,
    replayFingerprint: textColumn(row, "replay_fingerprint"),
    generatedAt: textColumn(row, "generated_at")
  };
}

function failMissingGovernanceRecord(governanceEventId: string): never {
  throw new Error(`Governance record ${governanceEventId} was not found after insert.`);
}

function failMissingRecord(recordType: string, id: string): never {
  throw new Error(`${recordType} ${id} was not found after insert.`);
}

async function loadSqlite(): Promise<SqliteModule> {
  return await import("node:" + "sqlite") as unknown as SqliteModule;
}

function textColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be text.`);
  }
  return value;
}

function nullableTextColumn(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be text or null.`);
  }
  return value;
}

function numberColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected SQLite column ${key} to be numeric.`);
  }
  return value;
}

function quoteFtsPhrase(query: string): string {
  return `"${query.replaceAll("\"", "\"\"")}"`;
}

function escapeLike(query: string): string {
  return query.replaceAll("^", "^^").replaceAll("%", "^%").replaceAll("_", "^_");
}

function searchTerms(query: string): readonly string[] {
  const matches = query.match(/[\p{L}\p{N}_]+/gu);
  if (matches === null) {
    return [query];
  }
  return [...new Set(matches.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function mergeSearchRows(
  exactRows: readonly MemoryContentSearchRecord[],
  ftsRows: readonly MemoryContentSearchRecord[],
  limit: number
): readonly MemoryContentSearchRecord[] {
  const rowsById = new Map<string, MemoryContentSearchRecord>();
  for (const row of [...exactRows, ...ftsRows]) {
    const existing = rowsById.get(row.objectId);
    if (existing === undefined || row.lexicalScore < existing.lexicalScore) {
      rowsById.set(row.objectId, row);
    }
  }
  return [...rowsById.values()]
    .sort((left, right) => {
      const scoreDelta = left.lexicalScore - right.lexicalScore;
      return scoreDelta === 0 ? left.objectId.localeCompare(right.objectId) : scoreDelta;
    })
    .slice(0, limit);
}
