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
