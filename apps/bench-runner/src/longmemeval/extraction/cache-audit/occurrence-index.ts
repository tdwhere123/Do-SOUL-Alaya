import { createHash } from "node:crypto";
import {
  buildLongMemEvalRoundMessages,
  pairSessionIntoRounds,
  type LongMemEvalRoundMessage,
  type LongMemEvalQuestion
} from "../../ingestion/dataset.js";
import { computeCacheKey } from "../../compile-seed/compile-seed-cache.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import { requireLongMemEvalTimestamp } from "../../ingestion/source-time.js";
import { computeTrustedRoleCorpusDigest } from "../turn-contents.js";

export interface ExtractionOccurrence {
  readonly id: string;
  readonly evidenceRef: string;
  readonly questionId: string;
  readonly sessionIndex: number;
  readonly roundIndex: number;
  readonly sourceObservedAt: string;
  readonly turnContent: string;
  readonly turnMessages: readonly LongMemEvalRoundMessage[];
  readonly trustedRoleCorpusDigest: string;
  readonly cacheKey: string;
}

export function buildExtractionOccurrenceIndex(input: {
  readonly questions: readonly LongMemEvalQuestion[];
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly systemPrompt: string;
}): readonly ExtractionOccurrence[] {
  const occurrences = input.questions.flatMap((question) =>
    occurrencesForQuestion(question, input.model, input.requestProfile, input.systemPrompt)
  );
  assertUniqueOccurrenceIds(occurrences);
  return Object.freeze(occurrences.sort(compareOccurrences));
}

export function hashExtractionOccurrenceIndex(
  occurrences: readonly ExtractionOccurrence[]
): string {
  const canonical = [...occurrences].sort(compareOccurrences).map((occurrence) => ({
    id: occurrence.id,
    cache_key: occurrence.cacheKey,
    trusted_role_corpus_digest: occurrence.trustedRoleCorpusDigest,
    source_observed_at: occurrence.sourceObservedAt
  }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function occurrencesForQuestion(
  question: LongMemEvalQuestion,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string
): readonly ExtractionOccurrence[] {
  return question.haystack_sessions.flatMap((session, sessionIndex) => {
    const sourceObservedAt = requireLongMemEvalTimestamp(question.haystack_dates[sessionIndex]);
    return pairSessionIntoRounds(session).map((round, roundIndex) => buildOccurrence({
      question, sessionIndex, roundIndex, sourceObservedAt, turnContent: round.content,
      turnMessages: buildLongMemEvalRoundMessages(
        session,
        round,
        `${question.question_id}-s${sessionIndex}-r${roundIndex}`
      ),
      model, requestProfile, systemPrompt
    }));
  });
}

function buildOccurrence(input: {
  readonly question: LongMemEvalQuestion;
  readonly sessionIndex: number;
  readonly roundIndex: number;
  readonly sourceObservedAt: string;
  readonly turnContent: string;
  readonly turnMessages: readonly LongMemEvalRoundMessage[];
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly systemPrompt: string;
}): ExtractionOccurrence {
  const id = `${input.question.question_id}-s${input.sessionIndex}-r${input.roundIndex}`;
  const trustedRoleCorpusDigest = computeTrustedRoleCorpusDigest(input.turnMessages);
  return Object.freeze({
    id,
    evidenceRef: id,
    questionId: input.question.question_id,
    sessionIndex: input.sessionIndex,
    roundIndex: input.roundIndex,
    sourceObservedAt: input.sourceObservedAt,
    turnContent: input.turnContent.trim(),
    turnMessages: input.turnMessages,
    trustedRoleCorpusDigest,
    cacheKey: computeCacheKey(
      input.model,
      input.requestProfile,
      input.systemPrompt,
      input.turnContent.trim(),
      trustedRoleCorpusDigest
    )
  });
}

function assertUniqueOccurrenceIds(occurrences: readonly ExtractionOccurrence[]): void {
  const ids = new Set<string>();
  for (const occurrence of occurrences) {
    if (ids.has(occurrence.id)) {
      throw new Error(`duplicate extraction occurrence id: ${occurrence.id}`);
    }
    ids.add(occurrence.id);
  }
}

function compareOccurrences(left: ExtractionOccurrence, right: ExtractionOccurrence): number {
  return left.id.localeCompare(right.id);
}
