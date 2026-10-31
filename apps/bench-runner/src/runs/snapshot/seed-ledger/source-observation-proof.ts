import type { DatabaseSync } from "node:sqlite";
import { AlayaError, BoundSourceStatementSchema, SourceStatementSignalSchema, canonicalJson } from "@do-soul/alaya-protocol";
import { fieldContractSha256, newerSourceRecord, verifySourceObservationPublication } from "@do-soul/alaya-core";
import { parseStoredCandidateMemorySignal, sourceRecordFromRow, type FieldSourceRecordRow } from "@do-soul/alaya-storage";
import { buildOfficialApiSourceCorpus, sourceStatementSessionInput } from "@do-soul/alaya-soul";
import { buildLongMemEvalSessionMessages, pairSessionIntoRounds, type LongMemEvalQuestion } from "../../../datasets/longmemeval/ingestion/dataset.js";
import { requireLongMemEvalTimestamp } from "../../../datasets/longmemeval/ingestion/source-time.js";
import { sourceStatementRequests } from "../../extraction/source-statement-request.js";
import { resolveLongMemEvalSeedRoundIdentity } from "../../../datasets/longmemeval/runner/question/runner-question-seeding.js";
import type { LongMemEvalSnapshotQuestion } from "../materialize.js";
type StatementSnapshotScope = Pick<LongMemEvalSnapshotQuestion, "workspaceId" | "runId" | "seedRounds">;

/** Called inside the snapshot consumer's read transaction; never publishes or repairs rows. */
export function readSourceObservationProof(db: DatabaseSync, evidenceId: string,
  question: StatementSnapshotScope, source: LongMemEvalQuestion) {
  const evidence = db.prepare("SELECT gist, event_anchor, workspace_id, run_id, surface_id, source_hash, excerpt FROM evidence_capsules WHERE object_id = ?")
    .get(evidenceId);
  if (evidence === undefined) return null;
  let gist: unknown;
  try { gist = JSON.parse(String(evidence.gist)); } catch { return null; }
  if (typeof gist !== "object" || gist === null || !("contract" in gist)) return null;
  if (gist.contract === "source-interpretation-v1") throw new AlayaError("CONFLICT", "historical passive observations cannot certify new seed publication");
  if (gist.contract !== "source-statements-v1") return null;
  const bound = BoundSourceStatementSchema.parse(gist);
  const anchor = JSON.parse(String(evidence.event_anchor));
  const event = db.prepare("SELECT entity_id, entity_type, event_type, workspace_id, run_id FROM event_log WHERE event_id = ?")
    .get(anchor?.event_id);
  if (event === undefined || event.entity_type !== "candidate_memory_signal" ||
      event.event_type !== "soul.signal.emitted" || event.workspace_id !== question.workspaceId ||
      event.run_id !== question.runId) throw new AlayaError("CONFLICT", "snapshot source observation event mismatch");
  const signal = SourceStatementSignalSchema.parse(readSnapshotSignal(db, String(event.entity_id)));
  if (signal.signal_state !== "materialized" || signal.source !== "garden_compile" ||
      signal.workspace_id !== question.workspaceId || signal.run_id !== question.runId ||
      evidence.workspace_id !== question.workspaceId || evidence.run_id !== question.runId) {
    throw new AlayaError("CONFLICT", "snapshot source observation signal mismatch");
  }
  const observation = signal.source_observation;
  const round = resolveLongMemEvalSeedRoundIdentity(observation?.source_event_id, source);
  const session = source.haystack_sessions[round.sessionIndex]!;
  const content = pairSessionIntoRounds(session)[round.roundIndex]!;
  const messages = buildLongMemEvalSessionMessages(session, source.haystack_dates[round.sessionIndex]);
  const visibleSources = modelVisibleSourceIds(question, source, round.sessionIndex, messages, bound.message.message_id);
  const rows = db.prepare("SELECT * FROM source_records WHERE workspace_id = ? AND source_id IN (SELECT value FROM json_each(?))")
    .all(question.workspaceId, JSON.stringify(visibleSources)) as unknown as readonly FieldSourceRecordRow[];
  const stored = rows.map((row) => ({ record: sourceRecordFromRow(row), content_bytes: row.source_body }));
  const current = (workspace: string, sourceId: string) => {
    const records = stored.map(row => row.record).filter(record => record.workspace_id === workspace && record.source_id === sourceId);
    return records.length === 0 ? null : records.reduce(newerSourceRecord);
  };
  const expectedContext = visibleSources.filter(id => id !== bound.artifact_key).map(id => {
    const record = current(question.workspaceId, id);
    if (record === null) throw new AlayaError("CONFLICT", "snapshot model-visible raw source is unavailable");
    return { workspace_id: record.workspace_id, root_id: record.identity, source_id: record.source_id,
      source_version: record.source_version, content_digest: record.content_digest };
  });
  if (canonicalJson(expectedContext) !== canonicalJson(bound.source_context)) throw new AlayaError("CONFLICT", "snapshot statement request dependency mismatch");
  const verified = verifySourceObservationPublication({ signal, bound, sha256: fieldContractSha256,
    stores: {
      getHostInventory: (workspace, id) => {
        const row = db.prepare("SELECT canonical_inventory FROM source_host_inventories WHERE workspace_id=? AND record_id=?")
          .get(workspace, id);
        return row === undefined ? null : String(row.canonical_inventory);
      },
      getCurrentRecord: current,
      getStoredRecord: (_workspace, id) => {
        const row = stored.find((entry) => entry.record.identity === id);
        return row?.content_bytes == null ? null : { record: row.record, content_bytes: row.content_bytes };
      }
    }
  });
  if (verified.identity.evidenceObjectId !== evidenceId || evidence.source_hash !== bound.source_target.content_digest ||
      evidence.excerpt !== bound.message.text) throw new AlayaError("CONFLICT", "snapshot source observation evidence mismatch");
  const roundMessages = content.messageIndices.map(index => messages[index]!);
  const corpus = buildOfficialApiSourceCorpus(content.content.trim(), roundMessages);
  const host = sourceStatementSessionInput(roundMessages).messages.find(message => message.message_id === bound.message.message_id);
  if (canonicalJson(host) !== canonicalJson(bound.message)) throw new AlayaError("CONFLICT", "snapshot statement host message mismatch");
  const observedAt = requireLongMemEvalTimestamp(source.haystack_dates[round.sessionIndex]);
  const ordinal = source.haystack_sessions.slice(0, round.sessionIndex)
    .reduce((count, earlier) => count + pairSessionIntoRounds(earlier).length, 0) + round.roundIndex;
  const receipt = question.seedRounds?.[ordinal]?.statementSession?.receipt;
  const receivedMessage = receipt?.messages.find(result => result.message.message_id === bound.message.message_id);
  if (receipt?.session_id !== bound.session_id || receivedMessage === undefined ||
      !receivedMessage.statements.some(statement => canonicalJson(statement) === canonicalJson(bound.statement))) {
    throw new AlayaError("CONFLICT", "snapshot publication is absent from its admitted session receipt");
  }
  if (verified.stored.content_bytes !== corpus || verified.stored.record.event_time !== observedAt ||
      observation?.observed_at !== observedAt || observation.authority !== "trusted_host_event" ||
      verified.stored.record.source_id !== `compile-seed:${question.workspaceId}:${question.runId}:${ordinal}` ||
      signal.surface_id !== evidence.surface_id || signal.surface_id !== null && signal.surface_id !== round.sessionId) {
    throw new AlayaError("CONFLICT", "snapshot source observation canonical round mismatch");
  }
  return { round, signal, identity: verified.identity };
}

function modelVisibleSourceIds(question: StatementSnapshotScope, source: LongMemEvalQuestion, sessionIndex: number,
  messages: ReturnType<typeof buildLongMemEvalSessionMessages>, targetMessageId: string): readonly string[] {
  const request = sourceStatementRequests(messages).find(row => row.source.messages.some(message => message.message_id === targetMessageId))?.source;
  if (request === undefined) throw new AlayaError("CONFLICT", "snapshot statement has no planned session request");
  const visible = new Set([...request.context, ...request.messages].map(message => message.message_id));
  const first = source.haystack_sessions.slice(0, sessionIndex).reduce((count, session) => count + pairSessionIntoRounds(session).length, 0);
  return pairSessionIntoRounds(source.haystack_sessions[sessionIndex]!).flatMap((round, index) =>
    round.messageIndices.some(position => visible.has(messages[position]!.message_id))
      ? [`compile-seed:${question.workspaceId}:${question.runId}:${first + index}`] : []);
}

export function readSnapshotSignal(db: DatabaseSync, signalId: string) {
  const row = db.prepare("SELECT * FROM signals WHERE signal_id = ?").get(signalId);
  if (row === undefined) return null;
  const signal = parseStoredCandidateMemorySignal({ ...row, interpretation_contract: row.interpretation_contract ?? null });
  return signal.signal_state === "materialized" ? signal : null;
}
