import { randomUUID } from "node:crypto";
import {
  GardenRoleSchema,
  GardenTaskKindSchema,
  type GardenRoleValue,
  type GardenTaskKindValue
} from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "../../sqlite/db.js";
import { prepareGardenTaskStatements } from "./garden-task-statements.js";
import { StorageError } from "../../shared/errors.js";
import { parseNonEmptyString, parseNullableString, parseTimestamp } from "../shared/validators.js";
import { parseClaimRequest } from "./garden-task-claim-request.js";
import { GardenTaskClaimCasMiss, isUniqueConstraintError } from "./garden-task-errors.js";
import {
  computeStaleClaimCutoff,
  parseBacklogCountRow,
  parseCompletedStatus,
  parseGardenTaskRow,
  parseLimit,
  roleRank,
  stringifyPayload,
  type GardenTaskBacklogCountDbRow,
  type GardenTaskDbRow
} from "./garden-task-rows.js";
import type { GardenTaskBacklogCount, GardenTaskClaimResult, GardenTaskCompletionResult, GardenTaskEnqueueInput, GardenTaskEventInput, GardenTaskEventPublisherPort, GardenTaskExpiryInput, GardenTaskKindBacklogCount, GardenTaskReclaimInput, GardenTaskRepoPort, GardenTaskRow } from "./garden-task-types.js";

export type * from "./garden-task-types.js";

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
    const statements = prepareGardenTaskStatements(connection);
    this.enqueueStatement = statements.enqueueStatement;
    this.findByIdStatement = statements.findByIdStatement;
    this.peekPendingStatement = statements.peekPendingStatement;
    this.peekPendingByWorkspaceStatement = statements.peekPendingByWorkspaceStatement;
    this.claimStatement = statements.claimStatement;
    this.releaseClaimStatement = statements.releaseClaimStatement;
    this.beginCompletionAttemptStatement = statements.beginCompletionAttemptStatement;
    this.refreshClaimStatement = statements.refreshClaimStatement;
    this.completeStatement = statements.completeStatement;
    this.peekAbandonedClaimsStatement = statements.peekAbandonedClaimsStatement;
    this.gcAbandonedClaimStatement = statements.gcAbandonedClaimStatement;
    this.peekExpiredUnclaimedStatement = statements.peekExpiredUnclaimedStatement;
    this.expireUnclaimedStatement = statements.expireUnclaimedStatement;
    this.countByRoleStatusStatement = statements.countByRoleStatusStatement;
    this.countByKindStatement = statements.countByKindStatement;
    this.countByKindByWorkspaceStatement = statements.countByKindByWorkspaceStatement;
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
      // Surface PK collisions as the structured DUPLICATE_KEY error code,
      // matching the convention the workspace repo uses. Callers (notably the
      // POST_TURN_EXTRACT dedupe path) use `error.code === "DUPLICATE_KEY"`
      // instead of walking the SQLite error message string, which couples the
      // dedupe contract to better-sqlite3's internal text format.
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
    const request = parseClaimRequest(taskId, claimedBy, claimedAt, workspace_id);

    try {
      const result = this.claimStatement.run(
        request.claimedBy,
        request.claimedAt,
        request.taskId,
        request.workspaceId,
        request.workspaceId
      );
      return result.changes === 1 ? "claimed" : "already-claimed";
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to claim Garden task ${request.taskId}.`, error);
    }
  }

  public async claimAtomicWithEvents(
    taskId: string,
    claimedBy: string,
    claimedAt: string,
    dispatchedEvents: readonly GardenTaskEventInput[],
    workspace_id?: string
  ): Promise<GardenTaskClaimResult> {
    const request = parseClaimRequest(taskId, claimedBy, claimedAt, workspace_id);

    if (dispatchedEvents.length === 0) {
      return this.claimAtomic(request.taskId, request.claimedBy, request.claimedAt, workspace_id);
    }

    let claimResult: GardenTaskClaimResult = "already-claimed";
    try {
      await this.eventPublisher.appendManyWithMutation(dispatchedEvents, () => {
        const result = this.claimStatement.run(
          request.claimedBy,
          request.claimedAt,
          request.taskId,
          request.workspaceId,
          request.workspaceId
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
        `Failed to atomically claim Garden task ${request.taskId}.`,
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
