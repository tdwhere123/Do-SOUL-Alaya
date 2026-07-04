import { parseKarmaEvent as parseProtocolKarmaEvent, type KarmaEvent } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import {
  DEFAULT_REPO_LIST_PAGE_LIMIT,
  parseNonEmptyString,
  parsePageLimit,
  parsePageOffset
} from "../shared/validators.js";

export type { KarmaEvent, KarmaEventKind } from "@do-soul/alaya-protocol";

export interface KarmaEventRepo {
  create(event: Readonly<KarmaEvent>): Promise<Readonly<KarmaEvent>>;
  // invariant (§7): synchronous insert so the karma transition can persist the
  // karma event + its EventLog audit rows in one SQLite transaction.
  createSync?(event: Readonly<KarmaEvent>): Readonly<KarmaEvent>;
  findByObjectIdPage?(
    objectId: string,
    page: KarmaEventListPageOptions
  ): Promise<readonly Readonly<KarmaEvent>[]>;
  findByObjectId(objectId: string): Promise<readonly Readonly<KarmaEvent>[]>;
  findByObjectIdSync(objectId: string): readonly Readonly<KarmaEvent>[];
  findByObjectIdAllSync?(objectId: string): readonly Readonly<KarmaEvent>[];
  findByWorkspaceIdPage?(
    workspaceId: string,
    page: KarmaEventListPageOptions
  ): Promise<readonly Readonly<KarmaEvent>[]>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<KarmaEvent>[]>;
  findByWorkspaceIdAll?(workspaceId: string): Promise<readonly Readonly<KarmaEvent>[]>;
  sumByObjectId(objectId: string): Promise<number>;
  sumByObjectIdSync(objectId: string): number;
  sumByObjectIds(objectIds: readonly string[]): Promise<Readonly<Record<string, number>>>;
}

export interface KarmaEventListPageOptions {
  readonly limit: number;
  readonly offset: number;
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

const DEFAULT_KARMA_EVENT_PAGE = Object.freeze({
  limit: DEFAULT_REPO_LIST_PAGE_LIMIT,
  offset: 0
});

export class SqliteKarmaEventRepo implements KarmaEventRepo {
  private readonly createStatement;
  private readonly findByObjectIdStatement;
  private readonly findByObjectIdPagedStatement;
  private readonly findByWorkspaceIdStatement;
  private readonly findByWorkspaceIdPagedStatement;
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
    this.findByObjectIdPagedStatement = db.connection.prepare(`
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
      LIMIT ? OFFSET ?
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
    this.findByWorkspaceIdPagedStatement = db.connection.prepare(`
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
      LIMIT ? OFFSET ?
    `);

    this.sumByObjectIdStatement = db.connection.prepare(`
      SELECT COALESCE(SUM(amount), 0.0) AS total
      FROM karma_events
      WHERE object_id = ?
    `);
  }

  // wiring-time identity of the backing connection for the atomic-karma guard.
  public getStorageConnectionIdentity(): StorageDatabase {
    return this.db;
  }

  public async create(event: Readonly<KarmaEvent>): Promise<Readonly<KarmaEvent>> {
    return this.createSync(event);
  }

  public createSync(event: Readonly<KarmaEvent>): Readonly<KarmaEvent> {
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
    return this.findByObjectIdPageSync(objectId, DEFAULT_KARMA_EVENT_PAGE);
  }

  public async findByObjectIdPage(
    objectId: string,
    page: KarmaEventListPageOptions
  ): Promise<readonly Readonly<KarmaEvent>[]> {
    return this.findByObjectIdPageSync(objectId, page);
  }

  // Synchronous read shared with the async wrapper; better-sqlite3 statements
  // execute synchronously, so the sync KarmaEventStore contract can read here
  // without retaining an in-memory event mirror.
  public findByObjectIdSync(objectId: string): readonly Readonly<KarmaEvent>[] {
    return this.findByObjectIdPageSync(objectId, DEFAULT_KARMA_EVENT_PAGE);
  }

  public findByObjectIdAllSync(objectId: string): readonly Readonly<KarmaEvent>[] {
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

  public findByObjectIdPageSync(
    objectId: string,
    page: KarmaEventListPageOptions
  ): readonly Readonly<KarmaEvent>[] {
    const parsedObjectId = parseNonEmptyString(objectId, "object id");
    const parsedPage = parseKarmaEventPage(page);

    try {
      const rows = this.findByObjectIdPagedStatement.all(
        parsedObjectId,
        parsedPage.limit,
        parsedPage.offset
      ) as KarmaEventRow[];
      return rows.map((row) => parseKarmaEventRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list paged karma events for object ${parsedObjectId}.`,
        error
      );
    }
  }

  public async findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<KarmaEvent>[]> {
    return await this.findByWorkspaceIdPage(workspaceId, DEFAULT_KARMA_EVENT_PAGE);
  }

  public async findByWorkspaceIdAll(workspaceId: string): Promise<readonly Readonly<KarmaEvent>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findByWorkspaceIdStatement.all(parsedWorkspaceId) as KarmaEventRow[];
      return rows.map((row) => parseKarmaEventRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list all karma events for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findByWorkspaceIdPage(
    workspaceId: string,
    page: KarmaEventListPageOptions
  ): Promise<readonly Readonly<KarmaEvent>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedPage = parseKarmaEventPage(page);

    try {
      const rows = this.findByWorkspaceIdPagedStatement.all(
        parsedWorkspaceId,
        parsedPage.limit,
        parsedPage.offset
      ) as KarmaEventRow[];
      return rows.map((row) => parseKarmaEventRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list paged karma events for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async sumByObjectId(objectId: string): Promise<number> {
    return this.sumByObjectIdSync(objectId);
  }

  public sumByObjectIdSync(objectId: string): number {
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

function parseKarmaEventPage(page: KarmaEventListPageOptions): Readonly<KarmaEventListPageOptions> {
  return Object.freeze({
    limit: parsePageLimit(page.limit, "karma event page limit"),
    offset: parsePageOffset(page.offset, "karma event page offset")
  });
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
