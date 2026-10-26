import { createHash } from "node:crypto";
import { buildOfficialApiSourceCorpus } from "@do-soul/alaya-soul";
import { buildLongMemEvalRoundMessages, pairSessionIntoRounds,
  type LongMemEvalQuestion } from "../../datasets/longmemeval/ingestion/dataset.js";
import type { LongMemEvalSourceCensusRecord } from "../snapshot/source-records/census.js";
import { sourceEvidencePreservationQuoteOccurrences } from "../source-evidence-preservation/original.js";
import { SourceGoldUnitSchema, type SourceGoldUnit } from "../measurement/source-gold-join.js";
import type { QuestionPublicationSchema } from "./execute.js";
import type { z } from "zod";

export type AnswerTurnSpan = Readonly<{
  session_index: number; message_index: number; source_id: string;
  target: SourceGoldUnit; start: number; end: number;
}>;
export type AnswerTurnGold = Readonly<{
  unit: "published_body_utf8_bytes";
  annotated_turns: number;
  spans: readonly AnswerTurnSpan[];
  complete: boolean;
}>;

export interface SnapshotSourceRecordRow {
  readonly record_id: string;
  readonly source_id: string;
  readonly source_version: string;
  readonly content_digest: string;
  readonly source_body: string;
  readonly recorded_at?: string;
}

/** Evaluator-only: reconstructs published census and publication structures directly from
 * snapshot source_records and joins with question answer turns using official API corpus rules. */
export function joinSnapshotAnswerSpans(
  question: LongMemEvalQuestion,
  workspaceId: string,
  rows: readonly SnapshotSourceRecordRow[]
): AnswerTurnGold {
  const records: LongMemEvalSourceCensusRecord[] = [];
  const publicationSources: z.infer<typeof QuestionPublicationSchema>["sources"] = [];
  for (const row of rows) {
    const match = row.source_id.match(/-s(\d+)-r(\d+)$/u);
    if (!match) continue;
    const sessionIndex = parseInt(match[1]!, 10);
    const roundIndex = parseInt(match[2]!, 10);
    const sessionId = question.haystack_session_ids[sessionIndex];
    if (sessionId === undefined) continue;
    const corpusDigest = createHash("sha256").update(row.source_body, "utf8").digest("hex");
    records.push({
      population: "longmemeval_s",
      question_id: question.question_id,
      session_id: sessionId,
      session_index: sessionIndex,
      round_index: roundIndex,
      source_id: row.source_id,
      source_version: row.source_version,
      content_bytes: row.source_body,
      content_digest: row.content_digest,
      corpus_digest: corpusDigest,
      source_observed_at: row.recorded_at ?? "1970-01-01T00:00:00.000Z",
      roles: [],
      units: [],
      repeated_assertion_text: false
    });
    publicationSources.push({
      question_id: question.question_id,
      session_id: sessionId,
      source_id: row.source_id,
      source_version: row.source_version,
      content_digest: row.content_digest,
      corpus_digest: corpusDigest,
      admission: "admitted",
      record_id: row.record_id
    });
  }
  const publication = {
    workspace_id: workspaceId,
    run_id: "snapshot",
    recorded_at: "snapshot",
    snapshot_path: "snapshot",
    db_sha256: "snapshot",
    census_count: rows.length,
    admitted_count: rows.length,
    published_count: 0,
    sources: publicationSources
  };
  return joinLongMemEvalAnswerSpans(question, publication, records);
}

/** Evaluator-only: the dataset SHA freezes has_answer, not an answer substring or a full support set.
 * Reuse the census round identity and SOUL's actual canonical corpus (trim/newline normalization).
 * A turn is exposed only when its entire nonempty canonical body is delivered, excluding role labels. */
export function joinLongMemEvalAnswerSpans(question: LongMemEvalQuestion,
  publication: z.infer<typeof QuestionPublicationSchema>, records: readonly LongMemEvalSourceCensusRecord[]): AnswerTurnGold {
  let annotated = 0;
  const spans: AnswerTurnSpan[] = [];
  for (const [sessionIndex, session] of question.haystack_sessions.entries()) {
    for (const [roundIndex, round] of pairSessionIntoRounds(session).entries()) {
      const answerIndices = round.messageIndices.filter(index => session[index]?.has_answer === true);
      annotated += answerIndices.length;
      if (answerIndices.length === 0) continue;
      const candidates = records.filter(record => record.question_id === question.question_id
        && record.session_index === sessionIndex && record.round_index === roundIndex
        && record.session_id === question.haystack_session_ids[sessionIndex]);
      if (candidates.length !== 1) continue;
      const record = candidates[0]!;
      const published = publication.sources.filter(source => source.source_id === record.source_id
        && source.session_id === record.session_id && source.source_version === record.source_version
        && source.content_digest === record.content_digest && source.corpus_digest === record.corpus_digest
        && source.admission === "admitted" && source.record_id !== undefined);
      if (published.length !== 1) continue;
      const messages = buildLongMemEvalRoundMessages(session, round, "evaluator");
      if (buildOfficialApiSourceCorpus(round.content.trim(), messages) !== record.content_bytes) continue;
      const target = SourceGoldUnitSchema.parse({ workspace_id: publication.workspace_id, root_kind: "source_record",
        root_id: published[0]!.record_id, source_version: record.source_version, content_digest: record.content_digest });
      for (const messageIndex of answerIndices) {
        const message = messages[round.messageIndices.indexOf(messageIndex)]!;
        const block = buildOfficialApiSourceCorpus("", [message]);
        const labelBytes = Buffer.byteLength(buildOfficialApiSourceCorpus("", [{ ...message, content: "" }]), "utf8");
        const occurrences = sourceEvidencePreservationQuoteOccurrences(record.content_bytes, block, 0);
        // Repeated/embedded text is not a license to guess which turn was published.
        if (occurrences.length !== 1 || Buffer.byteLength(block, "utf8") <= labelBytes) continue;
        const occurrence = occurrences[0]!;
        spans.push({ session_index: sessionIndex, message_index: messageIndex, source_id: record.source_id,
          target, start: occurrence.start + labelBytes, end: occurrence.end });
      }
    }
  }
  return { unit: "published_body_utf8_bytes", annotated_turns: annotated, spans,
    complete: annotated > 0 && spans.length === annotated };
}
