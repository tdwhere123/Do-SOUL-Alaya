import { randomUUID } from "node:crypto";
import {
  HealthEventKindSchema,
  HealthJournalEntrySchema,
  type HealthEventKindValue,
  type HealthJournalEntry
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../sqlite/db.js";
import { StorageError } from "../shared/errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseNullableString, parseTimestamp } from "./shared/validators.js";

export interface HealthJournalCreateInput {
  readonly entry_id?: string;
  readonly event_kind: HealthEventKindValue;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly summary: string;
  readonly detail_json: Record<string, unknown>;
  readonly created_at?: string;
}

export interface HealthJournalQueryParams {
  readonly kind?: HealthEventKindValue;
  readonly limit?: number;
}

export interface HealthJournalRepo {
  append(input: HealthJournalCreateInput): Promise<Readonly<HealthJournalEntry>>;
  findByWorkspace(
    workspaceId: string,
    params?: HealthJournalQueryParams
  ): Promise<readonly Readonly<HealthJournalEntry>[]>;
}

interface HealthJournalRow {
  readonly entry_id: string;
  readonly event_kind: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly summary: string;
  readonly detail_json: string;
  readonly created_at: string;
}

export class SqliteHealthJournalRepo implements HealthJournalRepo {
  private readonly appendStatement;
  private readonly findByWorkspaceStatement;
  private readonly findByWorkspaceAndKindStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.appendStatement = db.connection.prepare(`
      INSERT INTO health_journal (
        entry_id,
        event_kind,
        workspace_id,
        run_id,
        summary,
        detail_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.findByWorkspaceStatement = db.connection.prepare(`
      SELECT entry_id, event_kind, workspace_id, run_id, summary, detail_json, created_at
      FROM health_journal
      WHERE workspace_id = ?
      ORDER BY created_at DESC, entry_id DESC
      LIMIT ?
    `);

    this.findByWorkspaceAndKindStatement = db.connection.prepare(`
      SELECT entry_id, event_kind, workspace_id, run_id, summary, detail_json, created_at
      FROM health_journal
      WHERE workspace_id = ? AND event_kind = ?
      ORDER BY created_at DESC, entry_id DESC
      LIMIT ?
    `);
  }

  public async append(input: HealthJournalCreateInput): Promise<Readonly<HealthJournalEntry>> {
    const parsedInput = parseCreateInput(input);

    try {
      this.appendStatement.run(
        parsedInput.entry_id,
        parsedInput.event_kind,
        parsedInput.workspace_id,
        parsedInput.run_id,
        parsedInput.summary,
        JSON.stringify(parsedInput.detail_json),
        parsedInput.created_at
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to append health journal entry ${parsedInput.entry_id}.`,
        error
      );
    }

    return parsedInput;
  }

  public async findByWorkspace(
    workspaceId: string,
    params: HealthJournalQueryParams = {}
  ): Promise<readonly Readonly<HealthJournalEntry>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    const parsedLimit = parseLimit(params.limit);
    const parsedKind = params.kind === undefined ? undefined : parseEventKind(params.kind);

    try {
      const rows =
        parsedKind === undefined
          ? (this.findByWorkspaceStatement.all(parsedWorkspaceId, parsedLimit) as HealthJournalRow[])
          : (this.findByWorkspaceAndKindStatement.all(parsedWorkspaceId, parsedKind, parsedLimit) as HealthJournalRow[]);

      return rows.map((row) => parseRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list health journal entries for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }
}

function parseCreateInput(input: HealthJournalCreateInput): Readonly<HealthJournalEntry> {
  try {
    return deepFreeze(
      HealthJournalEntrySchema.parse({
        entry_id: parseNonEmptyString(input.entry_id ?? randomUUID(), "entry_id"),
        event_kind: parseEventKind(input.event_kind),
        workspace_id: parseNonEmptyString(input.workspace_id, "workspace_id"),
        run_id: parseNullableString(input.run_id, "run_id"),
        summary: parseNonEmptyString(input.summary, "summary"),
        detail_json: parseDetailJson(input.detail_json),
        created_at: parseTimestamp(input.created_at ?? new Date().toISOString())
      })
    );
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("VALIDATION_FAILED", "Failed to validate health journal entry.", error);
  }
}

function parseRow(row: HealthJournalRow): Readonly<HealthJournalEntry> {
  let detailJson: Record<string, unknown>;

  try {
    const parsed = JSON.parse(row.detail_json) as unknown;

    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("detail_json must be an object");
    }

    detailJson = parsed as Record<string, unknown>;
  } catch (error) {
    throw new StorageError("QUERY_FAILED", `Failed to parse health journal entry ${row.entry_id}.`, error);
  }

  return parseCreateInput({
    entry_id: row.entry_id,
    event_kind: row.event_kind as HealthEventKindValue,
    workspace_id: row.workspace_id,
    run_id: row.run_id,
    summary: row.summary,
    detail_json: detailJson,
    created_at: row.created_at
  });
}

function parseEventKind(value: string): HealthEventKindValue {
  try {
    return HealthEventKindSchema.parse(parseNonEmptyString(value, "event_kind"));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate event_kind.", error);
  }
}

function parseDetailJson(value: Record<string, unknown>): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate detail_json.");
  }

  return deepFreeze({ ...value }) as Record<string, unknown>;
}

function parseLimit(value: number | undefined): number {
  if (value === undefined) {
    return 50;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate limit.");
  }

  return value;
}
