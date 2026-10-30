import { assertLongMemEvalTimeline } from "../../datasets/longmemeval/ingestion/source-time.js";
import type { ConversationMessage, ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import { createHash } from "node:crypto";
import {
  collectOfficialApiExtractionCoverage, collectSourceSemanticUnitPacks, buildOfficialApiSourceCorpus,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  buildLongMemEvalRoundMessages, buildLongMemEvalSessionMessages,
  pairSessionIntoRounds,
  type LongMemEvalRoundMessage,
  type LongMemEvalQuestion
} from "../../datasets/longmemeval/ingestion/dataset.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, sourceSemanticArtifactPreparations } from "./request-artifact.js";
import { sourceStatementRequests, sourceStatementSession } from "./source-statement-request.js";

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
  readonly unsupportedSourceOccurrences: number;
  readonly distinctExtractionRequestCount: number;
  readonly distinctTurnContents: readonly string[];
  readonly distinctExtractionTurns: readonly LongMemEvalExtractionTurn[];
  readonly occurrenceExtractionTurns?: readonly LongMemEvalExtractionTurn[];
}

export function inspectTurnContentKeySpace(
  questions: readonly LongMemEvalQuestion[],
  sourcePacking?: ExtractionSourcePacking,
  openSemantics = false
): TurnContentKeySpace {
  let turnOccurrences = 0;
  let unsupportedSourceOccurrences = 0;
  let distinctExtractionRequestCount = 0;
  const distinct = new Map<string, LongMemEvalExtractionTurn>();
  const occurrences: LongMemEvalExtractionTurn[] = [];
  const coverageMemo = new Map<string, CachedTurnCoverage>();
  for (const question of questions) {
    if (!openSemantics && (sourcePacking === undefined || sourcePacking === "session-statements")) assertLongMemEvalTimeline(question);
    for (const [sessionIndex, session] of question.haystack_sessions.entries()) {
      if (!openSemantics && (sourcePacking === undefined || sourcePacking === "session-statements")) {
        const turnMessages = buildLongMemEvalSessionMessages(session, question.haystack_dates[sessionIndex]);
        if (turnMessages.length === 0) continue;
        const occurrence = Object.freeze({ turnContent: pairSessionIntoRounds(session).map(round => round.content).join("\n"), turnMessages });
        const source = sourceStatementSession(turnMessages);
        const requests = sourceStatementRequests(turnMessages);
        turnOccurrences++;
        occurrences.push(occurrence);
        unsupportedSourceOccurrences += source.messages.length - requests.reduce((sum, request) => sum + request.source.messages.length, 0);
        if (!distinct.has(source.sessionId)) {
          distinctExtractionRequestCount += requests.length;
          distinct.set(source.sessionId, occurrence);
        }
        continue;
      }
      // Historical semantic-generation inventory retains its original round boundaries.
      for (const [roundIndex, round] of pairSessionIntoRounds(session).entries()) {
        const normalized = round.content.trim();
        if (normalized.length === 0) continue;
        const turnMessages = buildLongMemEvalRoundMessages(
          session,
          round,
          `${question.question_id}-fill-s${sessionIndex}-r${roundIndex}`
        );
        const coverage = coverageForTurn(normalized, turnMessages, sourcePacking, coverageMemo, openSemantics);
        turnOccurrences += 1;
        unsupportedSourceOccurrences += coverage.unsupportedSourceCount;
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
    unsupportedSourceOccurrences,
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

/** Current requests consume captured message authority; retained assertion requests consume role/body only. */
export function extractionRequestCoverageMemoKey(
  turnContent: string,
  messages: readonly ConversationMessage[],
  sourcePacking?: ExtractionSourcePacking
): string {
  if (sourcePacking === undefined || sourcePacking === "session-statements") {
    return sourceStatementSession(messages).sessionId;
  }
  return JSON.stringify({
    content: turnContent,
    packing: sourcePacking ?? null,
    messages: messages.map(({ role, content }) => ({ role, content }))
  });
}

interface CachedTurnCoverage {
  readonly requests: readonly unknown[];
  readonly identity: string;
  readonly unsupportedSourceCount: number;
}

function coverageForTurn(
  turnContent: string,
  turnMessages: readonly LongMemEvalRoundMessage[],
  sourcePacking: ExtractionSourcePacking | undefined,
  memo: Map<string, CachedTurnCoverage>,
  openSemantics: boolean
): CachedTurnCoverage {
  const memoKey = extractionRequestCoverageMemoKey(turnContent, turnMessages, sourcePacking);
  const cached = memo.get(memoKey);
  if (cached !== undefined) return cached;
  const coverage = openSemantics
    ? (() => {
      const packs = collectSourceSemanticUnitPacks(buildOfficialApiSourceCorpus(turnContent, turnMessages), sourcePacking);
      const prepared = sourceSemanticArtifactPreparations(buildOfficialApiSourceCorpus(turnContent, turnMessages),
        sourcePacking, EXTRACTION_OPEN_SEMANTICS_GENERATION);
      return Object.freeze({ requests: prepared.filter((row) => row.status === "ready"),
        unsupportedSourceCount: prepared.filter((row) => row.status === "unsupported_source").length,
        identity: JSON.stringify(packs) });
    })()
    : (() => {
      const requests = collectOfficialApiExtractionCoverage(turnContent, turnMessages, sourcePacking).requests;
      return Object.freeze({ requests, unsupportedSourceCount: 0,
        identity: JSON.stringify(requests.map(stringifyOfficialApiExtractionRequest)) });
    })();
  memo.set(memoKey, coverage);
  return coverage;
}
