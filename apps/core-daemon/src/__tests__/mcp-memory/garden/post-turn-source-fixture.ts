import { createSourceAdmissionPort, fieldContractSha256 } from "@do-soul/alaya-core";
import {
  SourceStatementRequestSchema, renderOfficialApiSourceCorpus, type HostOccurrence, type SourceRepresentation,
  type SourceStatement, type SourceStatementMessage
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { parsePostTurnExtractTaskPayload } from "../../../garden/post-turn-extract/task-payload.js";
import { admitPostTurnSourceRoot } from "../../../garden/post-turn-extract/admitted-source-root.js";

/** Happy-path queue fixtures retain actual source receipts and host occurrences, as the production producer does. */
export function bindPostTurnTaskSource<T>(database: StorageDatabase, payload: T, sourceId: string): T {
  const parsed = parsePostTurnExtractTaskPayload(payload);
  if (parsed.admitted_source_root_id !== undefined) return payload;
  const admission = createSourceAdmissionPort({ sha256: fieldContractSha256,
    stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
    hostCaptureBinding: request => ({ namespace: "alaya", workspace_id: request.workspace_id,
      producer: "post-turn", basis: "reported_excerpt" }) });
  const messages = parsed.turn_digest.last_messages, recordedAt = parsed.created_at ?? "2026-05-07T00:00:00.000Z";
  const occurrence = (index: number, utf8_span: readonly [number, number], fidelity: HostOccurrence["fidelity"]): HostOccurrence => ({
    occurrence_id: `${sourceId}:message:${index}`, utf8_span, role: messages[index]!.role, channel: null, author_ref: null,
    container_ref: null, upstream_message_ref: null, upstream_position: null, completeness: "excerpt", fidelity });
  const admit = (id: string, content: string, source_representation: SourceRepresentation,
    host_occurrences: readonly HostOccurrence[]) => admitPostTurnSourceRoot({ admission, workspaceId: parsed.workspace_id,
    sourceId: id, content, recordedAt, eventTime: null, scope_class: "project", source_representation, host_occurrences })!.record;
  const originalIds = messages.map((message, index) => admit(`${sourceId}:message:${index}`, message.content_excerpt,
    { kind: "retained_excerpt" }, [occurrence(index, [0, Buffer.byteLength(message.content_excerpt, "utf8")], "original_bytes")]).identity);
  const rendered = renderOfficialApiSourceCorpus("", messages.map(message => ({ role: message.role, content: message.content_excerpt })));
  const root = admit(sourceId, rendered.content, { kind: "canonical_projection", source_record_ids: originalIds },
    rendered.occurrences.map(row => occurrence(row.message_index, row.utf8_span, row.fidelity)));
  return { ...payload, admitted_source_root_id: root.identity };
}

export function readRetainedPostTurnSource(database: StorageDatabase, taskId: string) {
  return database.connection.prepare(`SELECT source.record_id, source.source_body FROM source_records source
    JOIN garden_tasks task ON task.workspace_id = source.workspace_id
      AND json_extract(task.payload_json, '$.admitted_source_root_id') = source.record_id
    WHERE task.id = ?`).get(taskId) as { record_id: string; source_body: string | null } | undefined;
}

/** Recorded host-worker output echoes the claimed request's host message ids only. */
export function recordedSessionResponses(claimedPayload: unknown,
  respond: (message: SourceStatementMessage) => readonly SourceStatement[]) {
  const request = SourceStatementRequestSchema.parse(
    (claimedPayload as { source_statements: { requests: readonly unknown[] } }).source_statements.requests[0]);
  return [{ chunk_index: request.chunk_index, raw_json: JSON.stringify({ messages: request.messages.map(message => ({
    message_id: message.message_id, statements: respond(message) })) }) }];
}
