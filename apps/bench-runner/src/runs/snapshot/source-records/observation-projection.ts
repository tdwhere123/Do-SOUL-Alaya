import { AlayaError, canonicalJson, type SourceRecordIdentity } from "@do-soul/alaya-protocol";
import { describeLongMemEvalSessionTime } from "../../../datasets/longmemeval/ingestion/source-time.js";
import { inspectSourceRecordsArtifact, type SourceRecordsMessage } from "./contract.js";

export const SOURCE_OBSERVATION_PROJECTION = "benchmark-session-observation.v1";

/** Optional, explicitly selected private evidence. The existing manifest owns the
 * DB, dataset and shard digests; this reader neither repairs nor invents metadata. */
export function bindSourceRecordsObservation(input: {
  source_records?: { snapshot: string; manifest_sha256: string };
  question_id: string; workspace: string;
}) {
  const messages = new Map<string, SourceRecordsMessage>();
  const accounting = { artifact_messages_visited: 0, retained_question_messages: 0 };
  if (input.source_records !== undefined) {
    const { manifest } = inspectSourceRecordsArtifact(input.source_records.snapshot, message => {
      accounting.artifact_messages_visited++;
      if (message.question_id !== input.question_id) return;
      if (message.record.workspace_id !== input.workspace || messages.has(message.record.identity)) {
        throw new AlayaError("CONFLICT", "source observation membership conflict");
      }
      messages.set(message.record.identity, message); accounting.retained_question_messages++;
    });
    if (manifest.manifest_sha256 !== input.source_records.manifest_sha256 ||
        !manifest.dataset.question_ids.includes(input.question_id)) {
      throw new AlayaError("CONFLICT", "source observation manifest binding mismatch");
    }
  }
  const project = (record: SourceRecordIdentity) => {
    const base = { contract: SOURCE_OBSERVATION_PROJECTION,
      recorded_at: record.recorded_at, event_time: record.event_time,
      valid_from: record.valid_from, valid_to: record.valid_to };
    if (input.source_records === undefined) return { ...base,
      observation: { status: "unknown" as const, reason: "artifact_not_bound" as const } };
    const message = messages.get(record.identity);
    if (message === undefined || canonicalJson(message.record) !== canonicalJson(record)) {
      throw new AlayaError("CONFLICT", "source observation differs from read SQLite record");
    }
    const binding = { manifest_sha256: input.source_records.manifest_sha256, record_id: record.identity,
      question_id: message.question_id, session_id: message.session_id,
      session_index: message.session_index, message_index: message.message_index };
    return { ...base, binding, observation: message.source_observation === undefined
      ? { status: "unknown" as const, reason: "historical_granularity_not_retained" as const }
      : { status: "known" as const, ...describeLongMemEvalSessionTime(message.source_observation.raw_date) } };
  };
  return Object.assign(project, { accounting });
}
