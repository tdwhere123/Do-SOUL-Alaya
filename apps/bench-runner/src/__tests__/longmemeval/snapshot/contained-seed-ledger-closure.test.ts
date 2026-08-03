import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "@do-soul/alaya-storage";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  computeCacheKey,
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  computeExtractionTurnCacheKey
} from "../../../longmemeval/compile-seed/compile-seed-cache.js";
import {
  buildLongMemEvalRoundMessages,
  pairSessionIntoRounds,
  type LongMemEvalQuestion
} from
  "../../../longmemeval/ingestion/dataset.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  type ExtractionCacheManifestV3
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import type {
  LongMemEvalSnapshotSeedRound,
  LongMemEvalSnapshotSidecarFile
} from "../../../longmemeval/snapshot/materialize.js";
import { assertSnapshotSeedLedgerBinding } from
  "../../../longmemeval/snapshot/seed-ledger/seed-ledger-binding.js";
import {
  buildSnapshotExtractionAuthority,
  buildSnapshotExtractionSummary
} from "../../../longmemeval/snapshot/extraction-authority.js";

const roots: string[] = [];
const MODEL = "fixture-model";
const PROFILE = "provider-default-v1" as const;
const CONTENT = "User: no durable fact\nAssistant: acknowledged";
const MATERIALIZED_CONTENT = "User: durable fact\nAssistant: remembered";
const FIXTURE_QUESTION = question(false);
const SELECTED_KEY = fixtureRoundCacheKey(FIXTURE_QUESTION, 0, 0, CONTENT);
const MATERIALIZED_KEY = fixtureRoundCacheKey(FIXTURE_QUESTION, 0, 1, MATERIALIZED_CONTENT);
const EXTRA_KEY = sha256("extra cache member");
const SELECTED_RAW_SHA = sha256('{"signals":[]}');
const HISTORICAL_SYSTEM_PROMPT = "historical source-extraction prompt";
const CONTENT_ONLY_SELECTED_KEY = computeCacheKey(
  MODEL,
  PROFILE,
  OFFICIAL_API_SYSTEM_PROMPT,
  CONTENT
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("contained snapshot seed-ledger closure", () => {
  it("accepts rounds keyed with the trusted-role corpus digest", () => {
    expect(SELECTED_KEY).not.toBe(CONTENT_ONLY_SELECTED_KEY);
    expect(() => verifyRounds(canonicalRounds())).not.toThrow();
  });

  it("rejects a ledger cache key that omits the trusted-role corpus digest", () => {
    const rounds = canonicalRounds();
    rounds[0] = {
      ...rounds[0]!,
      cacheKey: CONTENT_ONLY_SELECTED_KEY
    };
    expect(() => verifyRounds(rounds)).toThrow(/canonical seed round identity mismatch/u);
  });

  it("accepts an explicitly supplied historical prompt without weakening cache binding", () => {
    const rounds = canonicalRounds(HISTORICAL_SYSTEM_PROMPT);
    expect(() => verifyRounds(rounds, false, HISTORICAL_SYSTEM_PROMPT)).not.toThrow();
    expect(() => verifyRounds(rounds)).toThrow(/identity mismatch|closure is incomplete/u);
  });

  it("accepts a canonical zero-signal answer round as candidate absence", () => {
    expect(() => verifyRounds(canonicalAnswerRounds(), true)).not.toThrow();
  });

  it("rejects raw digest drift even when the contained ledger is self-consistent", () => {
    const rounds = canonicalRounds();
    rounds[0] = {
      ...rounds[0]!,
      rawJsonSha256: sha256("drifted raw response")
    };
    expect(() => verifyRounds(rounds)).toThrow(/cache closure mismatch/u);
  });

  it("rejects raw count drift after conservation-preserving drop accounting", () => {
    const rounds = canonicalRounds();
    rounds[0] = {
      ...rounds[0]!,
      rawSignalCount: 1,
      parseDropped: 1
    };
    expect(() => verifyRounds(rounds)).toThrow(/cache closure mismatch/u);
  });

  it("rejects draft count drift after conservation-preserving compile accounting", () => {
    const rounds = canonicalRounds();
    rounds[0] = {
      ...rounds[0]!,
      rawSignalCount: 1,
      draftCount: 1,
      compileOverflowDropped: 1
    };
    expect(() => verifyRounds(rounds)).toThrow(/cache closure mismatch/u);
  });
});

function verifyRounds(
  rounds: LongMemEvalSnapshotSeedRound[],
  answerRound = false,
  systemPrompt = OFFICIAL_API_SYSTEM_PROMPT
): void {
  const root = mkdtempSync(join(tmpdir(), "contained-seed-ledger-"));
  roots.push(root);
  const dbPath = join(root, "snapshot.db");
  initDatabase({ filename: dbPath }).close();
  const extractionFixture = extraction(systemPrompt);
  assertSnapshotSeedLedgerBinding({
    dbPath,
    sidecar: sidecar(rounds, answerRound),
    questions: [question(answerRound)],
    extraction: extractionFixture.compact,
    extractionAuthority: extractionFixture.authority,
    seedExtractionPath: {
      path: "official_api_compile",
      extraction_attempts: rounds.length,
      cache_hits: rounds.length,
      llm_calls: 0,
      offline_fallbacks: 0,
      live_extraction_failures: 0,
      cached_extraction_failures: 0,
      facts_produced: rounds.reduce((sum, round) => sum + round.factsProduced, 0),
      signals_dropped: rounds.reduce((sum, round) => sum + round.parseDropped +
        round.compileOverflowDropped + round.candidateAbsent + round.materializationDrop, 0),
      parse_dropped: rounds.reduce((sum, round) => sum + round.parseDropped, 0),
      compile_overflow_dropped: rounds.reduce(
        (sum, round) => sum + round.compileOverflowDropped,
        0
      ),
      signals_dropped_by_reason: {
        candidate_absent: rounds.reduce((sum, round) => sum + round.candidateAbsent, 0),
        materialization_drop: rounds.reduce(
          (sum, round) => sum + round.materializationDrop,
          0
        )
      }
    },
    closureAuthority: {
      kind: "contained",
      questionWindow: { offset: 0, limit: 1 }
    },
    systemPrompt
  });
}

function extraction(systemPrompt = OFFICIAL_API_SYSTEM_PROMPT) {
  const selectedKey = fixtureRoundCacheKey(FIXTURE_QUESTION, 0, 0, CONTENT, systemPrompt);
  const materializedKey = fixtureRoundCacheKey(
    FIXTURE_QUESTION, 0, 1, MATERIALIZED_CONTENT, systemPrompt
  );
  const entries = [{
    cacheKey: selectedKey,
    model: MODEL,
    requestProfile: PROFILE,
    rawJsonSha256: SELECTED_RAW_SHA,
    rawSignalCount: 0,
    parsedDraftCount: 0
  }, {
    cacheKey: materializedKey,
    model: MODEL,
    requestProfile: PROFILE,
    rawJsonSha256: sha256('{"signals":[{}]}'),
    rawSignalCount: 1,
    parsedDraftCount: 1
  }, {
    cacheKey: EXTRA_KEY,
    model: MODEL,
    requestProfile: PROFILE,
    rawJsonSha256: sha256("extra raw response"),
    rawSignalCount: 1,
    parsedDraftCount: 1
  }].sort((left, right) => left.cacheKey.localeCompare(right.cacheKey));
  const manifest: ExtractionCacheManifestV3 = {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: MODEL,
    model_family: MODEL,
    request_profile: PROFILE,
    provider_url: "redacted",
    system_prompt_sha256: sha256(systemPrompt),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: "b".repeat(64),
    requested_turns: entries.length,
    cached_turns: entries.length,
    coverage: 1,
    fill_status: "complete",
    window_offset: 0,
    window_limit: 2,
    expected_turns: entries.length,
    expected_key_set_sha256: computeExtractionKeySetSha256(
      entries.map((entry) => entry.cacheKey)
    ),
    content_closure_sha256: computeExtractionContentClosureSha256(entries),
    content_closure_index: Object.fromEntries(entries.map((entry) => [
      entry.cacheKey,
      [entry.rawJsonSha256, entry.rawSignalCount, entry.parsedDraftCount] as const
    ])),
    storage: "git-tracked",
    built_at: "2026-07-17T00:00:00.000Z",
    builder: "test"
  };
  const sourceManifestSha256 = "a".repeat(64);
  const compact = buildSnapshotExtractionSummary(manifest, sourceManifestSha256);
  return {
    compact,
    authority: buildSnapshotExtractionAuthority(
      manifest,
      sourceManifestSha256,
      compact
    )
  };
}

function canonicalRounds(systemPrompt = OFFICIAL_API_SYSTEM_PROMPT): LongMemEvalSnapshotSeedRound[] {
  return [{
    sessionIndex: 0,
    roundIndex: 0,
    sessionId: "session-1",
    contentSha256: sha256(CONTENT),
    hasAnswer: false,
    extractionSource: "cache",
    cacheKey: fixtureRoundCacheKey(FIXTURE_QUESTION, 0, 0, CONTENT, systemPrompt),
    rawJsonSha256: SELECTED_RAW_SHA,
    rawSignalCount: 0,
    draftCount: 0,
    factsProduced: 0,
    parseDropped: 0,
    compileOverflowDropped: 0,
    candidateAbsent: 0,
    materializationDrop: 0,
    memoryObjectIds: []
  }, {
    sessionIndex: 0,
    roundIndex: 1,
    sessionId: "session-1",
    contentSha256: sha256(MATERIALIZED_CONTENT),
    hasAnswer: false,
    extractionSource: "cache",
    cacheKey: fixtureRoundCacheKey(
      FIXTURE_QUESTION, 0, 1, MATERIALIZED_CONTENT, systemPrompt
    ),
    rawJsonSha256: sha256('{"signals":[{}]}'),
    rawSignalCount: 1,
    draftCount: 1,
    factsProduced: 1,
    parseDropped: 0,
    compileOverflowDropped: 0,
    candidateAbsent: 0,
    materializationDrop: 1,
    memoryObjectIds: []
  }];
}

function canonicalAnswerRounds(): LongMemEvalSnapshotSeedRound[] {
  const rounds = canonicalRounds();
  rounds[0] = { ...rounds[0]!, hasAnswer: true };
  return rounds;
}

function sidecar(
  rounds: readonly LongMemEvalSnapshotSeedRound[],
  answerRound: boolean
): LongMemEvalSnapshotSidecarFile {
  return {
    schema_version: 2,
    variant: "longmemeval_s",
    questions: [{
      questionId: "q-contained",
      question: "What durable fact was stated?",
      questionDate: "2026-07-17T00:00:00.000Z",
      answerSessionIds: answerRound ? ["session-1"] : [],
      ...(answerRound
        ? { answerSeedDropReasons: { candidate_absent: 1, materialization_drop: 0 } }
        : {}),
      sidecar: [],
      seedRounds: rounds,
      workspaceId: "longmemeval-q-contained",
      runId: "longmemeval-q-contained"
    }]
  };
}

function question(answerRound: boolean): LongMemEvalQuestion {
  return {
    question_id: "q-contained",
    question_type: "single-session-user",
    question: "What durable fact was stated?",
    answer: "none",
    question_date: "2026-07-17T00:00:00.000Z",
    haystack_session_ids: ["session-1"],
    haystack_dates: ["2026-07-16T00:00:00.000Z"],
    haystack_sessions: [[
      {
        role: "user",
        content: "no durable fact",
        ...(answerRound ? { has_answer: true } : {})
      },
      { role: "assistant", content: "acknowledged" },
      { role: "user", content: "durable fact" },
      { role: "assistant", content: "remembered" }
    ]],
    answer_session_ids: answerRound ? ["session-1"] : []
  };
}

function fixtureRoundCacheKey(
  source: LongMemEvalQuestion,
  sessionIndex: number,
  roundIndex: number,
  content: string,
  systemPrompt = OFFICIAL_API_SYSTEM_PROMPT
): string {
  const session = source.haystack_sessions[sessionIndex]!;
  const round = pairSessionIntoRounds(session)[roundIndex]!;
  return computeExtractionTurnCacheKey(
    MODEL,
    PROFILE,
    systemPrompt,
    {
      turnContent: content,
      turnMessages: buildLongMemEvalRoundMessages(
        session,
        round,
        `${source.question_id}-s${sessionIndex}-r${roundIndex}`
      )
    }
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
