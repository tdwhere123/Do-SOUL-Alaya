import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  isCacheOnlySeedExtractionPath,
  type SeedExtractionPath
} from "@do-soul/alaya-eval";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  computeCacheKey,
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  type ExtractionContentClosureEntry
} from "../../compile-seed/compile-seed-cache.js";
import { extractionContentClosureEntriesFromIndex } from
  "../../extraction/content-closure.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION
} from "../../extraction/cache/extraction-cache-manifest.js";
import { containsExtractionFillQuestionWindow } from
  "../../extraction/fill/fill-authority.js";
import type { ExtractionFillQuestionWindow } from
  "../../extraction/fill/manifest/fill-manifest-contract.js";
import {
  assertSnapshotExtractionAuthorityBinding,
  type SnapshotExtractionAuthority
} from "../extraction-authority.js";
import { pairSessionIntoRounds, type LongMemEvalQuestion } from "../../ingestion/dataset.js";
import {
  hasOrderedUniqueLongMemEvalSourceRounds,
  longMemEvalSourceRoundKey
} from "../../provenance/source-rounds.js";
import type {
  LongMemEvalSnapshotQuestion,
  LongMemEvalSnapshotSeedRound,
  LongMemEvalSnapshotSidecarFile,
  SnapshotExtractionProvenance,
  SnapshotExtractionProvenanceV3
} from "../materialize.js";
import { assertSeedLedgerMaterializationProof } from
  "./seed-ledger-materialization-proof.js";

interface LedgerTotals {
  attempts: number;
  factsProduced: number;
  parseDropped: number;
  compileOverflowDropped: number;
  candidateAbsent: number;
  materializationDrop: number;
}

type CompleteExtraction = SnapshotExtractionProvenanceV3 & Required<Pick<
  SnapshotExtractionProvenanceV3,
  "expected_turns" | "expected_key_set_sha256" | "content_closure_sha256"
>>;

export interface SnapshotSeedLedgerClosureAuthority {
  readonly kind: "exact" | "contained";
  readonly questionWindow: ExtractionFillQuestionWindow;
}

export function assertSnapshotSeedLedgerBinding(input: {
  readonly dbPath: string;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly questions: readonly LongMemEvalQuestion[];
  readonly extraction: SnapshotExtractionProvenance | null;
  readonly extractionAuthority: SnapshotExtractionAuthority;
  readonly seedExtractionPath: SeedExtractionPath | undefined;
  readonly closureAuthority: SnapshotSeedLedgerClosureAuthority;
}): void {
  const extraction = requireCompleteExtraction(input.extraction);
  const totals = emptyTotals();
  const closure = new Map<string, ExtractionContentClosureEntry>();
  const db = new DatabaseSync(input.dbPath, { readOnly: true });
  try {
    input.sidecar.questions.forEach((question, index) => {
      const source = input.questions[index];
      if (source === undefined) throw new Error("snapshot seed ledger question order mismatch");
      assertQuestionLedger(db, question, source, extraction, totals, closure);
    });
  } finally {
    db.close();
  }
  assertCacheClosure(
    extraction,
    input.extractionAuthority,
    closure,
    input.closureAuthority
  );
  assertSeedExtractionPath(input.seedExtractionPath, totals);
}

function requireCompleteExtraction(
  value: SnapshotExtractionProvenance | null
): CompleteExtraction {
  if (value?.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION ||
      value.fill_status !== "complete" || value.content_closure_sha256 === undefined ||
      value.expected_turns === undefined || value.expected_key_set_sha256 === undefined ||
      value.request_profile === undefined ||
      value.cache_key_algo !== EXTRACTION_CACHE_KEY_ALGO ||
      value.system_prompt_sha256 !== sha256(OFFICIAL_API_SYSTEM_PROMPT)) {
    throw new Error("promotion snapshot extraction closure is incomplete or drifted");
  }
  return value as CompleteExtraction;
}

function assertQuestionLedger(
  db: DatabaseSync,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  extraction: CompleteExtraction,
  totals: LedgerTotals,
  closure: Map<string, ExtractionContentClosureEntry>
): void {
  const ledger = question.seedRounds;
  const expected = canonicalRounds(source);
  if (ledger === undefined || ledger.length !== expected.length) {
    throw new Error(`snapshot canonical seed round count mismatch for ${source.question_id}`);
  }
  ledger.forEach((round, index) => {
    const canonical = expected[index];
    if (canonical === undefined) throw new Error("snapshot canonical seed round order mismatch");
    assertRoundIdentity(round, canonical, extraction);
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
  extraction: CompleteExtraction
): void {
  const content = expected.round.content.trim();
  const cacheKey = computeCacheKey(
    extraction.extraction_model,
    extraction.request_profile,
    OFFICIAL_API_SYSTEM_PROMPT,
    content
  );
  if (actual.sessionIndex !== expected.sessionIndex ||
      actual.roundIndex !== expected.roundIndex || actual.sessionId !== expected.sessionId ||
      actual.hasAnswer !== expected.round.hasAnswer || actual.contentSha256 !== sha256(content) ||
      actual.extractionSource !== "cache" || actual.cacheKey !== cacheKey ||
      actual.rawJsonSha256 === null || actual.rawSignalCount === null ||
      actual.draftCount === null) {
    throw new Error("snapshot canonical seed round identity mismatch");
  }
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

function assertSidecarSourceClosure(
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

function addClosureEntry(
  closure: Map<string, ExtractionContentClosureEntry>,
  round: LongMemEvalSnapshotSeedRound,
  extraction: CompleteExtraction
): void {
  const entry = {
    cacheKey: round.cacheKey!,
    model: extraction.extraction_model,
    requestProfile: extraction.request_profile,
    rawJsonSha256: round.rawJsonSha256!,
    rawSignalCount: round.rawSignalCount!,
    parsedDraftCount: round.draftCount!
  };
  const prior = closure.get(entry.cacheKey);
  if (prior !== undefined && !isDeepStrictEqual(prior, entry)) {
    throw new Error("snapshot seed ledger repeats a cache key with different content");
  }
  closure.set(entry.cacheKey, entry);
}

function assertCacheClosure(
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
  if (authority.kind === "contained") {
    assertContainedCacheClosure(extraction, extractionAuthority, entries);
    return;
  }
  if (entries.length !== extraction.expected_turns) {
    throw new Error("snapshot seed ledger cache closure mismatch");
  }
  if (computeExtractionKeySetSha256(closure.keys()) !==
      extraction.expected_key_set_sha256 ||
      computeExtractionContentClosureSha256(entries) !==
        extraction.content_closure_sha256) {
    throw new Error("snapshot seed ledger cache closure mismatch");
  }
}

function assertContainedCacheClosure(
  extraction: CompleteExtraction,
  extractionAuthority: SnapshotExtractionAuthority,
  entries: readonly ExtractionContentClosureEntry[]
): void {
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
        extraction.content_closure_sha256 ||
      entries.some((entry) => !isDeepStrictEqual(index[entry.cacheKey], [
        entry.rawJsonSha256,
        entry.rawSignalCount,
        entry.parsedDraftCount
      ]))) {
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

function assertSeedExtractionPath(
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

function assertAnswerDropReasons(
  question: LongMemEvalSnapshotQuestion,
  ledger: readonly LongMemEvalSnapshotSeedRound[]
): void {
  const expected = ledger.reduce((sum, round) => round.hasAnswer ? {
    candidate_absent: sum.candidate_absent + round.candidateAbsent +
      (isSuccessfulEmptyExtraction(round) ? 1 : 0),
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

function isSuccessfulEmptyExtraction(round: LongMemEvalSnapshotSeedRound): boolean {
  return round.extractionSource !== "fallback" &&
    round.rawSignalCount === 0 &&
    round.draftCount === 0 &&
    round.factsProduced === 0 &&
    round.parseDropped === 0 &&
    round.compileOverflowDropped === 0 &&
    round.candidateAbsent === 0 &&
    round.materializationDrop === 0 &&
    round.memoryObjectIds.length === 0;
}

function addTotals(totals: LedgerTotals, round: LongMemEvalSnapshotSeedRound): void {
  totals.attempts += 1;
  totals.factsProduced += round.factsProduced;
  totals.parseDropped += round.parseDropped;
  totals.compileOverflowDropped += round.compileOverflowDropped;
  totals.candidateAbsent += round.candidateAbsent;
  totals.materializationDrop += round.materializationDrop;
}

function emptyTotals(): LedgerTotals {
  return {
    attempts: 0,
    factsProduced: 0,
    parseDropped: 0,
    compileOverflowDropped: 0,
    candidateAbsent: 0,
    materializationDrop: 0
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
