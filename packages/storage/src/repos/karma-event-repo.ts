import { parseKarmaEvent as parseProtocolKarmaEvent, type KarmaEvent, type KarmaEventKind } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../sqlite/db.js";
import { StorageError } from "../shared/errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString } from "./shared/validators.js";

export type { KarmaEvent, KarmaEventKind } from "@do-soul/alaya-protocol";

export interface KarmaEventRepo {
  create(event: Readonly<KarmaEvent>): Promise<Readonly<KarmaEvent>>;
  findByObjectId(objectId: string): Promise<readonly Readonly<KarmaEvent>[]>;
  findByObjectIdSync(objectId: string): readonly Readonly<KarmaEvent>[];
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<KarmaEvent>[]>;
  sumByObjectId(objectId: string): Promise<number>;
  sumByObjectIds(objectIds: readonly string[]): Promise<Readonly<Record<string, number>>>;
}

interface KarmaEventRow {
  readonly event_id: string;
  readonly kind: string;
  readonly object_id: string;
  readonly amount: number;
  readonly created_at: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
}

interface KarmaEventSumRow {
  readonly object_id: string;
  readonly total: number;
}

export class SqliteKarmaEventRepo implements KarmaEventRepo {
  private readonly createStatement;
  private readonly findByObjectIdStatement;
  private readonly findByWorkspaceIdStatement;
  private readonly sumByObjectIdStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO karma_events (
        event_id,
        kind,
        object_id,
        amount,
        created_at,
        workspace_id,
        run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.findByObjectIdStatement = db.connection.prepare(`
      SELECT
        event_id,
        kind,
        object_id,
        amount,
        created_at,
        workspace_id,
        run_id
      FROM karma_events
      WHERE object_id = ?
      ORDER BY created_at ASC, event_id ASC
    `);

    this.findByWorkspaceIdStatement = db.connection.prepare(`
      SELECT
        event_id,
        kind,
        object_id,
        amount,
        created_at,
        workspace_id,
        run_id
      FROM karma_events
      WHERE workspace_id = ?
      ORDER BY created_at ASC, event_id ASC
    `);

    this.sumByObjectIdStatement = db.connection.prepare(`
      SELECT COALESCE(SUM(amount), 0.0) AS total
      FROM karma_events
      WHERE object_id = ?
    `);
  }

  public async create(event: Readonly<KarmaEvent>): Promise<Readonly<KarmaEvent>> {
    const parsed = parseKarmaEvent(event);

    try {
      this.createStatement.run(
        parsed.event_id,
        parsed.kind,
        parsed.object_id,
        parsed.amount,
        parsed.created_at,
        parsed.workspace_id,
        parsed.run_id ?? null
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to create karma event ${parsed.event_id}.`, error);
    }

    return parsed;
  }

  public async findByObjectId(objectId: string): Promise<readonly Readonly<KarmaEvent>[]> {
    return this.findByObjectIdSync(objectId);
  }

  // Synchronous read shared with the async wrapper; better-sqlite3 statements
  // execute synchronously, so the sync KarmaEventStore contract can read here
  // without retaining an in-memory event mirror.
  public findByObjectIdSync(objectId: string): readonly Readonly<KarmaEvent>[] {
    const parsedObjectId = parseNonEmptyString(objectId, "object id");

    try {
      const rows = this.findByObjectIdStatement.all(parsedObjectId) as KarmaEventRow[];
      return rows.map((row) => parseKarmaEventRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list karma events for object ${parsedObjectId}.`,
        error
      );
    }
  }

  public async findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<KarmaEvent>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findByWorkspaceIdStatement.all(parsedWorkspaceId) as KarmaEventRow[];
      return rows.map((row) => parseKarmaEventRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list karma events for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async sumByObjectId(objectId: string): Promise<number> {
    const parsedObjectId = parseNonEmptyString(objectId, "object id");

    try {
      const row = this.sumByObjectIdStatement.get(parsedObjectId) as
        | {
            readonly total: number;
          }
        | undefined;
      const total = row?.total ?? 0;

      if (!Number.isFinite(total)) {
        throw new StorageError("VALIDATION_FAILED", "Failed to validate karma sum.");
      }

      return total;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to sum karma events for object ${parsedObjectId}.`,
        error
      );
    }
  }

  public async sumByObjectIds(objectIds: readonly string[]): Promise<Readonly<Record<string, number>>> {
    const parsedObjectIds = Array.from(
      new Set(objectIds.map((objectId) => parseNonEmptyString(objectId, "object id")))
    );

    if (parsedObjectIds.length === 0) {
      return deepFreeze({});
    }

    const placeholders = parsedObjectIds.map(() => "?").join(", ");
    const statement = this.db.connection.prepare(`
      SELECT object_id, COALESCE(SUM(amount), 0.0) AS total
      FROM karma_events
      WHERE object_id IN (${placeholders})
      GROUP BY object_id
    `);

    try {
      const rows = statement.all(...parsedObjectIds) as KarmaEventSumRow[];
      const totals: Record<string, number> = {};

      for (const objectId of parsedObjectIds) {
        totals[objectId] = 0;
      }

      for (const row of rows) {
        if (!Number.isFinite(row.total)) {
          throw new StorageError("VALIDATION_FAILED", `Invalid karma sum for object ${row.object_id}.`);
        }

        totals[row.object_id] = row.total;
      }

      return deepFreeze(totals);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", "Failed to sum karma events for object ids.", error);
    }
  }
}

function parseKarmaEvent(value: unknown): Readonly<KarmaEvent> {
  try {
    return deepFreeze(parseProtocolKarmaEvent(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate karma event.", error);
  }
}

function parseKarmaEventRow(row: KarmaEventRow): Readonly<KarmaEvent> {
  return parseKarmaEvent({
    event_id: row.event_id,
    kind: row.kind,
    object_id: row.object_id,
    amount: row.amount,
    created_at: row.created_at,
    workspace_id: row.workspace_id,
    run_id: row.run_id
  });
}