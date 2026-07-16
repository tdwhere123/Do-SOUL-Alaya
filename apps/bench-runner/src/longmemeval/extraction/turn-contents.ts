import {
  pairSessionIntoRounds,
  type LongMemEvalQuestion
} from "../dataset.js";

export function collectDistinctTurnContents(
  questions: readonly LongMemEvalQuestion[]
): readonly string[] {
  const seen = new Set<string>();
  for (const question of questions) {
    for (const session of question.haystack_sessions) {
      for (const round of pairSessionIntoRounds(session)) {
        const normalized = round.content.trim();
        if (normalized.length > 0) seen.add(normalized);
      }
    }
  }
  return [...seen];
}
