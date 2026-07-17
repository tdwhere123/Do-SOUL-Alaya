import { createHash } from "node:crypto";
import {
  pairSessionIntoRounds,
  type LongMemEvalQuestion
} from "../../dataset.js";
import { computeCacheKey } from "../../compile-seed-cache.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed-types.js";
import { requireLongMemEvalTimestamp } from "../../ingestion/source-time.js";

export interface C0ExtractionOccurrence {
  readonly id: string;
  readonly evidenceRef: string;
  readonly questionId: string;
  readonly sessionIndex: number;
  readonly roundIndex: number;
  readonly sourceObservedAt: string;
  readonly turnContent: string;
  readonly cacheKey: string;
}

export function buildC0OccurrenceIndex(input: {
  readonly questions: readonly LongMemEvalQuestion[];
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly systemPrompt: string;
}): readonly C0ExtractionOccurrence[] {
  const occurrences = input.questions.flatMap((question) =>
    occurrencesForQuestion(question, input.model, input.requestProfile, input.systemPrompt)
  );
  assertUniqueOccurrenceIds(occurrences);
  return Object.freeze(occurrences.sort(compareOccurrences));
}

export function hashC0OccurrenceIndex(occurrences: readonly C0ExtractionOccurrence[]): string {
  const canonical = [...occurrences].sort(compareOccurrences).map((occurrence) => ({
    id: occurrence.id,
    cache_key: occurrence.cacheKey,
    source_observed_at: occurrence.sourceObservedAt
  }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function occurrencesForQuestion(
  question: LongMemEvalQuestion,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string
): readonly C0ExtractionOccurrence[] {
  return question.haystack_sessions.flatMap((session, sessionIndex) => {
    const sourceObservedAt = requireLongMemEvalTimestamp(question.haystack_dates[sessionIndex]);
    return pairSessionIntoRounds(session).map((round, roundIndex) => buildOccurrence({
      question, sessionIndex, roundIndex, sourceObservedAt, turnContent: round.content,
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
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly systemPrompt: string;
}): C0ExtractionOccurrence {
  const id = `${input.question.question_id}-s${input.sessionIndex}-r${input.roundIndex}`;
  return Object.freeze({
    id,
    evidenceRef: id,
    questionId: input.question.question_id,
    sessionIndex: input.sessionIndex,
    roundIndex: input.roundIndex,
    sourceObservedAt: input.sourceObservedAt,
    turnContent: input.turnContent.trim(),
    cacheKey: computeCacheKey(input.model, input.requestProfile, input.systemPrompt, input.turnContent.trim())
  });
}

function assertUniqueOccurrenceIds(occurrences: readonly C0ExtractionOccurrence[]): void {
  const ids = new Set<string>();
  for (const occurrence of occurrences) {
    if (ids.has(occurrence.id)) throw new Error(`duplicate C0 occurrence id: ${occurrence.id}`);
    ids.add(occurrence.id);
  }
}

function compareOccurrences(left: C0ExtractionOccurrence, right: C0ExtractionOccurrence): number {
  return left.id.localeCompare(right.id);
}
