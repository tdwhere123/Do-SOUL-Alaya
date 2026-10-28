import { createSourceAdmissionPort, fieldContractSha256 } from "@do-soul/alaya-core";
import { renderOfficialApiSourceCorpus } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { parsePostTurnExtractTaskPayload } from "../../../garden/post-turn-extract/task-payload.js";

/** Happy-path queue fixtures retain actual source receipts, as the production producer does. */
export function bindPostTurnTaskSource<T>(database: StorageDatabase, payload: T, sourceId: string): T {
  const parsed = parsePostTurnExtractTaskPayload(payload);
  if (parsed.admitted_source_root_id !== undefined) return payload;
  const admission = createSourceAdmissionPort({ sha256: fieldContractSha256,
    stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }) });
  const messages = parsed.turn_digest.last_messages;
  const originalIds = messages.map((message, index) => admission.admit({
    workspace_id: parsed.workspace_id, source_id: `${sourceId}:message:${index}`, source_version: "1",
    content_bytes: message.content_excerpt, evidence_object_id: null,
    recorded_at: parsed.created_at ?? "2026-05-07T00:00:00.000Z", event_time: null, valid_from: null, valid_to: null,
    scope_class: "project", source_representation: { kind: "retained_excerpt" }, spans: []
  }, { workspaceId: parsed.workspace_id }).record.identity);
  const root = admission.admit({ workspace_id: parsed.workspace_id, source_id: sourceId, source_version: "1",
    content_bytes: renderOfficialApiSourceCorpus("", messages.map(message => ({
      role: message.role, content: message.content_excerpt
    }))).content, evidence_object_id: null, recorded_at: parsed.created_at ?? "2026-05-07T00:00:00.000Z",
    event_time: null, valid_from: null, valid_to: null, scope_class: "project",
    source_representation: { kind: "canonical_projection", source_record_ids: originalIds }, spans: []
  }, { workspaceId: parsed.workspace_id }).record;
  return { ...payload, admitted_source_root_id: root.identity };
}

export function readRetainedPostTurnSource(database: StorageDatabase, taskId: string) {
  return database.connection.prepare(`SELECT source.record_id, source.source_body FROM source_records source
    JOIN garden_tasks task ON task.workspace_id = source.workspace_id
      AND json_extract(task.payload_json, '$.admitted_source_root_id') = source.record_id
    WHERE task.id = ?`).get(taskId) as { record_id: string; source_body: string | null } | undefined;
}
