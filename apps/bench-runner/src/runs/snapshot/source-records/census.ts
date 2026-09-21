import { fieldContractSha256, retainedSourceSpeaker } from "@do-soul/alaya-core";
import { hashContentDigest } from "@do-soul/alaya-protocol";
import {
  buildOfficialApiSourceCorpus, collectSourceSemanticUnitPacks
} from "@do-soul/alaya-soul";
import { loadDatasetWindowWithIdentity } from "../../../datasets/longmemeval/ingestion/fetch.js";
import {
  buildLongMemEvalRoundMessages, pairSessionIntoRounds, type LongMemEvalQuestion
} from "../../../datasets/longmemeval/ingestion/dataset.js";
import { requireLongMemEvalTimestamp } from "../../../datasets/longmemeval/ingestion/source-time.js";

export type SourceCensusUnit = Readonly<{
  assertion_id: number;
  text: string;
  source_role: "user" | "assistant";
}>;

export type SourceCensusRecord = Readonly<{
  population: string;
  question_id: string;
  session_id: string;
  session_index: number;
  round_index: number;
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

/** Frozen dataset membership, independent of extraction cache filenames. */
export async function censusCompleteSourceRecords(input: Readonly<{
  population: string;
  dataDir: string;
  pinnedMetaRoot: string;
}>): Promise<SourceCensus> {
  const loaded = await loadDatasetWindowWithIdentity("longmemeval_s", {
    dataDir: input.dataDir, pinnedMetaRoot: input.pinnedMetaRoot, offset: 0
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
): readonly SourceCensusRecord[] {
  const seen = new Set<string>();
  const records: SourceCensusRecord[] = [];
  for (const question of questions) {
    for (const [sessionIndex, rawSession] of question.haystack_sessions.entries()) {
      const session = rawSession.map(({ role, content }) => ({ role, content }));
      const sessionId = question.haystack_session_ids[sessionIndex];
      if (sessionId === undefined || sessionId.length === 0) throw new Error("source session identity is missing");
      const sourceObservedAt = requireLongMemEvalTimestamp(question.haystack_dates[sessionIndex]);
      for (const [roundIndex, round] of pairSessionIntoRounds(session).entries()) {
        if (round.content.trim().length === 0) continue;
        const turnMessages = buildLongMemEvalRoundMessages(
          session, round, `${question.question_id}-s${sessionIndex}-r${roundIndex}`
        );
        const contentBytes = buildOfficialApiSourceCorpus(round.content.trim(), turnMessages);
        const packs = collectSourceSemanticUnitPacks(contentBytes, "complete-source");
        const coverage = JSON.stringify(packs);
        if (seen.has(coverage)) continue;
        seen.add(coverage);
        const pack = packs[0];
        if (pack === undefined) throw new Error("complete-source packing produced no source unit");
        const roles = Object.freeze(turnMessages.map((message) => message.role));
        const units = Object.freeze(pack.source_assertions.map((row) => Object.freeze({
          assertion_id: row.assertion_id, text: row.text, source_role: row.source_role
        })));
        const speaker = retainedSourceSpeaker(roles);
        records.push(Object.freeze({
          population, question_id: question.question_id, session_id: sessionId,
          session_index: sessionIndex, round_index: roundIndex,
          source_id: `${population}:${question.question_id}-s${sessionIndex}-r${roundIndex}`,
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
