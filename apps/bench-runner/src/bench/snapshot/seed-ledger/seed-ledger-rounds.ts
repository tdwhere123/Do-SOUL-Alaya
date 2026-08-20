import { DatabaseSync } from "node:sqlite";
import { buildOfficialApiExtractionRequests } from "@do-soul/alaya-soul";
import { computeExtractionTurnCacheKeys } from "../../compile-seed/compile-seed-cache.js";
import {
  buildLongMemEvalRoundMessages,
  pairSessionIntoRounds,
  type LongMemEvalQuestion
} from "../../../longmemeval/ingestion/dataset.js";
import type {
  LongMemEvalSnapshotQuestion,
  LongMemEvalSnapshotSeedRound
} from "../materialize.js";
import { assertSeedLedgerMaterializationProof } from "./seed-ledger-materialization-proof.js";
import { assertDirectSourceEvidenceClosure } from "./direct-source-evidence-proof.js";
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
    throw new Error(`snapshot canonical seed round count mismatch for ${source.question_id}`);
  }
  ledger.forEach((round, index) => {
    const canonical = expected[index];
    if (canonical === undefined) throw new Error("snapshot canonical seed round order mismatch");
    assertRoundIdentity(
      round, canonical, extraction, source, semanticEntries, semanticBinding,
      systemPrompt
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
  assertDirectSourceEvidenceClosure({ db, question, source, ledger });
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
  systemPrompt: string
): void {
  const content = expected.round.content.trim();
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
    }
  );
  const shards = readRoundExtractionShards(actual);
  const semantic = readRoundSemanticSupplementShards(actual);
  assertSemanticSupplementRound({
    semantic,
    semanticEntries,
    semanticBinding,
    cacheKeys,
    requests: buildOfficialApiExtractionRequests(content, turnMessages)
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
    throw new Error("snapshot canonical seed round identity mismatch");
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
    throw new Error("snapshot seed round signal conservation mismatch");
  }
  if (new Set(round.memoryObjectIds).size !== round.memoryObjectIds.length) {
    throw new Error("snapshot seed round repeats a memory object");
  }
}
