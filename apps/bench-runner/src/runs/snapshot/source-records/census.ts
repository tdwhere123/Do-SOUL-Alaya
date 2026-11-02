import { fieldContractSha256, retainedSourceSpeaker } from "@do-soul/alaya-core";
import {
  AlayaError, hashContentDigest, hostSessionContainerKey, hostSessionRoundSource, pairHostSessionRounds,
  type HostSessionCaptureRequest, type HostStructureDescriptor, type UtteranceAttribution
} from "@do-soul/alaya-protocol";
import { collectSourceSemanticUnitPacks } from "@do-soul/alaya-soul";
import type { HostSessionIssuer } from "../../../../../core-daemon/src/garden/host-session/host-session-capture.js";
import { loadDatasetWindowWithIdentity } from "../../../datasets/longmemeval/ingestion/fetch.js";
import type { LongMemEvalQuestion } from "../../../datasets/longmemeval/ingestion/dataset.js";
import {
  createLongMemEvalHostSessionIssuer, createUnverifiedLongMemEvalHostSessionIssuer, longMemEvalHostSessionRequests
} from "../../../datasets/longmemeval/ingestion/host-session-import.js";
import { requireLongMemEvalTimestamp } from "../../../datasets/longmemeval/ingestion/source-time.js";
import { readVerifiedNativeSourceSnapshot } from "./native.js";

export type SourceCensusUnit = Readonly<{
  assertion_id: number;
  text: string;
  source_role: "user" | "assistant";
}>;

export type SourceCensusRecord = Readonly<{
  population: string;
  question_id?: string;
  session_id?: string;
  session_index?: number;
  round_index?: number;
  native_record_id?: string;
  recorded_at?: string;
  title?: string;
  source_id: string;
  source_version: string;
  content_bytes: string;
  content_digest: string;
  corpus_digest: string;
  source_observed_at: string | null;
  roles: readonly ("user" | "assistant")[];
  speaker?: "user" | "assistant" | "system";
  source_role?: SourceCensusUnit["source_role"];
  attribution_context?: UtteranceAttribution;
  host_structure?: HostStructureDescriptor;
  units: readonly SourceCensusUnit[];
  repeated_assertion_text: boolean;
}>;

export type SourceCensus = Readonly<{
  population: string;
  dataset_sha256: string;
  records: readonly SourceCensusRecord[];
  /** The capture requests that admit the round roots, under the issuer the dataset's pin allows. */
  host_sessions?: Readonly<{ issuer: HostSessionIssuer; requests: readonly HostSessionCaptureRequest[] }>;
}>;
export type LongMemEvalSourceCensusRecord = SourceCensusRecord & { source_observed_at: string } & Required<Pick<SourceCensusRecord,
  "question_id" | "session_id" | "session_index" | "round_index">>;
export type LongMemEvalSourceCensus = Readonly<{ population: string; dataset_sha256: string;
  records: readonly LongMemEvalSourceCensusRecord[]; host_sessions: NonNullable<SourceCensus["host_sessions"]> }>;

/** Native origin is read from its complete sealed SQLite inventory, never from supplied census rows. */
export function censusNativeSourceRecords(input: Readonly<{ population: string; snapshotPath: string }>): SourceCensus {
  const native = readVerifiedNativeSourceSnapshot(input.snapshotPath);
  const records = native.records.map(row => {
    const packs = collectSourceSemanticUnitPacks(row.content_bytes, "complete-source", row.source_role);
    if (packs.length !== 1 || packs[0] === undefined) {
      throw new AlayaError("CONFLICT", "native complete source has no single host preparation");
    }
    const units = Object.freeze(packs[0].source_assertions.map(unit => Object.freeze({
      assertion_id: unit.assertion_id, text: unit.text, source_role: unit.source_role
    })));
    return Object.freeze({
      population: input.population, native_record_id: row.record.identity, title: row.title,
      source_id: row.source_id, source_version: row.source_version,
      content_bytes: row.content_bytes, content_digest: row.record.content_digest,
      corpus_digest: fieldContractSha256(row.content_bytes),
      source_observed_at: row.source_observed_at, recorded_at: row.recorded_at,
      ...(row.record.speaker == null ? {} : { speaker: row.record.speaker }),
      ...(row.source_role === undefined ? {} : { source_role: row.source_role }),
      ...(row.record.attribution_context == null ? {} : { attribution_context: row.record.attribution_context }),
      ...(row.record.host_structure === undefined ? {} : { host_structure: row.record.host_structure }),
      roles: Object.freeze([]) as readonly ("user" | "assistant")[], units,
      repeated_assertion_text: hasRepeatedAssertionText(units)
    });
  });
  return Object.freeze({ population: input.population, dataset_sha256: native.manifest.identity,
    records: Object.freeze(records) });
}

/** Frozen dataset membership, independent of extraction cache filenames. Round roots are the host-session
 * owner's: one container per haystack session, its rounds and canonical bodies, admitted by these capture
 * requests. Only a verified dataset pin issues them with dataset authority. */
export async function censusCompleteSourceRecords(input: Readonly<{
  population: string;
  dataDir: string;
  pinnedMetaRoot: string;
  questionWindow?: Readonly<{ offset: number; limit: number }>;
}>): Promise<LongMemEvalSourceCensus> {
  const loaded = await loadDatasetWindowWithIdentity("longmemeval_s", {
    dataDir: input.dataDir, pinnedMetaRoot: input.pinnedMetaRoot, offset: input.questionWindow?.offset ?? 0,
    ...(input.questionWindow === undefined ? {} : { limit: input.questionWindow.limit })
  });
  const sessions = loaded.questions.map(question => ({ question, sessions: longMemEvalHostSessionRequests(question) }));
  const records = sessions.flatMap(row => collectQuestionRoundRecords(input.population, row.question, row.sessions));
  // Session labels may recur; uniqueness follows the container identity published for each session.
  if (new Set(records.map(record => record.source_id)).size !== records.length) {
    throw new AlayaError("CONFLICT", "duplicate logical source occurrence");
  }
  return Object.freeze({
    population: input.population,
    dataset_sha256: loaded.sha256,
    records: Object.freeze(records),
    host_sessions: Object.freeze({
      issuer: loaded.promotionAuthority === null ? createUnverifiedLongMemEvalHostSessionIssuer(loaded.sha256)
        : createLongMemEvalHostSessionIssuer(loaded),
      requests: Object.freeze(sessions.flatMap(row => row.sessions.flatMap(session => session.requests))) })
  });
}

function collectQuestionRoundRecords(population: string, question: LongMemEvalQuestion,
  sessions: ReturnType<typeof longMemEvalHostSessionRequests>): LongMemEvalSourceCensusRecord[] {
  return sessions.flatMap(({ sessionIndex, requests }) => {
    const sessionId = question.haystack_session_ids[sessionIndex];
    if (sessionId === undefined || sessionId.length === 0) throw new AlayaError("CONFLICT", "source session identity is missing");
    const sourceObservedAt = requireLongMemEvalTimestamp(question.haystack_dates[sessionIndex]);
    const container = requests[0]!.container;
    const key = hostSessionContainerKey(container, fieldContractSha256);
    const messages = requests.flatMap(request => request.messages);
    return pairHostSessionRounds(messages, true).rounds.map((indices, roundIndex) => {
      const members = indices.map(index => messages[index]!);
      const source = hostSessionRoundSource(container, key, roundIndex, members);
      if (source.event_time !== sourceObservedAt) throw new AlayaError("CONFLICT", "round host time differs from its session date");
      const pack = collectSourceSemanticUnitPacks(source.content, "complete-source")[0];
      if (pack === undefined) throw new AlayaError("INTERNAL", "complete-source packing produced no source unit");
      const roles = Object.freeze(members.map(message => message.role));
      const units = Object.freeze(pack.source_assertions.map((row) => Object.freeze({
        assertion_id: row.assertion_id, text: row.text, source_role: row.source_role
      })));
      const speaker = retainedSourceSpeaker(roles);
      return Object.freeze({
        population, question_id: question.question_id, session_id: sessionId,
        session_index: sessionIndex, round_index: roundIndex,
        source_id: source.source_id, source_version: source.source_version, content_bytes: source.content,
        content_digest: hashContentDigest(source.content, fieldContractSha256),
        corpus_digest: fieldContractSha256(source.content),
        source_observed_at: sourceObservedAt, roles, units,
        repeated_assertion_text: hasRepeatedAssertionText(units),
        ...(speaker === undefined ? {} : { speaker })
      });
    });
  });
}

function hasRepeatedAssertionText(units: readonly SourceCensusUnit[]): boolean {
  const seen = new Set<string>();
  for (const unit of units) {
    if (seen.has(unit.text)) return true;
    seen.add(unit.text);
  }
  return false;
}
