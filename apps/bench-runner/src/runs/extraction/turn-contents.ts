import type { ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import { createHash } from "node:crypto";
import {
  collectOfficialApiExtractionCoverage,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  buildLongMemEvalRoundMessages,
  pairSessionIntoRounds,
  type LongMemEvalRoundMessage,
  type LongMemEvalQuestion
} from "../../datasets/longmemeval/ingestion/dataset.js";

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
  readonly occurrenceExtractionTurns?: readonly LongMemEvalExtractionTurn[];
}

export function inspectTurnContentKeySpace(
  questions: readonly LongMemEvalQuestion[],
  sourcePacking?: ExtractionSourcePacking
): TurnContentKeySpace {
  let turnOccurrences = 0;
  let distinctExtractionRequestCount = 0;
  const distinct = new Map<string, LongMemEvalExtractionTurn>();
  const occurrences: LongMemEvalExtractionTurn[] = [];
  const coverageMemo = new Map<string, CachedTurnCoverage>();
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
        const coverage = coverageForTurn(normalized, turnMessages, sourcePacking, coverageMemo);
        turnOccurrences += 1;
        const occurrence = Object.freeze({ turnContent: normalized, turnMessages });
        occurrences.push(occurrence);
        if (distinct.has(coverage.identity)) continue;
        distinctExtractionRequestCount += coverage.requests.length;
        distinct.set(coverage.identity, occurrence);
      }
    }
  }
  const distinctExtractionTurns = Object.freeze([...distinct.values()]);
  return Object.freeze({
    turnOccurrences,
    distinctExtractionRequestCount,
    distinctTurnContents: Object.freeze(distinctExtractionTurns.map((turn) => turn.turnContent)),
    distinctExtractionTurns,
    occurrenceExtractionTurns: Object.freeze(occurrences)
  });
}

export function collectDistinctTurnContents(
  questions: readonly LongMemEvalQuestion[],
  sourcePacking?: ExtractionSourcePacking
): readonly string[] {
  return inspectTurnContentKeySpace(questions, sourcePacking).distinctTurnContents;
}

/** Request bytes ignore occurrence message ids; cache them per role/content round. */
export function extractionRequestCoverageMemoKey(
  turnContent: string,
  messages: readonly { readonly role: string; readonly content: string }[],
  sourcePacking?: ExtractionSourcePacking
): string {
  return JSON.stringify({
    content: turnContent,
    packing: sourcePacking ?? null,
    messages: messages.map(({ role, content }) => ({ role, content }))
  });
}

interface CachedTurnCoverage {
  readonly requests: ReturnType<typeof collectOfficialApiExtractionCoverage>["requests"];
  readonly identity: string;
}

function coverageForTurn(
  turnContent: string,
  turnMessages: readonly LongMemEvalRoundMessage[],
  sourcePacking: ExtractionSourcePacking | undefined,
  memo: Map<string, CachedTurnCoverage>
): CachedTurnCoverage {
  const memoKey = extractionRequestCoverageMemoKey(turnContent, turnMessages, sourcePacking);
  const cached = memo.get(memoKey);
  if (cached !== undefined) return cached;
  const requests = collectOfficialApiExtractionCoverage(turnContent, turnMessages, sourcePacking).requests;
  const coverage = Object.freeze({
    requests,
    identity: JSON.stringify(requests.map(stringifyOfficialApiExtractionRequest))
  });
  memo.set(memoKey, coverage);
  return coverage;
}
