import {
  ContextDeliveryRecordSchema,
  NonEmptyStringSchema,
  UsageProofRecordSchema,
  type ContextDeliveryRecord,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";

export interface TrustStateRepo {
  createDelivery(record: ContextDeliveryRecord): Promise<Readonly<ContextDeliveryRecord>>;
  createUsage(record: UsageProofRecord): Promise<Readonly<UsageProofRecord>>;
  findDeliveryById(deliveryId: string): Promise<Readonly<ContextDeliveryRecord> | null>;
  listDeliveriesByAgentTarget(agentTarget: string): Promise<readonly Readonly<ContextDeliveryRecord>[]>;
  listUsageByDeliveryIds(deliveryIds: readonly string[]): Promise<readonly Readonly<UsageProofRecord>[]>;
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly agent_target: string;
  readonly workspace_id: string | null;
  readonly run_id: string | null;
  readonly delivered_object_ids_json: string;
  readonly delivered_at: string;
  readonly audit_event_id: string;
}

interface UsageRow {
  readonly delivery_id: string;
  readonly usage_state: string;
  readonly used_object_ids_json: string;
  readonly reason: string | null;
  readonly reported_at: string;
  readonly audit_event_id: string;
}

export class SqliteTrustStateRepo implements TrustStateRepo {
  private readonly createDeliveryStatement;
  private readonly createUsageStatement;
  private readonly findDeliveryByIdStatement;
  private readonly listDeliveriesByAgentTargetStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createDeliveryStatement = db.connection.prepare(`
      INSERT INTO trust_context_delivery (
        delivery_id,
        agent_target,
        workspace_id,
        run_id,
        delivered_object_ids_json,
        delivered_at,
        audit_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.createUsageStatement = db.connection.prepare(`
      INSERT INTO trust_usage_proof (
        delivery_id,
        usage_state,
        used_object_ids_json,
        reason,
        reported_at,
        audit_event_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.findDeliveryByIdStatement = db.connection.prepare(`
      SELECT
        delivery_id,
        agent_target,
        workspace_id,
        run_id,
        delivered_object_ids_json,
        delivered_at,
        audit_event_id
      FROM trust_context_delivery
      WHERE delivery_id = ?
      LIMIT 1
    `);

    this.listDeliveriesByAgentTargetStatement = db.connection.prepare(`
      SELECT
        delivery_id,
        agent_target,
        workspace_id,
        run_id,
        delivered_object_ids_json,
        delivered_at,
        audit_event_id
      FROM trust_context_delivery
      WHERE agent_target = ?
      ORDER BY delivered_at ASC, delivery_id ASC
    `);
  }

  public async createDelivery(record: ContextDeliveryRecord): Promise<Readonly<ContextDeliveryRecord>> {
    const parsed = ContextDeliveryRecordSchema.parse(record);
    try {
      this.createDeliveryStatement.run(
        parsed.delivery_id,
        parsed.agent_target,
        parsed.workspace_id,
        parsed.run_id,
        JSON.stringify(parsed.delivered_object_ids),
        parsed.delivered_at,
        parsed.audit_event_id
      );
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new StorageError("CONFLICT", describeDeliveryConflict(parsed, error), error);
      }
      throw new StorageError("QUERY_FAILED", `Failed to persist trust delivery ${parsed.delivery_id}.`, error);
    }
    return deepFreeze(parsed);
  }

  public async createUsage(record: UsageProofRecord): Promise<Readonly<UsageProofRecord>> {
    const parsed = UsageProofRecordSchema.parse(record);
    try {
      this.createUsageStatement.run(
        parsed.delivery_id,
        parsed.usage_state,
        JSON.stringify(parsed.used_object_ids),
        parsed.reason,
        parsed.reported_at,
        parsed.audit_event_id
      );
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new StorageError("CONFLICT", describeUsageConflict(parsed, error), error);
      }
      throw new StorageError("QUERY_FAILED", `Failed to persist trust usage ${parsed.delivery_id}.`, error);
    }
    return deepFreeze(parsed);
  }

  public async findDeliveryById(deliveryId: string): Promise<Readonly<ContextDeliveryRecord> | null> {
    const parsedDeliveryId = NonEmptyStringSchema.parse(deliveryId);
    try {
      const row = this.findDeliveryByIdStatement.get(parsedDeliveryId) as DeliveryRow | undefined;
      return row === undefined ? null : parseDeliveryRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load trust delivery ${parsedDeliveryId}.`, error);
    }
  }

  public async listDeliveriesByAgentTarget(agentTarget: string): Promise<readonly Readonly<ContextDeliveryRecord>[]> {
    const parsedAgentTarget = NonEmptyStringSchema.parse(agentTarget);
    try {
      const rows = this.listDeliveriesByAgentTargetStatement.all(parsedAgentTarget) as DeliveryRow[];
      return rows.map((row) => parseDeliveryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list trust deliveries for ${parsedAgentTarget}.`, error);
    }
  }

  public async listUsageByDeliveryIds(deliveryIds: readonly string[]): Promise<readonly Readonly<UsageProofRecord>[]> {
    if (deliveryIds.length === 0) {
      return [];
    }
    const parsedDeliveryIds = deliveryIds.map((deliveryId) => NonEmptyStringSchema.parse(deliveryId));
    const placeholders = parsedDeliveryIds.map(() => "?").join(", ");
    try {
      const rows = this.db.connection
        .prepare(`
          SELECT
            delivery_id,
            usage_state,
            used_object_ids_json,
            reason,
            reported_at,
            audit_event_id
          FROM trust_usage_proof
          WHERE delivery_id IN (${placeholders})
          ORDER BY reported_at ASC, delivery_id ASC
        `)
        .all(...parsedDeliveryIds) as UsageRow[];
      return rows.map((row) => parseUsageRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to list trust usage proofs.", error);
    }
  }
}

function parseDeliveryRow(row: DeliveryRow): Readonly<ContextDeliveryRecord> {
  return deepFreeze(
    ContextDeliveryRecordSchema.parse({
      delivery_id: row.delivery_id,
      agent_target: row.agent_target,
      workspace_id: row.workspace_id,
      run_id: row.run_id,
      delivered_object_ids: parseJsonStringArray(row.delivered_object_ids_json),
      delivered_at: row.delivered_at,
      audit_event_id: row.audit_event_id
    })
  );
}

function parseUsageRow(row: UsageRow): Readonly<UsageProofRecord> {
  return deepFreeze(
    UsageProofRecordSchema.parse({
      delivery_id: row.delivery_id,
      usage_state: row.usage_state,
      used_object_ids: parseJsonStringArray(row.used_object_ids_json),
      reason: row.reason,
      reported_at: row.reported_at,
      audit_event_id: row.audit_event_id
    })
  );
}

function parseJsonStringArray(value: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map((item) => NonEmptyStringSchema.parse(item)) : [];
}

function isSqliteConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

function describeDeliveryConflict(record: ContextDeliveryRecord, error: unknown): string {
  const message = sqliteErrorMessage(error);
  if (message.includes("trust_context_delivery.delivery_id")) {
    return `Trust delivery ${record.delivery_id} already exists.`;
  }
  if (message.includes("trust_context_delivery.audit_event_id")) {
    return `Trust delivery ${record.delivery_id} already uses audit event ${record.audit_event_id}.`;
  }
  return `Trust delivery ${record.delivery_id} violates trust delivery constraints.`;
}

function describeUsageConflict(record: UsageProofRecord, error: unknown): string {
  const message = sqliteErrorMessage(error);
  if (message.includes("trust_usage_proof.delivery_id")) {
    return `Trust usage proof for delivery ${record.delivery_id} already exists.`;
  }
  if (message.includes("trust_usage_proof.audit_event_id")) {
    return `Trust usage proof for delivery ${record.delivery_id} already uses audit event ${record.audit_event_id}.`;
  }
  if (message.includes("FOREIGN KEY")) {
    return `Trust usage proof for delivery ${record.delivery_id} references a missing delivery.`;
  }
  return `Trust usage proof for delivery ${record.delivery_id} violates trust usage constraints.`;
}

function sqliteErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
