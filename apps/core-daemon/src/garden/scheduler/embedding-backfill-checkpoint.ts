import { createHash, randomUUID } from "node:crypto";
import { AlayaError, hashMemoryContent, GardenEventType, parseGardenEventPayload, type GardenTaskDescriptor,
  type GardenTaskOutcome } from "@do-soul/alaya-protocol";
import type { EventPublisher } from "@do-soul/alaya-core";
import type { StorageDatabase } from "@do-soul/alaya-storage";

type CheckpointState = "backfilling" | "pending" | "completed" | "skipped" | "blocked";
type CheckpointMode = "production" | "cache_only" | "unwired";
type FollowUpDisposition = "pending" | "claimed" | "recovered" | "completed" | "skipped" | "retryable_failure" | "blocked";
type SettleDisposition = Extract<FollowUpDisposition, "completed" | "skipped" | "retryable_failure" | "blocked">;
type FollowUpReason = "operation_failed" | "formation_changed" | "source_unavailable" |
  "cache_only" | "unwired" | "insufficient_objects";

export type EmbeddingBackfillClaim = Readonly<{
  readonly taskId: string;
  readonly workspaceId: string;
  readonly ownerToken: string;
}>;

export type EmbeddingBackfillCheckpointRow = Readonly<{
  readonly task_id: string;
  readonly workspace_id: string;
  readonly state: CheckpointState;
  readonly mode: CheckpointMode;
  readonly owner_token: string | null;
  readonly plan_digest: string | null;
  readonly backfill_outcome: GardenTaskOutcome | null;
  readonly backfill_error: string | null;
  readonly last_error: string | null;
  readonly attempt_count: number;
}>;

export function createEmbeddingFollowUpEvent(input: Readonly<{
  taskId: string; workspaceId: string; disposition: FollowUpDisposition; reason?: FollowUpReason;
  attemptCount: number; occurredAt: string; causedBy: string;
}>) {
  return {
    event_type: GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP,
    entity_type: "garden_task", entity_id: input.taskId, workspace_id: input.workspaceId,
    run_id: null, caused_by: input.causedBy,
    payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP, {
      task_id: input.taskId, workspace_id: input.workspaceId, disposition: input.disposition,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      attempt_count: input.attemptCount, occurred_at: input.occurredAt
    })
  };
}

/** Task-scoped progress; embedding IDs are recorded by the guarded embedding write. */
export class EmbeddingBackfillCheckpoint {
  // Only the executor that awaited its accepted work may declare quiescence.
  // Keep failed recovery audits here for a later pass; restart uses the OS lease.
  private readonly quiescent = new Map<string, EmbeddingBackfillClaim>();

  public constructor(private readonly connection: StorageDatabase["connection"],
    private readonly publisher: Pick<EventPublisher, "appendManyWithMutation" | "decideAppendThenApply">,
    private readonly now: () => string) {}

  public claimTask(task: Readonly<GardenTaskDescriptor>, mode: CheckpointMode): EmbeddingBackfillClaim | null {
    const ownerToken = randomUUID();
    return this.connection.transaction(() => {
      const taskRow = this.connection.prepare(`SELECT 1 FROM garden_tasks WHERE id = ? AND workspace_id = ?
        AND kind = 'embedding_backfill' AND status = 'claimed' AND claimed_by = 'in-process'`)
        .get(task.task_id, task.workspace_id);
      if (taskRow === undefined) throw new AlayaError("CONFLICT", "Garden backfill task claim is not current.");
      if (this.isOwnedByAnotherTask(task.task_id, task.workspace_id)) return null;
      this.connection.prepare(`INSERT OR IGNORE INTO garden_embedding_backfill_runs
        (task_id, workspace_id, state, mode, owner_token, updated_at) VALUES (?, ?, 'backfilling', ?, NULL, ?)`)
        .run(task.task_id, task.workspace_id, mode, this.now());
      const updated = this.connection.prepare(`UPDATE garden_embedding_backfill_runs SET owner_token = ?, updated_at = ?
        WHERE task_id = ? AND workspace_id = ? AND owner_token IS NULL`)
        .run(ownerToken, this.now(), task.task_id, task.workspace_id);
      return updated.changes === 1 ? { taskId: task.task_id, workspaceId: task.workspace_id, ownerToken } : null;
    })();
  }

  public async claimPending(workspaceId?: string, excludedTaskIds: readonly string[] = []): Promise<EmbeddingBackfillClaim | null> {
    const ownerToken = randomUUID();
    const occurredAt = this.now();
    return await this.publisher.decideAppendThenApply(() => {
      const row = this.connection.prepare(`SELECT r.task_id, r.workspace_id, r.attempt_count FROM garden_embedding_backfill_runs r
        JOIN garden_tasks t ON t.id = r.task_id AND t.workspace_id = r.workspace_id
        WHERE r.state = 'pending' AND r.owner_token IS NULL AND t.status = 'failed'
          AND NOT EXISTS (SELECT 1 FROM garden_embedding_backfill_runs busy
            WHERE busy.workspace_id = r.workspace_id AND busy.owner_token IS NOT NULL)
          AND (? IS NULL OR r.workspace_id = ?) AND r.task_id NOT IN (SELECT value FROM json_each(?))
        ORDER BY r.attempt_count, r.updated_at, r.task_id LIMIT 1`)
        .get(workspaceId ?? null, workspaceId ?? null, JSON.stringify(excludedTaskIds)) as {
          task_id: string; workspace_id: string; attempt_count: number;
        } | undefined;
      if (row === undefined) return { eventInputs: [], apply: () => null };
      const claim = { taskId: row.task_id, workspaceId: row.workspace_id, ownerToken };
      return { eventInputs: [createEmbeddingFollowUpEvent({ ...claim, disposition: "claimed",
        attemptCount: row.attempt_count, occurredAt, causedBy: "garden-scheduler" })],
        apply: () => {
          const update = this.connection.prepare(`UPDATE garden_embedding_backfill_runs SET owner_token = ?, updated_at = ?
            WHERE task_id = ? AND workspace_id = ? AND state = 'pending' AND owner_token IS NULL`)
            .run(ownerToken, occurredAt, row.task_id, row.workspace_id);
          if (update.changes !== 1) throw new AlayaError("CONFLICT", "Garden follow-up claim changed during dispatch.");
          return claim;
        } };
    });
  }

  public async relinquishQuiescent(claim: EmbeddingBackfillClaim): Promise<void> {
    this.quiescent.set(claim.taskId, claim);
    await this.recoverQuiescent(claim.workspaceId);
  }

  public async recoverQuiescent(workspaceId?: string): Promise<void> {
    for (const claim of this.quiescent.values()) {
      if (workspaceId !== undefined && claim.workspaceId !== workspaceId) continue;
      await this.publisher.decideAppendThenApply(() => {
        const row = this.connection.prepare(`SELECT r.attempt_count, t.status, t.claimed_by
          FROM garden_embedding_backfill_runs r JOIN garden_tasks t
            ON t.id = r.task_id AND t.workspace_id = r.workspace_id
          WHERE r.task_id = ? AND r.workspace_id = ? AND r.owner_token = ?`)
          .get(claim.taskId, claim.workspaceId, claim.ownerToken) as {
            attempt_count: number; status: string; claimed_by: string | null;
          } | undefined;
        if (row === undefined) return { eventInputs: [], apply: () => undefined };
        if (row.status === "claimed" && row.claimed_by !== "in-process") {
          throw new AlayaError("CONFLICT", "Quiescent Garden task no longer belongs to its executor.");
        }
        const occurredAt = this.now();
        return { eventInputs: [createEmbeddingFollowUpEvent({ ...claim, disposition: "recovered",
          attemptCount: row.attempt_count, occurredAt, causedBy: "garden-settled-attempt-recovery" })],
          apply: () => {
            // This transaction never changes a terminal parent or its committed completion receipt.
            if (row.status === "claimed") {
              const parent = this.connection.prepare(`UPDATE garden_tasks SET status = 'pending',
                claimed_by = NULL, claimed_at = NULL WHERE id = ? AND workspace_id = ?
                AND status = 'claimed' AND claimed_by = 'in-process'`)
                .run(claim.taskId, claim.workspaceId);
              if (parent.changes !== 1) throw new AlayaError("CONFLICT", "Quiescent Garden parent claim changed.");
            }
            this.release(claim);
          } };
      });
      if (this.quiescent.get(claim.taskId) === claim) this.quiescent.delete(claim.taskId);
    }
  }

  public hasPendingRetryWorkspace(workspaceId: string): boolean {
    return this.connection.prepare(`SELECT 1 FROM garden_embedding_backfill_runs r
      JOIN garden_tasks t ON t.id = r.task_id AND t.workspace_id = r.workspace_id
      WHERE r.workspace_id = ? AND r.state = 'pending' AND t.status = 'failed' LIMIT 1`)
      .get(workspaceId) !== undefined;
  }

  public hasBlockedWorkspace(workspaceId: string): boolean {
    return this.connection.prepare(`SELECT 1 FROM garden_embedding_backfill_runs r
      JOIN garden_tasks t ON t.id = r.task_id AND t.workspace_id = r.workspace_id
      WHERE r.workspace_id = ? AND r.state = 'blocked' AND t.status = 'failed' LIMIT 1`)
      .get(workspaceId) !== undefined;
  }

  public hasActiveWorkspace(workspaceId: string): boolean {
    return this.connection.prepare(`SELECT 1 FROM garden_embedding_backfill_runs
      WHERE workspace_id = ? AND owner_token IS NOT NULL LIMIT 1`).get(workspaceId) !== undefined;
  }

  public isOwnedByAnotherTask(taskId: string, workspaceId: string): boolean {
    return this.connection.prepare(`SELECT 1 FROM garden_embedding_backfill_runs
      WHERE workspace_id = ? AND task_id != ? AND owner_token IS NOT NULL LIMIT 1`)
      .get(workspaceId, taskId) !== undefined;
  }

  public read(claim: EmbeddingBackfillClaim): EmbeddingBackfillCheckpointRow {
    const row = this.connection.prepare(`SELECT task_id, workspace_id, state, mode, owner_token, plan_digest,
      backfill_outcome, backfill_error, last_error, attempt_count FROM garden_embedding_backfill_runs
      WHERE task_id = ? AND workspace_id = ? AND owner_token = ?`)
      .get(claim.taskId, claim.workspaceId, claim.ownerToken) as EmbeddingBackfillCheckpointRow | undefined;
    if (row === undefined) throw new AlayaError("CONFLICT", "Garden embedding follow-up claim changed.");
    return row;
  }

  public objectIds(claim: EmbeddingBackfillClaim): readonly string[] {
    this.read(claim);
    return (this.connection.prepare(`SELECT object_id FROM garden_embedding_backfill_objects
      WHERE task_id = ? ORDER BY sequence`).all(claim.taskId) as { object_id: string }[]).map(row => row.object_id);
  }

  public async finishBackfill(claim: EmbeddingBackfillClaim, outcome: GardenTaskOutcome | undefined, error: string | null): Promise<void> {
    const occurredAt = this.now();
    await this.publisher.appendManyWithMutation([createEmbeddingFollowUpEvent({ ...claim,
      disposition: "pending", attemptCount: 0, occurredAt, causedBy: "garden-scheduler" })], () => {
      const update = this.connection.prepare(`UPDATE garden_embedding_backfill_runs SET state = 'pending',
        backfill_outcome = ?, backfill_error = ?, updated_at = ?
        WHERE task_id = ? AND workspace_id = ? AND owner_token = ? AND state = 'backfilling'`)
        .run(outcome ?? null, error, occurredAt, claim.taskId, claim.workspaceId, claim.ownerToken);
      if (update.changes !== 1) throw new AlayaError("CONFLICT", "Garden backfill checkpoint changed before handoff.");
    });
  }

  public pinPlan(claim: EmbeddingBackfillClaim, digest: string): boolean {
    return this.connection.transaction(() => {
      const row = this.read(claim);
      if (row.state !== "pending") throw new AlayaError("CONFLICT", "Garden follow-up is not pending.");
      if (row.plan_digest !== null) return row.plan_digest === digest;
      const update = this.connection.prepare(`UPDATE garden_embedding_backfill_runs SET plan_digest = ?, updated_at = ?
        WHERE task_id = ? AND workspace_id = ? AND owner_token = ? AND state = 'pending' AND plan_digest IS NULL`)
        .run(digest, this.now(), claim.taskId, claim.workspaceId, claim.ownerToken);
      if (update.changes !== 1) throw new AlayaError("CONFLICT", "Garden follow-up plan changed before pinning.");
      return true;
    })();
  }

  public assertPendingInCurrentTransaction(claim: EmbeddingBackfillClaim): undefined {
    if (this.read(claim).state !== "pending") {
      throw new AlayaError("CONFLICT", "Garden embedding follow-up is no longer eligible.");
    }
    const rows = this.connection.prepare(`SELECT o.content_hash AS recorded_hash, m.content,
        e.content_hash AS embedding_hash FROM garden_embedding_backfill_objects o
      LEFT JOIN memory_entries m ON m.object_id = o.object_id AND m.workspace_id = ?
      LEFT JOIN memory_embeddings e ON e.object_id = o.object_id AND e.workspace_id = ?
      WHERE o.task_id = ?`).all(claim.workspaceId, claim.workspaceId, claim.taskId) as {
        recorded_hash: string; content: string | null; embedding_hash: string | null;
      }[];
    for (const row of rows) {
      if (row.content === null || row.embedding_hash !== row.recorded_hash ||
          hashMemoryContent(row.content, value => createHash("sha256").update(value, "utf8").digest("hex")) !== row.recorded_hash) {
        throw new AlayaError("CONFLICT", "Garden backfill embedding is stale or unavailable.");
      }
    }
    return undefined;
  }

  public async settle(claim: EmbeddingBackfillClaim, disposition: SettleDisposition,
    reason?: FollowUpReason): Promise<void> {
    const before = this.read(claim);
    if (before.state !== "pending") throw new AlayaError("CONFLICT", "Garden embedding follow-up is not pending.");
    const state = disposition === "retryable_failure" ? "pending" : disposition;
    const occurredAt = this.now();
    try {
      await this.publisher.appendManyWithMutation([createEmbeddingFollowUpEvent({ ...claim,
        disposition, ...(reason === undefined ? {} : { reason }), attemptCount: before.attempt_count + 1,
        occurredAt, causedBy: "garden-scheduler" })], () => {
      const update = this.connection.prepare(`UPDATE garden_embedding_backfill_runs SET state = ?, last_error = ?,
        attempt_count = attempt_count + 1, updated_at = ? WHERE task_id = ? AND workspace_id = ?
        AND owner_token = ? AND state = 'pending' AND attempt_count = ?`)
        .run(state, reason ?? null, occurredAt, claim.taskId, claim.workspaceId, claim.ownerToken, before.attempt_count);
      if (update.changes !== 1) throw new AlayaError("CONFLICT", "Garden follow-up claim changed during settlement.");
      });
    } catch (error) {
      const after = this.read(claim);
      if (after.state !== state || after.attempt_count !== before.attempt_count + 1) throw error;
    }
  }

  public release(claim: EmbeddingBackfillClaim): void {
    const update = this.connection.prepare(`UPDATE garden_embedding_backfill_runs SET owner_token = NULL, updated_at = ?
      WHERE task_id = ? AND workspace_id = ? AND owner_token = ?`)
      .run(this.now(), claim.taskId, claim.workspaceId, claim.ownerToken);
    if (update.changes !== 1) throw new AlayaError("CONFLICT", "Garden embedding follow-up claim could not be released.");
  }
}
