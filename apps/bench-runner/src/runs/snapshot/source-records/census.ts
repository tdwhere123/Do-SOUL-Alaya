import { fieldContractSha256, retainedSourceSpeaker } from "@do-soul/alaya-core";
import { AlayaError, hashContentDigest } from "@do-soul/alaya-protocol";
import {
  buildOfficialApiSourceCorpus, collectSourceSemanticUnitPacks
} from "@do-soul/alaya-soul";
import { loadDatasetWindowWithIdentity } from "../../../datasets/longmemeval/ingestion/fetch.js";
import {
  buildLongMemEvalRoundMessages, pairSessionIntoRounds, type LongMemEvalQuestion
} from "../../../datasets/longmemeval/ingestion/dataset.js";
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
  source_observed_at: string;
  roles: readonly ("user" | "assistant")[];
  speaker?: "user" | "assistant" | "system";
  units: readonly SourceCensusUnit[];
  repeated_assertion_text: boolean;
}>;

export type SourceCensus = Readonly<{
  population: string;
  dataset_sha256: string;
  records: readonly SourceCensusRecord[];
}>;
export type LongMemEvalSourceCensusRecord = SourceCensusRecord & Required<Pick<SourceCensusRecord,
  "question_id" | "session_id" | "session_index" | "round_index">>;
export type LongMemEvalSourceCensus = Readonly<{ population: string; dataset_sha256: string;
  records: readonly LongMemEvalSourceCensusRecord[] }>;

/** Native origin is read from its complete sealed SQLite inventory, never from supplied census rows. */
export function censusNativeSourceRecords(input: Readonly<{ population: string; snapshotPath: string }>): SourceCensus {
  const native = readVerifiedNativeSourceSnapshot(input.snapshotPath);
  const records = native.records.map(row => {
    const packs = collectSourceSemanticUnitPacks(row.content_bytes, "complete-source");
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
      roles: Object.freeze([]) as readonly ("user" | "assistant")[], units,
      repeated_assertion_text: hasRepeatedAssertionText(units)
    });
  });
  return Object.freeze({ population: input.population, dataset_sha256: native.manifest.identity,
    records: Object.freeze(records) });
}

/** Frozen dataset membership, independent of extraction cache filenames. */
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
  return Object.freeze({
    population: input.population,
    dataset_sha256: loaded.sha256,
    records: Object.freeze(collectCompleteSourceRecords(input.population, loaded.sha256, loaded.questions))
  });
}

function collectCompleteSourceRecords(
  population: string,
  sourceVersion: string,
  questions: readonly LongMemEvalQuestion[]
): readonly LongMemEvalSourceCensusRecord[] {
  const seen = new Set<string>();
  const records: LongMemEvalSourceCensusRecord[] = [];
  for (const question of questions) {
    for (const [sessionIndex, rawSession] of question.haystack_sessions.entries()) {
      const session = rawSession.map(({ role, content }) => ({ role, content }));
      const sessionId = question.haystack_session_ids[sessionIndex];
      if (sessionId === undefined || sessionId.length === 0) throw new AlayaError("CONFLICT", "source session identity is missing");
      const sourceObservedAt = requireLongMemEvalTimestamp(question.haystack_dates[sessionIndex]);
      for (const [roundIndex, round] of pairSessionIntoRounds(session).entries()) {
        if (round.content.trim().length === 0) continue;
        const turnMessages = buildLongMemEvalRoundMessages(
          session, round, `${question.question_id}-s${sessionIndex}-r${roundIndex}`
        );
        const contentBytes = buildOfficialApiSourceCorpus(round.content.trim(), turnMessages);
        const packs = collectSourceSemanticUnitPacks(contentBytes, "complete-source");
        const sourceId = `${population}:${question.question_id}-s${sessionIndex}-r${roundIndex}`;
        // Session labels may recur; uniqueness follows the identity published for this occurrence.
        if (seen.has(sourceId)) throw new AlayaError("CONFLICT", "duplicate logical source occurrence");
        seen.add(sourceId);
        const pack = packs[0];
        if (pack === undefined) throw new AlayaError("INTERNAL", "complete-source packing produced no source unit");
        const roles = Object.freeze(turnMessages.map((message) => message.role));
        const units = Object.freeze(pack.source_assertions.map((row) => Object.freeze({
          assertion_id: row.assertion_id, text: row.text, source_role: row.source_role
        })));
        const speaker = retainedSourceSpeaker(roles);
        records.push(Object.freeze({
          population, question_id: question.question_id, session_id: sessionId,
          session_index: sessionIndex, round_index: roundIndex,
          source_id: sourceId,
          source_version: sourceVersion, content_bytes: contentBytes,
          content_digest: hashContentDigest(contentBytes, fieldContractSha256),
          corpus_digest: fieldContractSha256(contentBytes),
          source_observed_at: sourceObservedAt, roles, units,
          repeated_assertion_text: hasRepeatedAssertionText(units),
          ...(speaker === undefined ? {} : { speaker })
        }));
      }
    }
  }
  return records;
}

function hasRepeatedAssertionText(units: readonly SourceCensusUnit[]): boolean {
  const seen = new Set<string>();
  for (const unit of units) {
    if (seen.has(unit.text)) return true;
    seen.add(unit.text);
  }
  return false;
}
