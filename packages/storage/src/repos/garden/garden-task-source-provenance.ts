import { GardenEventType, GardenTaskKind } from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { parseTimestamp } from "../shared/validators.js";
import { parseGardenTaskRow, type GardenTaskDbRow } from "./mappers/garden-task-rows.js";
import type { GardenTaskEventInput, GardenTaskEventPublisherPort, GardenTaskRow } from "./garden-task-types.js";
import { GardenStatementSessionSources } from "./garden-statement-session-sources.js";

/** Availability facts only; the daemon supplies the runtime failure transition's audit. */
export class GardenTaskSourceProvenance {
  private readonly scanAfterByWorkspace = new Map<string, string>();
  private readonly sessionSources: GardenStatementSessionSources;
  public constructor(private readonly connection: SqliteConnection) {
    this.sessionSources = new GardenStatementSessionSources(connection);
  }

  public unavailableReason(task: GardenTaskRow): string | null {
    if (task.kind === GardenTaskKind.SOURCE_STATEMENT_SESSION) return this.sessionUnavailableReason(task);
    // Host messages are captured as host sessions now; historical post-turn work fails with an audited completion.
    return task.kind === GardenTaskKind.POST_TURN_EXTRACT ? "post-turn capture retired" : null;
  }

  /** Every model-visible member root must still be available; one erased root fails the whole request. */
  private sessionUnavailableReason(task: GardenTaskRow): string | null {
    const payload = record(task.payload);
    if (payload?.workspace_id !== task.workspace_id) return "source workspace mismatch";
    const members = [payload.context, payload.targets].flatMap(value => Array.isArray(value) ? value : [null]);
    if (!Array.isArray(payload.targets) || payload.targets.length === 0) return "missing statement session roots";
    for (const member of members) {
      const rootId = record(member)?.root_id;
      if (typeof rootId !== "string" || rootId.length === 0) return "missing statement session roots";
      const read = this.sessionSources.root(task.workspace_id, rootId);
      if (read.status === "unavailable") return read.reason;
    }
    return null;
  }

  public available(task: GardenTaskRow | null): boolean {
    return task !== null && this.unavailableReason(task) === null;
  }

  public async quarantine(
    publisher: GardenTaskEventPublisherPort,
    completedAt: string,
    eventForTask: (task: GardenTaskRow, reason: string) => GardenTaskEventInput,
    workspaceId?: string,
    taskId?: string
  ): Promise<number> {
    const timestamp = parseTimestamp(completedAt);
    const scanKey = workspaceId ?? "";
    const afterId = taskId === undefined ? this.scanAfterByWorkspace.get(scanKey) ?? "" : "";
    const rows = this.connection.prepare(`SELECT * FROM garden_tasks WHERE kind IN (?, ?)
      AND status IN ('pending', 'claimed') AND (? IS NULL OR workspace_id = ?)
      AND (? IS NULL OR id = ?) AND id > ? ORDER BY id LIMIT 100`)
      .all(GardenTaskKind.POST_TURN_EXTRACT, GardenTaskKind.SOURCE_STATEMENT_SESSION, workspaceId ?? null, workspaceId ?? null,
        taskId ?? null, taskId ?? null, afterId);
    // Valid active work must not pin maintenance to a permanently unchanged prefix.
    if (taskId === undefined) {
      if (rows.length === 100) this.scanAfterByWorkspace.set(scanKey, (rows.at(-1) as GardenTaskDbRow).id);
      else this.scanAfterByWorkspace.delete(scanKey);
    }
    let count = 0;
    for (const value of rows) {
      const row = parseGardenTaskRow(value as GardenTaskDbRow);
      const unavailable = this.unavailableReason(row);
      if (unavailable === null) continue;
      const reason = `${row.kind === GardenTaskKind.POST_TURN_EXTRACT ? "Post-turn" : "Statement session"} source provenance unavailable: ${unavailable}`;
      const event = eventForTask(row, reason);
      if (event.event_type !== GardenEventType.SOUL_GARDEN_TASK_COMPLETED || event.entity_id !== row.id ||
          event.workspace_id !== row.workspace_id || event.payload_json.success !== false) {
        throw new StorageError("VALIDATION_FAILED", "Source quarantine requires the task's unsuccessful completion audit.");
      }
      try {
        await publisher.appendManyWithMutation([event], () => {
          const current = this.connection.prepare("SELECT * FROM garden_tasks WHERE id = ? AND workspace_id = ?")
            .get(row.id, row.workspace_id) as GardenTaskDbRow | undefined;
          if (current === undefined || !["pending", "claimed"].includes(current.status) ||
              this.unavailableReason(parseGardenTaskRow(current)) !== unavailable) throw new QuarantineLostRace();
          this.connection.prepare(`UPDATE garden_tasks SET status = 'failed', outcome = 'failed', completed_at = ?,
            claimed_by = NULL, claimed_at = NULL,
            last_error_text = CASE WHEN last_error_text IS NULL THEN ? ELSE last_error_text || char(10) || ? END
            WHERE id = ? AND workspace_id = ? AND status IN ('pending', 'claimed')`)
            .run(timestamp, reason, reason, row.id, row.workspace_id);
        });
        count += 1;
      } catch (error) {
        if (!(error instanceof QuarantineLostRace)) throw error;
      }
    }
    return count;
  }
}

class QuarantineLostRace extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
