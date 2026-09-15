import type { DatabaseSync } from "node:sqlite";
import { BoundSourceInterpretationSchema, SourceInterpretationSignalSchema } from "@do-soul/alaya-protocol";
import { fieldContractSha256, verifySourceObservationPublication } from "@do-soul/alaya-core";
import { parseStoredCandidateMemorySignal, sourceRecordFromRow, type FieldSourceRecordRow } from "@do-soul/alaya-storage";
import { buildOfficialApiSourceCorpus } from "@do-soul/alaya-soul";
import { buildLongMemEvalRoundMessages, pairSessionIntoRounds, type LongMemEvalQuestion } from "../../../datasets/longmemeval/ingestion/dataset.js";
import { requireLongMemEvalTimestamp } from "../../../datasets/longmemeval/ingestion/source-time.js";
import { buildLongMemEvalRoundEvidenceRef, resolveLongMemEvalSeedRoundIdentity } from "../../../datasets/longmemeval/runner/question/runner-question-seeding.js";
import type { LongMemEvalSnapshotQuestion } from "../materialize.js";

/** Called inside the snapshot consumer's read transaction; never publishes or repairs rows. */
export function readSourceObservationProof(db: DatabaseSync, evidenceId: string,
  question: LongMemEvalSnapshotQuestion, source: LongMemEvalQuestion) {
  const evidence = db.prepare("SELECT gist, event_anchor, workspace_id, run_id, surface_id, source_hash, excerpt FROM evidence_capsules WHERE object_id = ?")
    .get(evidenceId);
  if (evidence === undefined) return null;
  let gist: unknown;
  try { gist = JSON.parse(String(evidence.gist)); } catch { return null; }
  if (typeof gist !== "object" || gist === null ||
      (!("source_target" in gist) && (!("contract" in gist) || gist.contract !== "source-interpretation-v1"))) return null;
  const bound = BoundSourceInterpretationSchema.parse(gist);
  const anchor = JSON.parse(String(evidence.event_anchor));
  const event = db.prepare("SELECT entity_id, entity_type, event_type, workspace_id, run_id FROM event_log WHERE event_id = ?")
    .get(anchor?.event_id);
  if (event === undefined || event.entity_type !== "candidate_memory_signal" ||
      event.event_type !== "soul.signal.emitted" || event.workspace_id !== question.workspaceId ||
      event.run_id !== question.runId) throw new Error("snapshot source observation event mismatch");
  const signal = SourceInterpretationSignalSchema.parse(readSnapshotSignal(db, String(event.entity_id)));
  if (signal.signal_state !== "materialized" || signal.source !== "garden_compile" ||
      signal.workspace_id !== question.workspaceId || signal.run_id !== question.runId ||
      evidence.workspace_id !== question.workspaceId || evidence.run_id !== question.runId) {
    throw new Error("snapshot source observation signal mismatch");
  }
  const rows = db.prepare("SELECT * FROM source_records WHERE workspace_id = ?")
    .all(question.workspaceId) as unknown as readonly FieldSourceRecordRow[];
  const stored = rows.map((row) => ({ record: sourceRecordFromRow(row), content_bytes: row.source_body }));
  const verified = verifySourceObservationPublication({ signal, bound, sha256: fieldContractSha256,
    stores: {
      listRecords: () => stored.map((row) => row.record),
      getStoredRecord: (_workspace, id) => {
        const row = stored.find((entry) => entry.record.identity === id);
        return row?.content_bytes == null ? null : { record: row.record, content_bytes: row.content_bytes };
      }
    }
  });
  if (verified.identity.evidenceObjectId !== evidenceId || evidence.source_hash !== bound.source_target.content_digest ||
      evidence.excerpt !== bound.assertion_binding.text) throw new Error("snapshot source observation evidence mismatch");
  const observation = signal.source_observation;
  const round = resolveLongMemEvalSeedRoundIdentity(observation?.source_event_id, source);
  const session = source.haystack_sessions[round.sessionIndex]!;
  const content = pairSessionIntoRounds(session)[round.roundIndex]!;
  const ref = buildLongMemEvalRoundEvidenceRef(source.question_id, round.sessionIndex, round.roundIndex);
  const corpus = buildOfficialApiSourceCorpus(content.content.trim(), buildLongMemEvalRoundMessages(session, content, ref));
  const observedAt = requireLongMemEvalTimestamp(source.haystack_dates[round.sessionIndex]);
  const ordinal = source.haystack_sessions.slice(0, round.sessionIndex)
    .reduce((count, earlier) => count + pairSessionIntoRounds(earlier).length, 0) + round.roundIndex;
  if (verified.stored.content_bytes !== corpus || verified.stored.record.event_time !== observedAt ||
      observation?.observed_at !== observedAt || observation.authority !== "trusted_host_event" ||
      verified.stored.record.source_id !== `compile-seed:${question.workspaceId}:${question.runId}:${ordinal}` ||
      signal.surface_id !== round.sessionId || evidence.surface_id !== round.sessionId) {
    throw new Error("snapshot source observation canonical round mismatch");
  }
  return { round, signal, identity: verified.identity };
}

export function readSnapshotSignal(db: DatabaseSync, signalId: string) {
  const row = db.prepare("SELECT * FROM signals WHERE signal_id = ?").get(signalId);
  if (row === undefined) return null;
  const signal = parseStoredCandidateMemorySignal({ ...row, interpretation_contract: row.interpretation_contract ?? null });
  return signal.signal_state === "materialized" ? signal : null;
}
