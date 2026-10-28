import { GardenEventType, GardenTaskKind, renderOfficialApiSourceCorpus, SourceRepresentationSchema,
  SourceScopeClassSchema } from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { CURRENT_SOURCE_RECORD_ORDER, readSourceProjectionDependencies } from "../field/source-representation-read.js";
import { parseTimestamp } from "../shared/validators.js";
import { parseGardenTaskRow, type GardenTaskDbRow } from "./mappers/garden-task-rows.js";
import type { GardenTaskEventInput, GardenTaskEventPublisherPort, GardenTaskRow } from "./garden-task-types.js";

/** Availability facts only; the daemon supplies the runtime failure transition's audit. */
export class GardenTaskSourceProvenance {
  private readonly scanAfterByWorkspace = new Map<string, string>();
  public constructor(private readonly connection: SqliteConnection) {}

  public unavailableReason(task: GardenTaskRow): string | null {
    if (task.kind !== GardenTaskKind.POST_TURN_EXTRACT) return null;
    const payload = record(task.payload);
    const rootId = payload?.admitted_source_root_id;
    if (typeof rootId !== "string" || rootId.length === 0) return "missing admitted source binding";
    if (payload?.workspace_id !== task.workspace_id) return "source workspace mismatch";
    const digest = record(payload.turn_digest);
    const messages = digest?.last_messages;
    if (!Array.isArray(messages) || messages.length === 0 || messages.some(message => {
      const item = record(message);
      return typeof item?.role !== "string" || typeof item.content_excerpt !== "string";
    })) return "unavailable turn digest";
    const content = renderOfficialApiSourceCorpus("", messages.map(message => ({
      role: message.role as string, content: message.content_excerpt as string
    }))).content;
    const root = this.connection.prepare(`SELECT record_id, scope_class, source_representation_json,
      source_body IS NOT NULL AS body_available, source_body = ? AS body_matches,
      (SELECT record_id FROM source_records INDEXED BY idx_source_records_current
       WHERE workspace_id = origin.workspace_id AND source_id = origin.source_id
       ORDER BY ${CURRENT_SOURCE_RECORD_ORDER} LIMIT 1) AS current_identity
      FROM source_records origin WHERE workspace_id = ? AND record_id = ?`)
      .get(content, task.workspace_id, rootId) as { record_id: string; scope_class: unknown;
        source_representation_json: string | null; body_available: number; body_matches: number;
        current_identity: string | null } | undefined;
    if (root === undefined || root.body_available !== 1) return "retained source unavailable";
    if (root.current_identity !== root.record_id) return "source binding superseded";
    if (root.body_matches !== 1) return "turn digest differs from admitted source";
    const representation = root.source_representation_json === null ? undefined
      : SourceRepresentationSchema.parse(JSON.parse(root.source_representation_json));
    const scope = root.scope_class == null ? null : SourceScopeClassSchema.parse(root.scope_class);
    if (!readSourceProjectionDependencies({ connection: this.connection }, {
      workspace_id: task.workspace_id, scope_class: scope, source_representation: representation
    }, CURRENT_SOURCE_RECORD_ORDER).available) return "source projection dependency unavailable";
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
    const rows = this.connection.prepare(`SELECT * FROM garden_tasks WHERE kind = ?
      AND status IN ('pending', 'claimed') AND (? IS NULL OR workspace_id = ?)
      AND (? IS NULL OR id = ?) AND id > ? ORDER BY id LIMIT 100`)
      .all(GardenTaskKind.POST_TURN_EXTRACT, workspaceId ?? null, workspaceId ?? null, taskId ?? null, taskId ?? null, afterId);
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
      const reason = `Post-turn source provenance unavailable: ${unavailable}`;
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
          this.connection.prepare(`UPDATE garden_tasks SET status = 'failed', completed_at = ?,
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
