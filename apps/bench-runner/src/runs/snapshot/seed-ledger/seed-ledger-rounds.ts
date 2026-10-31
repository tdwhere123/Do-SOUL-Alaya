import { AlayaError } from "@do-soul/alaya-protocol";
import { DatabaseSync } from "node:sqlite";
import { collectOfficialApiExtractionCoverage, SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { computeExtractionTurnCacheKeys } from "../../compile-seed/compile-seed-cache.js";
import {
  buildLongMemEvalRoundMessages, buildLongMemEvalSessionMessages,
  pairSessionIntoRounds,
  type LongMemEvalQuestion
} from "../../../datasets/longmemeval/ingestion/dataset.js";
import type {
  LongMemEvalSnapshotQuestion,
  LongMemEvalSnapshotSeedRound
} from "../materialize.js";
import { assertStatementRound } from "./statement-session-proof.js";
import { assertSeedLedgerMaterializationProof } from "./seed-ledger-materialization-proof.js";
import type { SourceAssertionSupplementBinding } from
  "../../extraction/cache/semantic-supplement/source-assertion-supplement.js";
import {
  assertSemanticSupplementRound,
  readRoundSemanticSupplementShards,
  sumExtractionShardCount,
  type SemanticSupplementEntries
} from "./semantic-supplement-binding.js";
import { assertSidecarSourceClosure, assertAnswerDropReasons } from "./seed-ledger-closure.js";
import type { ExtractionContentClosureEntry } from "../../compile-seed/compile-seed-cache.js";
import {
  addClosureEntry,
  addTotals,
  readRoundExtractionShards,
  sha256,
  type CompleteExtraction,
  type LedgerTotals
} from "./seed-ledger-shared.js";

export function assertQuestionLedger(
  db: DatabaseSync,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  extraction: CompleteExtraction,
  totals: LedgerTotals,
  closure: Map<string, ExtractionContentClosureEntry>,
  semanticEntries: SemanticSupplementEntries,
  semanticBinding: SourceAssertionSupplementBinding | undefined,
  systemPrompt: string
): void {
  const ledger = question.seedRounds;
  const expected = canonicalRounds(source);
  if (ledger === undefined || ledger.length !== expected.length) {
    throw new AlayaError("CONFLICT", `snapshot canonical seed round count mismatch for ${source.question_id}`);
  }
  ledger.forEach((round, index) => {
    const canonical = expected[index];
    if (canonical === undefined) throw new AlayaError("CONFLICT", "snapshot canonical seed round order mismatch");
    assertRoundIdentity(
      round, canonical, extraction, source, semanticEntries, semanticBinding,
      systemPrompt, totals
    );
    assertRoundConservation(round);
    addClosureEntry(closure, round, extraction);
    addTotals(totals, round);
  });
  const ledgerMemorySources = assertSeedLedgerMaterializationProof({
    db,
    question,
    source,
    ledger
  });
  assertSidecarSourceClosure(question, ledger, ledgerMemorySources);
  assertAnswerDropReasons(question, ledger);
}

function canonicalRounds(source: LongMemEvalQuestion) {
  return source.haystack_sessions.flatMap((session, sessionIndex) =>
    pairSessionIntoRounds(session).map((round, roundIndex) => ({
      sessionIndex,
      roundIndex,
      sessionId: source.haystack_session_ids[sessionIndex]!,
      round
    })));
}

function assertRoundIdentity(
  actual: LongMemEvalSnapshotSeedRound,
  expected: ReturnType<typeof canonicalRounds>[number],
  extraction: CompleteExtraction,
  source: LongMemEvalQuestion,
  semanticEntries: SemanticSupplementEntries,
  semanticBinding: SourceAssertionSupplementBinding | undefined,
  systemPrompt: string,
  totals: LedgerTotals
): void {
  const content = expected.round.content.trim();
  if (systemPrompt === SOURCE_STATEMENTS_PROMPT) {
    if (actual.sessionIndex !== expected.sessionIndex || actual.roundIndex !== expected.roundIndex ||
        actual.sessionId !== expected.sessionId || actual.hasAnswer !== expected.round.hasAnswer || actual.contentSha256 !== sha256(content)) {
      throw new AlayaError("CONFLICT", "snapshot canonical raw round identity mismatch");
    }
    const sessionMessages = buildLongMemEvalSessionMessages(source.haystack_sessions[expected.sessionIndex]!, source.haystack_dates[expected.sessionIndex]);
    assertStatementRound({ round: actual, sessionMessages,
      roundMessages: expected.round.messageIndices.map(index => sessionMessages[index]!), extraction,
      seen: totals.statementSessions });
    return;
  }
  if (actual.statementSession !== undefined) throw new AlayaError("CONFLICT", "historical round cannot acquire a statement receipt");
  const turnMessages = buildLongMemEvalRoundMessages(
    source.haystack_sessions[expected.sessionIndex]!,
    expected.round,
    `${source.question_id}-s${expected.sessionIndex}-r${expected.roundIndex}`
  );
  const cacheKeys = computeExtractionTurnCacheKeys(
    extraction.extraction_model,
    extraction.request_profile,
    systemPrompt,
    {
      turnContent: content,
      turnMessages
    }, extraction.source_packing
  );
  const shards = readRoundExtractionShards(actual);
  const semantic = readRoundSemanticSupplementShards(actual);
  assertSemanticSupplementRound({
    semantic,
    semanticEntries,
    semanticBinding,
    cacheKeys,
    requests: collectOfficialApiExtractionCoverage(content, turnMessages, extraction.source_packing).requests
  });
  const rawSignalCount = sumExtractionShardCount(shards, semantic, "rawSignalCount");
  const draftCount = sumExtractionShardCount(shards, semantic, "draftCount");
  const single = shards.length === 1 ? shards[0] : undefined;
  if (actual.sessionIndex !== expected.sessionIndex ||
      actual.roundIndex !== expected.roundIndex || actual.sessionId !== expected.sessionId ||
      actual.hasAnswer !== expected.round.hasAnswer || actual.contentSha256 !== sha256(content) ||
      actual.extractionSource !== "cache" || !sameStrings(
        shards.map(({ cacheKey }) => cacheKey), cacheKeys
      ) || actual.cacheKey !== (single?.cacheKey ?? null) ||
      actual.rawJsonSha256 !== (single?.rawJsonSha256 ?? null) ||
      actual.rawSignalCount !== rawSignalCount || actual.draftCount !== draftCount) {
    throw new AlayaError("CONFLICT", "snapshot canonical seed round identity mismatch");
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertRoundConservation(round: LongMemEvalSnapshotSeedRound): void {
  const raw = round.rawSignalCount!;
  const drafts = round.draftCount!;
  const bindings = round.memoryBindings ?? [];
  const boundObjects = [...new Set(bindings.map((binding) => binding.objectId))];
  if (drafts !== raw - round.parseDropped ||
      round.factsProduced !== drafts - round.compileOverflowDropped ||
      round.factsProduced !== bindings.length + round.candidateAbsent + round.materializationDrop ||
      boundObjects.length !== round.memoryObjectIds.length ||
      boundObjects.some((objectId, index) => objectId !== round.memoryObjectIds[index])) {
    throw new AlayaError("CONFLICT", "snapshot seed round signal conservation mismatch");
  }
  if (new Set(round.memoryObjectIds).size !== round.memoryObjectIds.length) {
    throw new AlayaError("CONFLICT", "snapshot seed round repeats a memory object");
  }
}
