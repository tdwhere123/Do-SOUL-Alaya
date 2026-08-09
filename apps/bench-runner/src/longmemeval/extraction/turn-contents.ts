import { createHash } from "node:crypto";
import {
  buildOfficialApiExtractionRequests,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  buildLongMemEvalRoundMessages,
  pairSessionIntoRounds,
  type LongMemEvalRoundMessage,
  type LongMemEvalQuestion
} from "../ingestion/dataset.js";

export interface LongMemEvalExtractionTurn {
  readonly turnContent: string;
  readonly turnMessages: readonly LongMemEvalRoundMessage[];
}

export const TRUSTED_ROLE_CORPUS_IDENTITY_VERSION = 1;

export function computeTrustedRoleCorpusDigest(
  messages: readonly { readonly role: string; readonly content: string }[]
): string {
  const canonical = {
    version: TRUSTED_ROLE_CORPUS_IDENTITY_VERSION,
    messages: messages.map(({ role, content }) => ({ role, content }))
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export interface TurnContentKeySpace {
  readonly turnOccurrences: number;
  readonly distinctExtractionRequestCount: number;
  readonly distinctTurnContents: readonly string[];
  readonly distinctExtractionTurns: readonly LongMemEvalExtractionTurn[];
}

export function inspectTurnContentKeySpace(
  questions: readonly LongMemEvalQuestion[]
): TurnContentKeySpace {
  let turnOccurrences = 0;
  let distinctExtractionRequestCount = 0;
  const distinct = new Map<string, LongMemEvalExtractionTurn>();
  for (const question of questions) {
    for (const [sessionIndex, session] of question.haystack_sessions.entries()) {
      for (const [roundIndex, round] of pairSessionIntoRounds(session).entries()) {
        const normalized = round.content.trim();
        if (normalized.length === 0) continue;
        const turnMessages = buildLongMemEvalRoundMessages(
          session,
          round,
          `${question.question_id}-fill-s${sessionIndex}-r${roundIndex}`
        );
        const requests = buildOfficialApiExtractionRequests(normalized, turnMessages);
        turnOccurrences += 1;
        const identity = JSON.stringify(requests.map(stringifyOfficialApiExtractionRequest));
        if (distinct.has(identity)) continue;
        distinctExtractionRequestCount += requests.length;
        distinct.set(identity, Object.freeze({
          turnContent: normalized,
          turnMessages
        }));
      }
    }
  }
  const distinctExtractionTurns = Object.freeze([...distinct.values()]);
  return Object.freeze({
    turnOccurrences,
    distinctExtractionRequestCount,
    distinctTurnContents: Object.freeze(distinctExtractionTurns.map((turn) => turn.turnContent)),
    distinctExtractionTurns
  });
}

export function collectDistinctTurnContents(
  questions: readonly LongMemEvalQuestion[]
): readonly string[] {
  return inspectTurnContentKeySpace(questions).distinctTurnContents;
}
