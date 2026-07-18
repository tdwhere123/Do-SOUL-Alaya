import {
  pairSessionIntoRounds,
  type LongMemEvalQuestion
} from "../ingestion/dataset.js";

export interface TurnContentKeySpace {
  readonly turnOccurrences: number;
  readonly distinctTurnContents: readonly string[];
}

export function inspectTurnContentKeySpace(
  questions: readonly LongMemEvalQuestion[]
): TurnContentKeySpace {
  let turnOccurrences = 0;
  const seen = new Set<string>();
  for (const question of questions) {
    for (const session of question.haystack_sessions) {
      for (const round of pairSessionIntoRounds(session)) {
        const normalized = round.content.trim();
        if (normalized.length === 0) continue;
        turnOccurrences += 1;
        seen.add(normalized);
      }
    }
  }
  return Object.freeze({
    turnOccurrences,
    distinctTurnContents: Object.freeze([...seen])
  });
}

export function collectDistinctTurnContents(
  questions: readonly LongMemEvalQuestion[]
): readonly string[] {
  return inspectTurnContentKeySpace(questions).distinctTurnContents;
}
