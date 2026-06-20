import {
  DeferredObligationSchema,
  DeferredObligationStateSchema,
  IsoDatetimeStringSchema,
  type DeferredObligation,
  type DeferredObligationState
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseNonEmptyString } from "../shared/validators.js";

export interface DeferredObligationRepo {
  getById(obligationId: string): Promise<Readonly<DeferredObligation> | null>;
  create(obligation: DeferredObligation): Readonly<DeferredObligation>;
  updateState(
    obligationId: string,
    expectedState: DeferredObligationState,
    nextState: DeferredObligationState,
    options?: {
      readonly fulfilledAt?: string;
    }
  ): Readonly<DeferredObligation>;
  findActiveByRun(runId: string): Promise<readonly Readonly<DeferredObligation>[]>;
  findActiveByWorkspace(workspaceId: string): Promise<readonly Readonly<DeferredObligation>[]>;
  findExpired(now: string): Promise<readonly Readonly<DeferredObligation>[]>;
}

const DEFERRED_OBLIGATION_SELECT_COLUMNS = `
      obligation_id,
      kind,
      state,
      description,
      source_run_id,
      workspace_id,
      target_entity_id,
      created_at,
      expires_at,
      fulfilled_at
`;

interface DeferredObligationRow {
  readonly obligation_id: string;
  readonly kind: string;
  readonly state: string;
  readonly description: string;
  readonly source_run_id: string;
  readonly workspace_id: string;
  readonly target_entity_id: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly fulfilled_at: string | null;
}

interface ParsedDeferredObligationStateUpdate {
  readonly obligationId: string;
  readonly expectedState: DeferredObligationState;
  readonly nextState: DeferredObligationState;
  readonly fulfilledAt: string | null;
}

export class SqliteDeferredObligationRepo implements DeferredObligationRepo {
  private readonly getByIdStatement;
  private readonly insertStatement;
  private readonly updateStateStatement;
  private readonly findActiveByRunStatement;
  private readonly findActiveByWorkspaceStatement;
  private readonly findExpiredStatement;

  public constructor(db: StorageDatabase) {
    this.getByIdStatement = db.connection.prepare(`
      SELECT${DEFERRED_OBLIGATION_SELECT_COLUMNS}
      FROM deferred_obligations
      WHERE obligation_id = ?
      LIMIT 1
    `);

    this.insertStatement = db.connection.prepare(`
      INSERT INTO deferred_obligations (
        obligation_id,
        kind,
        state,
        description,
        source_run_id,
        workspace_id,
        target_entity_id,
        created_at,
        expires_at,
        fulfilled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.updateStateStatement = db.connection.prepare(`
      UPDATE deferred_obligations
      SET state = ?, fulfilled_at = ?
      WHERE obligation_id = ? AND state = ?
    `);

    this.findActiveByRunStatement = db.connection.prepare(`
      SELECT${DEFERRED_OBLIGATION_SELECT_COLUMNS}
      FROM deferred_obligations
      WHERE source_run_id = ? AND state = 'pending'
      ORDER BY created_at ASC
    `);

    this.findActiveByWorkspaceStatement = db.connection.prepare(`
      SELECT${DEFERRED_OBLIGATION_SELECT_COLUMNS}
      FROM deferred_obligations
      WHERE workspace_id = ? AND state = 'pending'
      ORDER BY created_at ASC
    `);

    this.findExpiredStatement = db.connection.prepare(`
      SELECT${DEFERRED_OBLIGATION_SELECT_COLUMNS}
      FROM deferred_obligations
      WHERE state = 'pending' AND expires_at < ?
      ORDER BY expires_at ASC
    `);
  }

  public async getById(obligationId: string): Promise<Readonly<DeferredObligation> | null> {
    const parsedObligationId = parseNonEmptyString(obligationId, "obligation id");

    try {
      const row = this.getByIdStatement.get(parsedObligationId) as
        | DeferredObligationRow
        | undefined;
      return row === undefined ? null : this.mapRowToDomain(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load deferred obligation ${parsedObligationId}.`,
        error
      );
    }
  }

  public create(obligation: DeferredObligation): Readonly<DeferredObligation> {
    const parsed = parseDeferredObligation(obligation);

    try {
      this.insertStatement.run(
        parsed.obligation_id,
        parsed.kind,
        parsed.state,
        parsed.description,
        parsed.source_run_id,
        parsed.workspace_id,
        parsed.target_entity_id ?? null,
        parsed.created_at,
        parsed.expires_at,
        parsed.fulfilled_at ?? null
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to insert deferred obligation ${parsed.obligation_id}.`,
        error
      );
    }

    const inserted = this.readById(parsed.obligation_id);

    if (inserted === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Deferred obligation ${parsed.obligation_id} was not found after insert.`
      );
    }

    return inserted;
  }

  private readById(obligationId: string): Readonly<DeferredObligation> | null {
    try {
      const row = this.getByIdStatement.get(obligationId) as DeferredObligationRow | undefined;
      return row === undefined ? null : this.mapRowToDomain(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load deferred obligation ${obligationId}.`,
        error
      );
    }
  }

  public updateState(
    obligationId: string,
    expectedState: DeferredObligationState,
    nextState: DeferredObligationState,
    options?: {
      readonly fulfilledAt?: string;
    }
  ): Readonly<DeferredObligation> {
    const parsed = parseDeferredObligationStateUpdate(obligationId, expectedState, nextState, options);

    try {
      const changes = this.runStateUpdate(parsed);
      if (changes === 0) {
        this.throwStateUpdateFailure(parsed);
      }
      return this.readRequiredAfterStateUpdate(parsed.obligationId);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update deferred obligation ${parsed.obligationId}.`,
        error
      );
    }
  }

  private runStateUpdate(parsed: ParsedDeferredObligationStateUpdate): number {
    return this.updateStateStatement.run(
      parsed.nextState,
      parsed.fulfilledAt,
      parsed.obligationId,
      parsed.expectedState
    ).changes;
  }

  private throwStateUpdateFailure(parsed: ParsedDeferredObligationStateUpdate): never {
    const existing = this.readById(parsed.obligationId);
    if (existing === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Deferred obligation ${parsed.obligationId} was not found.`
      );
    }

    throw new StorageError(
      "CONFLICT",
      `CAS failed for deferred obligation ${parsed.obligationId}: expected ${parsed.expectedState}, found ${existing.state}.`
    );
  }

  private readRequiredAfterStateUpdate(obligationId: string): Readonly<DeferredObligation> {
    const updated = this.readById(obligationId);

    if (updated === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Deferred obligation ${obligationId} was not found after update.`
      );
    }

    return updated;
  }

  public async findActiveByRun(runId: string): Promise<readonly Readonly<DeferredObligation>[]> {
    const parsedRunId = parseNonEmptyString(runId, "run id");

    try {
      const rows = this.findActiveByRunStatement.all(parsedRunId) as DeferredObligationRow[];
      return rows.map((row) => this.mapRowToDomain(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load active deferred obligations for run ${parsedRunId}.`,
        error
      );
    }
  }

  public async findActiveByWorkspace(
    workspaceId: string
  ): Promise<readonly Readonly<DeferredObligation>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findActiveByWorkspaceStatement.all(parsedWorkspaceId) as DeferredObligationRow[];
      return rows.map((row) => this.mapRowToDomain(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load active deferred obligations for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findExpired(now: string): Promise<readonly Readonly<DeferredObligation>[]> {
    const parsedNow = parseIsoDatetimeNow(now);

    try {
      const rows = this.findExpiredStatement.all(parsedNow) as DeferredObligationRow[];
      return rows.map((row) => this.mapRowToDomain(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to load expired deferred obligations.",
        error
      );
    }
  }

  private mapRowToDomain(row: DeferredObligationRow): Readonly<DeferredObligation> {
    return parseDeferredObligation({
      obligation_id: row.obligation_id,
      kind: row.kind,
      state: row.state,
      description: row.description,
      source_run_id: row.source_run_id,
      workspace_id: row.workspace_id,
      target_entity_id: row.target_entity_id ?? undefined,
      created_at: row.created_at,
      expires_at: row.expires_at,
      fulfilled_at: row.fulfilled_at ?? undefined
    });
  }
}

function parseDeferredObligation(value: unknown): Readonly<DeferredObligation> {
  try {
    return deepFreeze(DeferredObligationSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate deferred obligation.", error);
  }
}

function parseDeferredObligationStateUpdate(
  obligationId: string,
  expectedState: DeferredObligationState,
  nextState: DeferredObligationState,
  options?: { readonly fulfilledAt?: string }
): ParsedDeferredObligationStateUpdate {
  const parsedNextState = DeferredObligationStateSchema.parse(nextState);
  return {
    obligationId: parseNonEmptyString(obligationId, "obligation id"),
    expectedState: DeferredObligationStateSchema.parse(expectedState),
    nextState: parsedNextState,
    fulfilledAt: parseFulfilledAtForState(parsedNextState, options?.fulfilledAt)
  };
}

function parseFulfilledAtForState(nextState: DeferredObligationState, value: string | undefined): string | null {
  return nextState === "fulfilled" ? parseIsoDatetimeNow(value ?? new Date().toISOString()) : null;
}

function parseIsoDatetimeNow(now: string): string {
  try {
    return IsoDatetimeStringSchema.parse(now);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate timestamp.", error);
  }
}
