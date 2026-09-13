import { createHash } from "node:crypto";
import { canonicalJson, type EventLogEntry } from "@do-soul/alaya-protocol";

export type RelationFormationEventSource = Pick<
  EventLogEntry,
  | "event_id"
  | "event_type"
  | "entity_type"
  | "entity_id"
  | "workspace_id"
  | "run_id"
  | "caused_by"
  | "revision"
  | "payload_json"
  | "created_at"
>;

export function digestRelationFormationEventSource(
  event: Readonly<RelationFormationEventSource>
): string {
  return createHash("sha256")
    .update(canonicalJson({
      event_id: event.event_id,
      event_type: event.event_type,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      workspace_id: event.workspace_id,
      run_id: event.run_id,
      caused_by: event.caused_by,
      revision: event.revision,
      payload_json: event.payload_json,
      created_at: event.created_at
    }), "utf8")
    .digest("hex");
}
