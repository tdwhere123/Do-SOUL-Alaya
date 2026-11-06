import { sourceIndexStatementTarget, sourceIndexTarget, sourceStatementArtifact,
  type BoundSourceStatement, type SourceIndexTemplateRead, type SourceTemplateProposal } from "@do-soul/alaya-protocol";
import { hashedOriginalRecord } from "../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";
import { fieldSha256 } from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";

export const template: SourceTemplateProposal = { interpretation_clock: "2026-09-07T00:00:00.000Z",
  asked_speaker: "user", evidence_statements: ["I finally beat <game> last weekend."] };
export const templateBudget = { work_units: 1_000_000, memory_bytes: 64_000_000 };
export const readResources = { work: 7, memory_bytes: 300, native_bytes: 120, sql_internal_work: "unknown" as const };

export function templateStatement(id: string, text = "I finally beat Dark Souls 3 last weekend, after weeks of trying.",
  raw = text, role = "user") {
  const prefix = "😀 user: ", body = prefix + raw, record = hashedOriginalRecord("workspace-template", body, id);
  const source = sourceIndexTarget({ kind: "source_evidence", workspace_id: record.workspace_id,
    root_kind: "source_record", root_id: record.record_id, source_version: record.source_version,
    content_digest: record.content_digest, evidence_object_id: record.evidence_object_id }, id, Buffer.byteLength(body));
  const bound: BoundSourceStatement = { contract: "source-statements-v1", session_id: "session-template",
    artifact_key: id, source_root_id: record.record_id, source_corpus_digest: record.content_digest.slice(7),
    source_context: [], source_target: source.target,
    source_span: [Buffer.byteLength(prefix), Buffer.byteLength(body)],
    message: { message_id: `message-${id}`, role, text: raw, recorded_at: null },
    statement: { text, relation: "event" } };
  const artifact = sourceStatementArtifact(bound, `artifact-${id}`, fieldSha256);
  const statement = { source: sourceIndexStatementTarget(artifact, id), bound };
  const read: SourceIndexTemplateRead = { status: "complete", statements: [statement], resources: readResources };
  return { source, statement, read, body };
}
