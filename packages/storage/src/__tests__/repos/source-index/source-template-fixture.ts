import {
  canonicalJson, describeHostStructure, hashSourceRecordId, sourceIndexStatementTarget, sourceStatementArtifact,
  type BoundSourceStatement, type HostOccurrence, type HostOccurrenceInventory, type SourceStatementContextSource
} from "@do-soul/alaya-protocol";
import { SqliteEvidenceCapsuleRepo } from "../../../repos/capsules/evidence-capsule-repo.js";
import { putSourceStatementArtifact } from "../../../repos/source-index/statement-artifact.js";
import type { FieldSourceRecordRow } from "../../../repos/field/ports.js";
import { hashedOriginalRecord } from "../field/field-contract-fixture.js";
import { CLOCK, WORKSPACE, fieldSha256, type Fixture } from "./source-index-fixture.js";
import { targetFor } from "./source-index-query-fixture.js";

type FixtureMessage = Readonly<{ role: string; text: string;
  completeness?: HostOccurrence["completeness"]; fidelity?: HostOccurrence["fidelity"] }>;

export function publishMessages(environment: Pick<Fixture, "database" | "records">,
  messages: readonly FixtureMessage[] = [{ role: "user", text: "I ordered a café cocktail." }],
  sourceId = "source-statements", workspace = WORKSPACE, eventTime: string | null = null,
  scopeClass: FieldSourceRecordRow["scope_class"] = null) {
  let body = "";
  const occurrences = messages.map((message, index) => {
    body += `${message.role}: `;
    const start = Buffer.byteLength(body), text = message.text;
    body += text;
    const end = Buffer.byteLength(body); body += "\n";
    return { occurrence_id: `message-${index}`, utf8_span: [start, end] as const, role: message.role, channel: null,
      author_ref: null, container_ref: { scope: "fixture", id: sourceId }, upstream_message_ref: null,
      upstream_position: index, completeness: message.completeness ?? "complete", fidelity: message.fidelity ?? "original_bytes" };
  });
  const inventory: HostOccurrenceInventory = { contract: "host-occurrence-v1",
    issuer: { namespace: "fixture", workspace_id: workspace, producer: "storage-test", basis: "pinned_dataset" }, occurrences };
  const original = { ...hashedOriginalRecord(workspace, body, sourceId), event_time: eventTime, scope_class: scopeClass };
  const captured = { ...original, host_structure: describeHostStructure(original, inventory, fieldSha256) };
  const record = environment.records.insert({ ...captured, record_id: hashSourceRecordId(captured, fieldSha256) });
  environment.records.putHostInventory(workspace, record.record_id, canonicalJson(inventory));
  return { record, source: targetFor(record), messages, inventory };
}

/** Publishes through the real capsule and statement stores; the label supplies only a stable fixture UUID. */
export function publishStatement(environment: Pick<Fixture, "database">, input: ReturnType<typeof publishMessages>, label: string,
  messageIndex = 0, changes: Partial<BoundSourceStatement> = {}, context: readonly SourceStatementContextSource[] = []) {
  const occurrence = input.inventory.occurrences[messageIndex]!, message = input.messages[messageIndex]!;
  const bound: BoundSourceStatement = {
    contract: "source-statements-v1", session_id: "session-statements", artifact_key: input.record.source_id,
    source_root_id: input.record.record_id, source_corpus_digest: input.record.content_digest.slice("sha256:".length),
    source_context: context, source_target: input.source.target, source_span: occurrence.utf8_span,
    message: { message_id: occurrence.occurrence_id, role: message.role, text: message.text, recorded_at: null },
    statement: { text: message.text, relation: "reported event" }, ...changes
  };
  const hex = fieldSha256(label), id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const artifact = sourceStatementArtifact(bound, id, fieldSha256);
  environment.database.connection.transaction(() => {
    new SqliteEvidenceCapsuleRepo(environment.database).createInCurrentTransaction({
      object_id: id, object_kind: "evidence_capsule", schema_version: 1, lifecycle_state: "active",
      created_at: CLOCK, updated_at: CLOCK, created_by: "storage-test", evidence_kind: "conversation_excerpt",
      semantic_anchor: { topic: bound.statement.relation, keywords: [], summary: bound.statement.text },
      event_anchor: null, physical_anchor: null, evidence_health_state: "questionable", gist: canonicalJson(bound),
      excerpt: bound.message.text, source_hash: bound.source_target.content_digest,
      run_id: "run-statements", workspace_id: input.record.workspace_id, surface_id: null
    }, [], undefined, undefined, undefined, true);
    putSourceStatementArtifact(environment.database, artifact);
  })();
  return { bound, source: sourceIndexStatementTarget(artifact, input.record.source_id) };
}

/** Legal maximum context closure followed by an independently readable small capsule. */
export async function publishFullContextStatement(environment: Pick<Fixture, "database" | "records">, workspace = WORKSPACE) {
  const contexts = Array.from({ length: 128 }, (_, index) =>
    publishMessages(environment, [{ role: "user", text: `Context ${index}.` }], `context-${String(index).padStart(3, "0")}`, workspace).record);
  const source = publishMessages(environment, [{ role: "user", text: "The dependent statement." }], "target", workspace);
  const first = publishStatement(environment, source, "b", 0, {}, contexts.map(contextOf));
  const later = await new SqliteEvidenceCapsuleRepo(environment.database).create({
    object_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", object_kind: "evidence_capsule", schema_version: 1,
    lifecycle_state: "active", created_at: CLOCK, updated_at: CLOCK, created_by: "storage-test",
    evidence_kind: "conversation_excerpt", semantic_anchor: { topic: "later", keywords: [], summary: "later" },
    event_anchor: null, physical_anchor: null, evidence_health_state: "questionable", gist: "Later small capsule.",
    excerpt: "Later small capsule.", source_hash: null, run_id: "run-statements", workspace_id: workspace, surface_id: null
  });
  return { first, later };
}

export function contextOf(record: FieldSourceRecordRow): SourceStatementContextSource {
  return { workspace_id: record.workspace_id, root_id: record.record_id, source_id: record.source_id,
    source_version: record.source_version, content_digest: record.content_digest };
}
