import { isDeepStrictEqual } from "node:util";
import { isCacheOnlySeedExtractionPath, type SeedExtractionPath } from
  "@do-soul/alaya-eval";
import {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  type ExtractionContentClosureEntry
} from "../../compile-seed/compile-seed-cache.js";
import { computeExtractionRawContentClosureSha256, extractionContentClosureEntriesFromIndex } from
  "../../extraction/content-closure.js";
import { containsExtractionFillQuestionWindow } from
  "../../extraction/fill/fill-authority.js";
import {
  assertSnapshotExtractionAuthorityBinding,
  type SnapshotExtractionAuthority
} from "../extraction-authority.js";
import { hasOrderedUniqueLongMemEvalSourceRounds, longMemEvalSourceRoundKey } from
  "../../provenance/source-rounds.js";
import type {
  LongMemEvalSnapshotQuestion,
  LongMemEvalSnapshotSeedRound
} from "../materialize.js";
import {
  type CompleteExtraction,
  type LedgerTotals,
  type SnapshotSeedLedgerClosureAuthority
} from "./seed-ledger-shared.js";

export function assertSidecarSourceClosure(
  question: LongMemEvalSnapshotQuestion,
  ledger: readonly LongMemEvalSnapshotSeedRound[],
  declared: ReadonlyMap<string, ReadonlySet<string>>
): void {
  const rounds = new Map(ledger.map((round) => [longMemEvalSourceRoundKey(round), round]));
  const entries = question.sidecar.filter((entry) => entry.objectKind === "memory_entry");
  if (entries.length !== declared.size) {
    throw new Error("snapshot seed ledger sidecar source closure mismatch");
  }
  for (const entry of entries) {
    const expected = declared.get(entry.objectId);
    const actual = entry.sourceRounds;
    const actualKeys = new Set(actual?.map(longMemEvalSourceRoundKey) ?? []);
    if (expected === undefined || actual === undefined ||
        !hasOrderedUniqueLongMemEvalSourceRounds(actual) ||
        !equalStringSets(actualKeys, expected) ||
        actual.some((source) => !matchesLedgerSource(source, expected, rounds))) {
      throw new Error("snapshot seed ledger sidecar source closure mismatch");
    }
  }
}

function equalStringSets(actual: ReadonlySet<string>, expected: ReadonlySet<string>): boolean {
  return actual.size === expected.size && [...actual].every((key) => expected.has(key));
}

function matchesLedgerSource(
  source: NonNullable<LongMemEvalSnapshotQuestion["sidecar"][number]["sourceRounds"]>[number],
  expected: ReadonlySet<string>,
  rounds: ReadonlyMap<string, LongMemEvalSnapshotSeedRound>
): boolean {
  const key = longMemEvalSourceRoundKey(source);
  const round = rounds.get(key);
  return expected.has(key) && round?.sessionId === source.sessionId &&
    round.hasAnswer === source.hasAnswer;
}

export function assertCacheClosure(
  extraction: CompleteExtraction,
  extractionAuthority: SnapshotExtractionAuthority,
  closure: ReadonlyMap<string, ExtractionContentClosureEntry>,
  authority: SnapshotSeedLedgerClosureAuthority
): void {
  assertSnapshotExtractionAuthorityBinding(extractionAuthority, extraction);
  const entries = [...closure.values()];
  if (entries.length === 0 || entries.length > extraction.expected_turns ||
      extraction.requested_turns !== extraction.expected_turns ||
      extraction.cached_turns !== extraction.expected_turns || extraction.coverage !== 1) {
    throw new Error("snapshot seed ledger cache closure mismatch");
  }
  assertQuestionWindow(extraction, authority);
  const authorityEntries = verifiedAuthorityClosureEntries(extraction, extractionAuthority);
  if (authority.kind === "contained") {
    assertContainedCacheClosure(extractionAuthority, entries);
    return;
  }
  if (entries.length !== extraction.expected_turns) {
    throw new Error("snapshot seed ledger cache closure mismatch");
  }
  if (computeExtractionKeySetSha256(closure.keys()) !==
      extraction.expected_key_set_sha256 ||
      computeExtractionRawContentClosureSha256(entries) !==
        computeExtractionRawContentClosureSha256(authorityEntries)) {
    throw new Error("snapshot seed ledger cache closure mismatch");
  }
}

function verifiedAuthorityClosureEntries(
  extraction: CompleteExtraction,
  extractionAuthority: SnapshotExtractionAuthority
): readonly ExtractionContentClosureEntry[] {
  const index = extractionAuthority.content_closure_index;
  const indexedEntries = extractionContentClosureEntriesFromIndex(
    index,
    extraction.extraction_model,
    extraction.request_profile
  );
  if (indexedEntries.length !== extraction.expected_turns ||
      computeExtractionKeySetSha256(Object.keys(index)) !==
        extraction.expected_key_set_sha256 ||
      computeExtractionContentClosureSha256(indexedEntries) !==
        extraction.content_closure_sha256) {
    throw new Error("snapshot seed ledger cache closure mismatch");
  }
  return indexedEntries;
}

function assertContainedCacheClosure(
  extractionAuthority: SnapshotExtractionAuthority,
  entries: readonly ExtractionContentClosureEntry[]
): void {
  const index = extractionAuthority.content_closure_index;
  if (entries.some((entry) => {
    const historical = index[entry.cacheKey];
    return historical === undefined || historical[0] !== entry.rawJsonSha256 ||
      historical[1] !== entry.rawSignalCount;
  })) {
    throw new Error("snapshot seed ledger cache closure mismatch");
  }
}

function assertQuestionWindow(
  extraction: CompleteExtraction,
  authority: SnapshotSeedLedgerClosureAuthority
): void {
  const { offset, limit } = authority.questionWindow;
  const matches = authority.kind === "exact"
    ? extraction.window_offset === offset && extraction.window_limit === limit
    : containsExtractionFillQuestionWindow(extraction, offset, limit);
  if (!matches) throw new Error("snapshot seed ledger question window mismatch");
}

export function assertSeedExtractionPath(
  actual: SeedExtractionPath | undefined,
  totals: LedgerTotals
): void {
  const expected: SeedExtractionPath = {
    path: "official_api_compile",
    extraction_attempts: totals.attempts,
    cache_hits: totals.attempts,
    llm_calls: 0,
    offline_fallbacks: 0,
    live_extraction_failures: 0,
    cached_extraction_failures: 0,
    facts_produced: totals.factsProduced,
    signals_dropped: totals.parseDropped + totals.compileOverflowDropped +
      totals.candidateAbsent + totals.materializationDrop,
    parse_dropped: totals.parseDropped,
    compile_overflow_dropped: totals.compileOverflowDropped,
    signals_dropped_by_reason: {
      candidate_absent: totals.candidateAbsent,
      materialization_drop: totals.materializationDrop
    }
  };
  if (!isCacheOnlySeedExtractionPath(actual) || !isDeepStrictEqual(actual, expected)) {
    throw new Error("snapshot seed extraction summary differs from round ledger");
  }
}

export function assertAnswerDropReasons(
  question: LongMemEvalSnapshotQuestion,
  ledger: readonly LongMemEvalSnapshotSeedRound[]
): void {
  const expected = ledger.reduce((sum, round) => round.hasAnswer ? {
    candidate_absent: sum.candidate_absent + round.candidateAbsent +
      (isVerifiedEmptyAnswerWipeRound(round) ? 1 : 0),
    materialization_drop: sum.materialization_drop + round.materializationDrop
  } : sum, { candidate_absent: 0, materialization_drop: 0 });
  const actual = question.answerSeedDropReasons ?? {
    candidate_absent: 0,
    materialization_drop: 0
  };
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`snapshot answer seed drops differ for ${question.questionId}`);
  }
}

function isVerifiedEmptyAnswerWipeRound(
  round: LongMemEvalSnapshotSeedRound
): boolean {
  if (round.memoryObjectIds.length > 0 ||
      (round.directEvidenceBindings?.length ?? 0) > 0 ||
      round.factsProduced > 0) return false;
  if (round.candidateAbsent > 0 || round.materializationDrop > 0) return false;
  if (
    round.extractionSource !== "fallback" &&
    round.rawSignalCount === 0 &&
    round.draftCount === 0 &&
    round.parseDropped === 0 &&
    round.compileOverflowDropped === 0
  ) {
    return true;
  }
  if (round.parseDropped > 0) return true;
  if (round.compileOverflowDropped > 0) return true;
  return round.extractionSource === "fallback";
}
