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

function failMissingGovernanceRecord(governanceEventId: string): never {
  throw new Error(`Governance record ${governanceEventId} was not found after insert.`);
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
