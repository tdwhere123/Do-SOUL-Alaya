import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuditEventWrite, AuditLogWriter } from "../runtime/audited-mutation.js";
import type {
  AlayaAuditEvidence,
  AlayaAuditSource,
  AlayaAuditTarget,
  AuditedMutationPhase,
  AuditedMutationRecord,
  AuditedMutationStatus
} from "../runtime/audit-types.js";
import type { JsonObject } from "../runtime/json.js";
import { redactJsonObject } from "../runtime/redaction.js";

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
  }
];

export class SqliteAlayaStorage implements AuditLogWriter {
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
    ...(event.input.actor === undefined ? {} : { actor: event.input.actor }),
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
