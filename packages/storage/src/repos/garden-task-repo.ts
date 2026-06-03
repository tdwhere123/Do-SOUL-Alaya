import { randomUUID } from "node:crypto";
import {
  GardenRoleSchema,
  GardenTaskKindSchema,
  type EventLogEntry,
  type GardenRoleValue,
  type GardenTaskKindValue
} from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseNullableString, parseTimestamp } from "./shared/validators.js";

// Walk up to 5 levels of the cause chain looking for a SQLite UNIQUE
// constraint violation on the named qualified column. Mirrors the helper
// in workspace-repo.ts; better-sqlite3's error format is library-version
// coupled, so the cause walk handles eventual error-wrapping by upstream
// layers. Used by enqueue() to surface PK collisions as the structured
// DUPLICATE_KEY StorageError code that v0.1.0 commit aacb4f2 standardised.
function isUniqueConstraintError(error: unknown, qualifiedColumn: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const codeValue = (current as { readonly code?: unknown }).code;
    const messageValue = (current as { readonly message?: unknown }).message;
    const isUniqueCode =
      typeof codeValue === "string" && codeValue.startsWith("SQLITE_CONSTRAINT");
    const matchesColumn =
      typeof messageValue === "string" && messageValue.includes(qualifiedColumn);
    if (isUniqueCode && matchesColumn) {
      return true;
    }
    if (matchesColumn && typeof messageValue === "string" && messageValue.includes("UNIQUE")) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

export type GardenTaskStatus = "pending" | "claimed" | "completed" | "failed";

/**
 * Sentinel thrown inside the appendManyWithMutation callback when the
 * claim CAS predicate loses. It rolls back the audit append along
 * with the (no-op) UPDATE so partial state cannot escape.
 */
class GardenTaskClaimCasMiss extends Error {
  constructor() {
    super("Garden task already claimed by another worker.");
    this.name = "GardenTaskClaimCasMiss";
  }
}
export type GardenTaskClaimResult = "claimed" | "already-claimed";
export type GardenTaskEventInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export interface GardenTaskEventPublisherPort {
  appendManyWithMutation<T>(
    events: readonly GardenTaskEventInput[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): Promise<T>;
}

export interface GardenTaskEnqueueInput {
  readonly id?: string;
  readonly workspace_id: string;
  readonly role: GardenRoleValue;
  readonly kind: GardenTaskKindValue;
  readonly payload: unknown;
  readonly created_at?: string;
}

export interface GardenTaskRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly role: GardenRoleValue;
  readonly kind: GardenTaskKindValue;
  readonly payload_json: string;
  readonly payload: unknown;
  readonly status: GardenTaskStatus;
  readonly claimed_by: string | null;
  readonly claimed_at: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly attempt_count: number;
  readonly last_error_text: string | null;
  readonly completion_envelope_json: string | null;
}

export interface GardenTaskBacklogCount {
  readonly role: GardenRoleValue;
  readonly status: "pending" | "claimed";
  readonly count: number;
}

export interface GardenTaskKindBacklogCount {
  readonly kind: GardenTaskKindValue;
  readonly pending: number;
  readonly stale: number;
}

export interface GardenTaskCompletionResult {
  readonly status: "completed" | "failed";
  readonly completed_at: string;
  readonly last_error_text?: string;
}

export interface GardenTaskReclaimInput {
  readonly task_id: string;
  readonly claimed_by: string;
  readonly claimed_at: string;
  readonly event: GardenTaskEventInput;
}

export interface GardenTaskExpiryInput {
  readonly task_id: string;
  readonly event: GardenTaskEventInput;
}

export interface GardenTaskRepoPort {
  enqueue(input: GardenTaskEnqueueInput): { readonly task_id: string };
  findById(taskId: string): GardenTaskRow | null;
  peekPending(
    role: GardenRoleValue,
    workspace_id?: string,
    limit?: number
  ): readonly GardenTaskRow[];
  claimAtomic(
    taskId: string,
    claimedBy: string,
    claimedAt: string,
    workspace_id?: string
  ): GardenTaskClaimResult;
  /**
   * Wave-end M6: claim a pending task AND append the dispatched event(s)
   * inside the same SQLite transaction. Either the row's status flips
   * to "claimed" with a corresponding SOUL_GARDEN_TASK_DISPATCHED row
   * in event_log, or neither — eliminating the partial-state window
   * where a daemon crash between separate claim + append calls would
   * leave a `claimed` row with no audit trail (recovery only via
   * gcAbandonedClaims). When the CAS predicate loses (already claimed
   * by another worker), no events are appended and the result is
   * "already-claimed".
   */
  claimAtomicWithEvents(
    taskId: string,
    claimedBy: string,
    claimedAt: string,
    dispatchedEvents: readonly GardenTaskEventInput[],
    workspace_id?: string
  ): Promise<GardenTaskClaimResult>;
  beginCompletionAttempt(
    taskId: string,
    claimedBy: string,
    completionClaimedBy: string,
    claimedAt: string,
    completionEnvelopeJson?: string | null
  ): boolean;
  refreshClaim(taskId: string, claimedBy: string, claimedAt: string): boolean;
  releaseClaim(taskId: string, claimedBy: string): boolean;
  completeWithEvents(
    taskId: string,
    result: GardenTaskCompletionResult,
    events: readonly GardenTaskEventInput[],
    claimedBy: string
  ): Promise<void>;
  peekAbandonedClaims(now: string, staleAfterMs: number): readonly GardenTaskRow[];
  gcAbandonedClaims(reclaims: readonly GardenTaskReclaimInput[]): Promise<number>;
  // invariant: never-claimed pending tasks of a host-worker-only kind
  // (EDGE_CLASSIFY / POST_TURN_EXTRACT) accrete forever on a no-agent deployment
  // — no worker claims them, so neither completeWithEvents nor gcAbandonedClaims
  // (which only touches status='claimed') ever removes them. peek selects rows
  // still status='pending' whose created_at is older than expiredBeforeIso,
  // oldest-first and bounded by limit, so the daemon can build one audit event
  // per task before the bounded delete. Read-only; no mutation.
  // see also: expireUnclaimedTasks; apps/core-daemon/src/garden-runtime.ts.
  peekExpiredUnclaimedTasks(
    kind: GardenTaskKindValue,
    expiredBeforeIso: string,
    limit: number
  ): readonly GardenTaskRow[];
  // invariant: deletes the named pending tasks AND appends their expiry audit
  // events in ONE SQLite transaction (mirrors gcAbandonedClaims). Each delete is
  // CAS-gated on status='pending' so a task a worker claimed between peek and
  // delete is left intact (changes===0 -> skipped, not an error). Returns the
  // count actually removed.
  expireUnclaimedTasks(expirations: readonly GardenTaskExpiryInput[]): Promise<number>;
  countBacklog(workspace_id?: string): readonly GardenTaskBacklogCount[];
  // invariant: per-kind eventual-consistency diagnostic. pending = tasks not
  // yet claimed by a host worker; stale = tasks claimed but whose claim is
  // older than staleBeforeIso (a worker took the task but never completed).
  // Used to observe the EDGE_CLASSIFY backlog: how many heuristic edges are
  // still awaiting their LLM-quality refinement. Read-only count, no mutation.
  countByKind(
    kind: GardenTaskKindValue,
    staleBeforeIso: string,
    workspace_id?: string
  ): GardenTaskKindBacklogCount;
}

interface GardenTaskDbRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly role: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly status: string;
  readonly claimed_by: string | null;
  readonly claimed_at: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly attempt_count: number;
  readonly last_error_text: string | null;
  readonly completion_envelope_json: string | null;
}

interface GardenTaskBacklogCountDbRow {
  readonly role: string;
  readonly status: string;
  readonly count: number;
}

export class SqliteGardenTaskRepo implements GardenTaskRepoPort {
  private readonly enqueueStatement;
  private readonly findByIdStatement;
  private readonly peekPendingStatement;
  private readonly peekPendingByWorkspaceStatement;
  private readonly claimStatement;
  private readonly beginCompletionAttemptStatement;
  private readonly refreshClaimStatement;
  private readonly releaseClaimStatement;
  private readonly completeStatement;
  private readonly peekAbandonedClaimsStatement;
  private readonly gcAbandonedClaimStatement;
  private readonly peekExpiredUnclaimedStatement;
  private readonly expireUnclaimedStatement;
  private readonly countByKindStatement;
  private readonly countByKindByWorkspaceStatement;
  private readonly countByRoleStatusStatement;

  public constructor(
    private readonly connection: SqliteConnection,
    private readonly eventPublisher: GardenTaskEventPublisherPort
  ) {
    this.enqueueStatement = connection.prepare(`
      INSERT INTO garden_tasks (
        id,
        workspace_id,
        role,
        kind,
        payload_json,
        status,
        claimed_by,
        claimed_at,
        created_at,
        completed_at,
        attempt_count,
        last_error_text,
        completion_envelope_json
      ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, 0, NULL, NULL)
    `);
    this.findByIdStatement = connection.prepare(`
      SELECT
        id,
        workspace_id,
        role,
        kind,
        payload_json,
        status,
        claimed_by,
        claimed_at,
        created_at,
        completed_at,
        attempt_count,
        last_error_text,
        completion_envelope_json
      FROM garden_tasks
      WHERE id = ?
      LIMIT 1
    `);
    this.peekPendingStatement = connection.prepare(`
      SELECT
        id,
        workspace_id,
        role,
        kind,
        payload_json,
        status,
        claimed_by,
        claimed_at,
        created_at,
        completed_at,
        attempt_count,
        last_error_text,
        completion_envelope_json
      FROM garden_tasks
      WHERE status = 'pending'
        AND CASE role
          WHEN 'janitor' THEN 0
          WHEN 'auditor' THEN 1
          WHEN 'librarian' THEN 2
          ELSE 99
        END <= ?
      ORDER BY
        COALESCE(CAST(json_extract(payload_json, '$.priority') AS INTEGER), 0) DESC,
        created_at ASC,
        id ASC
      LIMIT ?
    `);
    this.peekPendingByWorkspaceStatement = connection.prepare(`
      SELECT
        id,
        workspace_id,
        role,
        kind,
        payload_json,
        status,
        claimed_by,
        claimed_at,
        created_at,
        completed_at,
        attempt_count,
        last_error_text,
        completion_envelope_json
      FROM garden_tasks
      WHERE status = 'pending'
        AND CASE role
          WHEN 'janitor' THEN 0
          WHEN 'auditor' THEN 1
          WHEN 'librarian' THEN 2
          ELSE 99
        END <= ?
        AND workspace_id = ?
      ORDER BY
        COALESCE(CAST(json_extract(payload_json, '$.priority') AS INTEGER), 0) DESC,
        created_at ASC,
        id ASC
      LIMIT ?
    `);
    this.claimStatement = connection.prepare(`
      UPDATE garden_tasks
      SET status = 'claimed',
          claimed_by = ?,
          claimed_at = ?,
          attempt_count = attempt_count + 1
      WHERE id = ? AND status = 'pending' AND (? IS NULL OR workspace_id = ?)
    `);
    this.releaseClaimStatement = connection.prepare(`
      UPDATE garden_tasks
      SET status = 'pending', claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND status = 'claimed' AND claimed_by = ?
    `);
    this.beginCompletionAttemptStatement = connection.prepare(`
      UPDATE garden_tasks
      SET claimed_by = ?,
          claimed_at = ?,
          completion_envelope_json = COALESCE(completion_envelope_json, ?)
      WHERE id = ?
        AND status = 'claimed'
        AND claimed_by = ?
        AND (completion_envelope_json IS NULL OR completion_envelope_json = ?)
    `);
    this.refreshClaimStatement = connection.prepare(`
      UPDATE garden_tasks
      SET claimed_at = ?
      WHERE id = ? AND status = 'claimed' AND claimed_by = ?
    `);
    this.completeStatement = connection.prepare(`
      UPDATE garden_tasks
      SET status = ?, completed_at = ?, last_error_text = ?
      WHERE id = ? AND status = 'claimed' AND claimed_by = ?
    `);
    this.peekAbandonedClaimsStatement = connection.prepare(`
      SELECT
        id,
        workspace_id,
        role,
        kind,
        payload_json,
        status,
        claimed_by,
        claimed_at,
        created_at,
        completed_at,
        attempt_count,
        last_error_text,
        completion_envelope_json
      FROM garden_tasks
      WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?
      ORDER BY claimed_at ASC, id ASC
    `);
    this.gcAbandonedClaimStatement = connection.prepare(`
      UPDATE garden_tasks
      SET status = 'pending', claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND status = 'claimed' AND claimed_by = ? AND claimed_at = ?
    `);
    this.peekExpiredUnclaimedStatement = connection.prepare(`
      SELECT
        id,
        workspace_id,
        role,
        kind,
        payload_json,
        status,
        claimed_by,
        claimed_at,
        created_at,
        completed_at,
        attempt_count,
        last_error_text,
        completion_envelope_json
      FROM garden_tasks
      WHERE status = 'pending' AND kind = ? AND created_at < ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `);
    // invariant: CAS-gated on status='pending' so a task a worker claimed
    // between peek and this delete is left intact (changes===0, skipped).
    this.expireUnclaimedStatement = connection.prepare(`
      DELETE FROM garden_tasks
      WHERE id = ? AND status = 'pending'
    `);
    this.countByRoleStatusStatement = connection.prepare(`
      SELECT role, status, COUNT(*) AS count
      FROM garden_tasks
      WHERE status IN ('pending', 'claimed')
        AND (? IS NULL OR workspace_id = ?)
      GROUP BY role, status
      ORDER BY role ASC, status ASC
    `);
    // pending = unclaimed; stale = claimed with a claim older than the cutoff
    // (a worker took the task but never completed it). Bind order: kind,
    // stale-cutoff iso. The workspace-scoped variant adds a workspace_id bind.
    this.countByKindStatement = connection.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ? THEN 1 ELSE 0 END) AS stale
      FROM garden_tasks
      WHERE kind = ?
    `);
    this.countByKindByWorkspaceStatement = connection.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ? THEN 1 ELSE 0 END) AS stale
      FROM garden_tasks
      WHERE kind = ? AND workspace_id = ?
    `);
  }

  public enqueue(input: GardenTaskEnqueueInput): { readonly task_id: string } {
    const id = parseNonEmptyString(input.id ?? randomUUID(), "garden_task.id");
    const workspaceId = parseNonEmptyString(input.workspace_id, "garden_task.workspace_id");
    const role = GardenRoleSchema.parse(input.role);
    const kind = GardenTaskKindSchema.parse(input.kind);
    const payloadJson = stringifyPayload(input.payload);
    const createdAt = parseTimestamp(input.created_at ?? new Date().toISOString());

    try {
      this.enqueueStatement.run(id, workspaceId, role, kind, payloadJson, createdAt);
      return { task_id: id };
    } catch (error) {
      // Wave-end M3: surface PK collisions as the structured DUPLICATE_KEY
      // error code that v0.1.0 commit aacb4f2 already standardised for
      // the workspace repo. Callers (notably H3's POST_TURN_EXTRACT
      // dedupe path) use `error.code === "DUPLICATE_KEY"` instead of
      // walking the SQLite error message string, which couples the dedupe
      // contract to better-sqlite3's internal text format.
      if (isUniqueConstraintError(error, "garden_tasks.id")) {
        throw new StorageError(
          "DUPLICATE_KEY",
          `Garden task ${id} already exists.`,
          error
        );
      }
      throw new StorageError("QUERY_FAILED", `Failed to enqueue Garden task ${id}.`, error);
    }
  }

  public findById(taskId: string): GardenTaskRow | null {
    const parsedTaskId = parseNonEmptyString(taskId, "garden_task.id");

    try {
      const row = this.findByIdStatement.get(parsedTaskId) as GardenTaskDbRow | undefined;
      return row === undefined ? null : parseGardenTaskRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to load Garden task ${parsedTaskId}.`, error);
    }
  }

  public peekPending(
    role: GardenRoleValue,
    workspace_id?: string,
    limit = 10
  ): readonly GardenTaskRow[] {
    const parsedRoleRank = roleRank(GardenRoleSchema.parse(role));
    const parsedLimit = parseLimit(limit);

    try {
      const rows =
        workspace_id === undefined
          ? (this.peekPendingStatement.all(parsedRoleRank, parsedLimit) as GardenTaskDbRow[])
          : (this.peekPendingByWorkspaceStatement.all(
              parsedRoleRank,
              parseNonEmptyString(workspace_id, "garden_task.workspace_id"),
              parsedLimit
            ) as GardenTaskDbRow[]);
      return rows.map((row) => parseGardenTaskRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", "Failed to peek pending Garden tasks.", error);
    }
  }

  public claimAtomic(
    taskId: string,
    claimedBy: string,
    claimedAt: string,
    workspace_id?: string
  ): GardenTaskClaimResult {
    const parsedTaskId = parseNonEmptyString(taskId, "garden_task.id");
    const parsedClaimedBy = parseNonEmptyString(claimedBy, "garden_task.claimed_by");
    const parsedClaimedAt = parseTimestamp(claimedAt);
    const parsedWorkspaceId =
      workspace_id === undefined
        ? null
        : parseNonEmptyString(workspace_id, "garden_task.workspace_id");

    try {
      const result = this.claimStatement.run(
        parsedClaimedBy,
        parsedClaimedAt,
        parsedTaskId,
        parsedWorkspaceId,
        parsedWorkspaceId
      );
      return result.changes === 1 ? "claimed" : "already-claimed";
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to claim Garden task ${parsedTaskId}.`, error);
    }
  }

  public async claimAtomicWithEvents(
    taskId: string,
    claimedBy: string,
    claimedAt: string,
    dispatchedEvents: readonly GardenTaskEventInput[],
    workspace_id?: string
  ): Promise<GardenTaskClaimResult> {
    const parsedTaskId = parseNonEmptyString(taskId, "garden_task.id");
    const parsedClaimedBy = parseNonEmptyString(claimedBy, "garden_task.claimed_by");
    const parsedClaimedAt = parseTimestamp(claimedAt);
    const parsedWorkspaceId =
      workspace_id === undefined
        ? null
        : parseNonEmptyString(workspace_id, "garden_task.workspace_id");

    if (dispatchedEvents.length === 0) {
      return this.claimAtomic(parsedTaskId, parsedClaimedBy, parsedClaimedAt, workspace_id);
    }

    let claimResult: GardenTaskClaimResult = "already-claimed";
    try {
      await this.eventPublisher.appendManyWithMutation(dispatchedEvents, () => {
        const result = this.claimStatement.run(
          parsedClaimedBy,
          parsedClaimedAt,
          parsedTaskId,
          parsedWorkspaceId,
          parsedWorkspaceId
        );
        claimResult = result.changes === 1 ? "claimed" : "already-claimed";
        if (claimResult !== "claimed") {
          // CAS lost. Roll the audit append back with the same throw-to-rollback
          // contract completeWithEvents already uses for tier-promotion CAS misses.
          throw new GardenTaskClaimCasMiss();
        }
      });
      return claimResult;
    } catch (error) {
      if (error instanceof GardenTaskClaimCasMiss) {
        return "already-claimed";
      }
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to atomically claim Garden task ${parsedTaskId}.`,
        error
      );
    }
  }

  public releaseClaim(taskId: string, claimedBy: string): boolean {
    const parsedTaskId = parseNonEmptyString(taskId, "garden_task.id");
    const parsedClaimedBy = parseNonEmptyString(claimedBy, "garden_task.claimed_by");

    try {
      const result = this.releaseClaimStatement.run(parsedTaskId, parsedClaimedBy);
      return result.changes === 1;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to release Garden task claim ${parsedTaskId}.`,
        error
      );
    }
  }

  public refreshClaim(taskId: string, claimedBy: string, claimedAt: string): boolean {
    const parsedTaskId = parseNonEmptyString(taskId, "garden_task.id");
    const parsedClaimedBy = parseNonEmptyString(claimedBy, "garden_task.claimed_by");
    const parsedClaimedAt = parseTimestamp(claimedAt);

    try {
      const result = this.refreshClaimStatement.run(parsedClaimedAt, parsedTaskId, parsedClaimedBy);
      return result.changes === 1;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to refresh Garden task claim ${parsedTaskId}.`,
        error
      );
    }
  }

  public beginCompletionAttempt(
    taskId: string,
    claimedBy: string,
    completionClaimedBy: string,
    claimedAt: string,
    completionEnvelopeJson?: string | null
  ): boolean {
    const parsedTaskId = parseNonEmptyString(taskId, "garden_task.id");
    const parsedClaimedBy = parseNonEmptyString(claimedBy, "garden_task.claimed_by");
    const parsedCompletionClaimedBy = parseNonEmptyString(
      completionClaimedBy,
      "garden_task.completion_claimed_by"
    );
    const parsedClaimedAt = parseTimestamp(claimedAt);
    const parsedCompletionEnvelopeJson =
      completionEnvelopeJson === undefined
        ? null
        : parseNullableString(completionEnvelopeJson, "garden_task.completion_envelope_json");

    try {
      const result = this.beginCompletionAttemptStatement.run(
        parsedCompletionClaimedBy,
        parsedClaimedAt,
        parsedCompletionEnvelopeJson,
        parsedTaskId,
        parsedClaimedBy,
        parsedCompletionEnvelopeJson
      );
      return result.changes === 1;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to begin Garden task completion attempt ${parsedTaskId}.`,
        error
      );
    }
  }

  public async completeWithEvents(
    taskId: string,
    result: GardenTaskCompletionResult,
    events: readonly GardenTaskEventInput[],
    claimedBy: string
  ): Promise<void> {
    const parsedTaskId = parseNonEmptyString(taskId, "garden_task.id");
    const status = parseCompletedStatus(result.status);
    const completedAt = parseTimestamp(result.completed_at);
    const parsedClaimedBy = parseNonEmptyString(claimedBy, "garden_task.claimed_by");
    const lastErrorText =
      result.last_error_text === undefined
        ? null
        : parseNullableString(result.last_error_text, "garden_task.last_error_text");

    try {
      if (events.length === 0) {
        this.connection.transaction(() => {
          this.completeClaimedTask(parsedTaskId, status, completedAt, lastErrorText, parsedClaimedBy);
        })();
        return;
      }

      await this.eventPublisher.appendManyWithMutation(events, () => {
        this.completeClaimedTask(parsedTaskId, status, completedAt, lastErrorText, parsedClaimedBy);
      });
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to complete Garden task ${parsedTaskId}.`,
        error
      );
    }
  }

  public peekAbandonedClaims(now: string, staleAfterMs: number): readonly GardenTaskRow[] {
    const cutoff = computeStaleClaimCutoff(now, staleAfterMs);

    try {
      const rows = this.peekAbandonedClaimsStatement.all(cutoff) as GardenTaskDbRow[];
      return rows.map((row) => parseGardenTaskRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to read abandoned Garden task claims.", error);
    }
  }

  public async gcAbandonedClaims(reclaims: readonly GardenTaskReclaimInput[]): Promise<number> {
    if (reclaims.length === 0) {
      return 0;
    }

    const parsedReclaims = reclaims.map((reclaim) => ({
      task_id: parseNonEmptyString(reclaim.task_id, "garden_task.id"),
      claimed_by: parseNonEmptyString(reclaim.claimed_by, "garden_task.claimed_by"),
      claimed_at: parseTimestamp(reclaim.claimed_at),
      event: reclaim.event
    }));

    try {
      return await this.eventPublisher.appendManyWithMutation(
        parsedReclaims.map((reclaim) => reclaim.event),
        () => {
          let reclaimed = 0;
          for (const reclaim of parsedReclaims) {
            const result = this.gcAbandonedClaimStatement.run(
              reclaim.task_id,
              reclaim.claimed_by,
              reclaim.claimed_at
            );
            if (result.changes !== 1) {
              throw new StorageError(
                "CONFLICT",
                `Garden task ${reclaim.task_id} claim changed and cannot be reclaimed.`
              );
            }
            reclaimed += 1;
          }
          return reclaimed;
        }
      );
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("QUERY_FAILED", "Failed to reclaim abandoned Garden tasks.", error);
    }
  }

  public peekExpiredUnclaimedTasks(
    kind: GardenTaskKindValue,
    expiredBeforeIso: string,
    limit: number
  ): readonly GardenTaskRow[] {
    const parsedKind = GardenTaskKindSchema.parse(kind);
    const cutoff = parseTimestamp(expiredBeforeIso);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new StorageError(
        "VALIDATION_FAILED",
        `peekExpiredUnclaimedTasks limit must be a positive integer: ${limit}`
      );
    }
    try {
      const rows = this.peekExpiredUnclaimedStatement.all(parsedKind, cutoff, limit) as GardenTaskDbRow[];
      return rows.map((row) => parseGardenTaskRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to read expired unclaimed Garden tasks for kind ${parsedKind}.`,
        error
      );
    }
  }

  public async expireUnclaimedTasks(expirations: readonly GardenTaskExpiryInput[]): Promise<number> {
    if (expirations.length === 0) {
      return 0;
    }
    const parsedExpirations = expirations.map((expiration) => ({
      task_id: parseNonEmptyString(expiration.task_id, "garden_task.id"),
      event: expiration.event
    }));
    try {
      return await this.eventPublisher.appendManyWithMutation(
        parsedExpirations.map((expiration) => expiration.event),
        () => {
          let expired = 0;
          for (const expiration of parsedExpirations) {
            const result = this.expireUnclaimedStatement.run(expiration.task_id);
            // CAS lost (a worker claimed it between peek and delete) -> skip,
            // not an error: the task is now live work, not an orphan.
            if (result.changes === 1) {
              expired += 1;
            }
          }
          return expired;
        }
      );
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("QUERY_FAILED", "Failed to expire unclaimed Garden tasks.", error);
    }
  }

  public countBacklog(workspace_id?: string): readonly GardenTaskBacklogCount[] {
    const workspaceId =
      workspace_id === undefined
        ? null
        : parseNonEmptyString(workspace_id, "garden_task.workspace_id");
    try {
      const rows = this.countByRoleStatusStatement.all(
        workspaceId,
        workspaceId
      ) as GardenTaskBacklogCountDbRow[];
      return rows.map((row) => parseBacklogCountRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to count Garden task backlog.", error);
    }
  }

  public countByKind(
    kind: GardenTaskKindValue,
    staleBeforeIso: string,
    workspace_id?: string
  ): GardenTaskKindBacklogCount {
    const parsedKind = GardenTaskKindSchema.parse(kind);
    const staleBefore = parseTimestamp(staleBeforeIso);
    try {
      const row = (
        workspace_id === undefined
          ? this.countByKindStatement.get(staleBefore, parsedKind)
          : this.countByKindByWorkspaceStatement.get(
              staleBefore,
              parsedKind,
              parseNonEmptyString(workspace_id, "garden_task.workspace_id")
            )
      ) as { readonly pending: number | null; readonly stale: number | null } | undefined;
      return {
        kind: parsedKind,
        pending: row?.pending ?? 0,
        stale: row?.stale ?? 0
      };
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to count Garden task backlog by kind.", error);
    }
  }

  private completeClaimedTask(
    taskId: string,
    status: "completed" | "failed",
    completedAt: string,
    lastErrorText: string | null,
    claimedBy: string
  ): void {
    const update = this.completeStatement.run(status, completedAt, lastErrorText, taskId, claimedBy);
    if (update.changes !== 1) {
      throw new StorageError(
        "CONFLICT",
        `Garden task ${taskId} is not claimed by the expected worker and cannot be completed.`
      );
    }
  }
}

function computeStaleClaimCutoff(now: string, staleAfterMs: number): string {
  const nowMs = new Date(parseTimestamp(now)).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate garden_task.gc.now.");
  }
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate garden_task.gc.stale_after_ms.");
  }
  return new Date(nowMs - staleAfterMs).toISOString();
}

function parseGardenTaskRow(row: GardenTaskDbRow): GardenTaskRow {
  let payload: unknown;

  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse Garden task payload JSON.", error);
  }

  return deepFreeze({
    id: parseNonEmptyString(row.id, "garden_task.id"),
    workspace_id: parseNonEmptyString(row.workspace_id, "garden_task.workspace_id"),
    role: GardenRoleSchema.parse(row.role),
    kind: GardenTaskKindSchema.parse(row.kind),
    payload_json: parseNonEmptyString(row.payload_json, "garden_task.payload_json"),
    payload,
    status: parseStatus(row.status),
    claimed_by: parseNullableString(row.claimed_by, "garden_task.claimed_by"),
    claimed_at: parseNullableString(row.claimed_at, "garden_task.claimed_at"),
    created_at: parseTimestamp(row.created_at),
    completed_at: parseNullableString(row.completed_at, "garden_task.completed_at"),
    attempt_count: row.attempt_count,
    last_error_text: parseNullableString(row.last_error_text, "garden_task.last_error_text"),
    completion_envelope_json: parseNullableString(
      row.completion_envelope_json,
      "garden_task.completion_envelope_json"
    )
  });
}

function parseBacklogCountRow(row: GardenTaskBacklogCountDbRow): GardenTaskBacklogCount {
  const status = row.status === "pending" || row.status === "claimed" ? row.status : null;
  if (status === null) {
    throw new StorageError("VALIDATION_FAILED", `Unexpected Garden backlog status ${row.status}.`);
  }

  return deepFreeze({
    role: GardenRoleSchema.parse(row.role),
    status,
    count: row.count
  });
}

function stringifyPayload(payload: unknown): string {
  const payloadJson = JSON.stringify(payload);
  if (payloadJson === undefined) {
    throw new StorageError("VALIDATION_FAILED", "Garden task payload must be JSON serializable.");
  }
  return payloadJson;
}

function parseLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new StorageError("VALIDATION_FAILED", "Garden task limit must be a positive integer.");
  }
  return limit;
}

function parseStatus(status: string): GardenTaskStatus {
  switch (status) {
    case "pending":
    case "claimed":
    case "completed":
    case "failed":
      return status;
    default:
      throw new StorageError("VALIDATION_FAILED", `Unexpected Garden task status ${status}.`);
  }
}

function parseCompletedStatus(status: string): "completed" | "failed" {
  switch (status) {
    case "completed":
    case "failed":
      return status;
    default:
      throw new StorageError("VALIDATION_FAILED", `Unexpected Garden task completion status ${status}.`);
  }
}

function roleRank(role: GardenRoleValue): number {
  switch (role) {
    case "janitor":
      return 0;
    case "auditor":
      return 1;
    case "librarian":
      return 2;
  }
}
