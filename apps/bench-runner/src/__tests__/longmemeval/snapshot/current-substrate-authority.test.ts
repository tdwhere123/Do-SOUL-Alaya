import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  computeSystemPromptSha256,
  EXTRACTION_CACHE_KEY_ALGO,
  writeExtractionCacheManifest,
  type ExtractionCacheManifest
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import {
  assertCurrentPostFillCacheAuthority,
  assertStoredCurrentSnapshotAttribution
} from "../../../longmemeval/snapshot/current/current-substrate-authority.js";
import { writeCompletedExtractionCacheFixture } from
  "../extraction/completed-extraction-cache-fixture.js";
import { withRecallEvalSnapshot } from "../../../longmemeval/snapshot/recall-eval/recall-eval-loader.js";
import {
  currentSnapshotManifestFor,
  currentSnapshotSidecarFor
} from "./current-snapshot-fixture.js";

const roots: string[] = [];
const DATASET_SHA = "d".repeat(64);
const MODEL = "test-extraction-model";
const TURNS = ["User: first\nAssistant: one", "User: second\nAssistant: two"];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("current post-fill substrate authority", () => {
  it("accepts an exact complete v3 cache", () => {
    const cacheRoot = fixtureRoot();
    writeComplete(cacheRoot, TURNS, 0, 2);

    const authority = assertAuthority(cacheRoot, TURNS, 0, 2);
    expect(authority).not.toHaveProperty("content_closure_index");
    expect(authority.expected_turns).toBe(2);
  });

  it("redacts supplemental provider credentials from current provenance", () => {
    const cacheRoot = fixtureRoot();
    const manifest = writeComplete(cacheRoot, TURNS, 0, 2);
    writeExtractionCacheManifest(cacheRoot, {
      ...manifest,
      supplemental_source_receipt: {
        kind: "longmemeval-extraction-supplemental-source",
        receipt_sha256: "a".repeat(64),
        shard_count: 1,
        key_set_sha256: "b".repeat(64),
        physical_provider_url: "https://user:secret@supplement.invalid/v1?key=hidden",
        physical_model: MODEL
      }
    });

    const authority = assertAuthority(cacheRoot, TURNS, 0, 2);
    expect(authority.supplemental_source_receipt?.physical_provider_url)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("accepts a fully cached contained subwindow", () => {
    const cacheRoot = fixtureRoot();
    writeComplete(cacheRoot, TURNS, 0, 2);

    expect(() => assertAuthority(cacheRoot, [TURNS[0]!], 0, 1)).not.toThrow();
  });

  it("rejects a narrow cache for a wider snapshot window", () => {
    const cacheRoot = fixtureRoot();
    writeComplete(cacheRoot, [TURNS[0]!], 0, 1);

    expect(() => assertAuthority(cacheRoot, TURNS, 0, 2))
      .toThrow(/does not contain|question window/iu);
  });

  it.each(["missing", "v1", "v2", "in_progress"] as const)(
    "rejects %s cache authority",
    (kind) => {
      const cacheRoot = fixtureRoot();
      if (kind !== "missing") writeNoncurrentManifest(cacheRoot, kind);
      expect(() => assertAuthority(cacheRoot, TURNS, 0, 2))
        .toThrow(/complete v3|post-fill|manifest/iu);
    }
  );

  it.each([
    ["garden credential", { ALAYA_OFFICIAL_GARDEN_SECRET_REF: "secret:bench" }],
    ["legacy garden credential", { ALAYA_GARDEN_OPENAI_SECRET_REF: "secret:bench" }],
    ["live extraction", { ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "true" }]
  ] as const)("rejects %s before snapshot production", (_label, extraEnv) => {
    const cacheRoot = fixtureRoot();
    writeComplete(cacheRoot, TURNS, 0, 2);
    expect(() => assertAuthority(cacheRoot, TURNS, 0, 2, extraEnv))
      .toThrow(/credentialless and cache-only/iu);
  });

  it("rejects a stored gate-ineligible current snapshot claim", () => {
    const root = fixtureRoot();
    const snapshotPath = join(root, "snapshot.db");
    writeFileSync(`${snapshotPath}.manifest.json`, JSON.stringify({
      attribution: { status: "attributed", gate_eligible: false }
    }), "utf8");

    expect(() => assertStoredCurrentSnapshotAttribution(snapshotPath))
      .toThrow(/stored gate_eligible claim is false/u);
  });

  it("makes current recall reject a stored gate-ineligible snapshot", async () => {
    const root = fixtureRoot();
    const snapshotPath = join(root, "snapshot.db");
    const manifest = {
      ...currentSnapshotManifestFor("q-1"),
      attribution: { status: "attributed" as const, gate_eligible: false }
    };
    writeFileSync(
      `${snapshotPath}.sidecar.json`,
      JSON.stringify(currentSnapshotSidecarFor("q-1")),
      "utf8"
    );
    writeFileSync(`${snapshotPath}.manifest.json`, JSON.stringify(manifest), "utf8");

    await expect(withRecallEvalSnapshot({
      snapshotDbPath: snapshotPath,
      variant: "longmemeval_s"
    }, async () => undefined)).rejects.toThrow(/attribution claim differs|gate_eligible/u);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "current-substrate-"));
  roots.push(root);
  return root;
}

function writeComplete(
  cacheRoot: string,
  turns: readonly string[],
  windowOffset: number,
  windowLimit: number
): ExtractionCacheManifest {
  return writeCompletedExtractionCacheFixture({
    cacheRoot,
    turnContents: turns,
    datasetRevision: DATASET_SHA,
    windowOffset,
    windowLimit,
    model: MODEL
  });
}

function assertAuthority(
  cacheRoot: string,
  turns: readonly string[],
  offset: number,
  limit: number,
  extraEnv: Readonly<Record<string, string>> = {}
) {
  return assertCurrentPostFillCacheAuthority({
    cacheRoot,
    datasetSha256: DATASET_SHA,
    requiredTurnContents: turns,
    requiredQuestionWindow: { offset, limit },
    env: {
      OFFICIAL_API_GARDEN_MODEL: MODEL,
      ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: "provider-default-v1",
      ...extraEnv
    }
  });
}

function writeNoncurrentManifest(
  cacheRoot: string,
  kind: "v1" | "v2" | "in_progress"
): void {
  const manifest = {
    schema_version: kind === "v1" ? 1 : kind === "v2" ? 2 : 3,
    extraction_model: MODEL,
    ...(kind === "v1" ? {} : { model_family: MODEL }),
    ...(kind === "in_progress" ? { request_profile: "provider-default-v1" } : {}),
    provider_url: "https://provider.invalid/v1",
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: DATASET_SHA,
    requested_turns: 2,
    cached_turns: 2,
    coverage: 1,
    storage: "git-tracked",
    built_at: "2026-07-16T00:00:00.000Z",
    builder: "test",
    ...(kind === "in_progress" ? {
      fill_status: "in_progress",
      window_offset: 0,
      window_limit: 2,
      expected_turns: 2,
      expected_key_set_sha256: "e".repeat(64)
    } : {})
  } as ExtractionCacheManifest;
  writeExtractionCacheManifest(cacheRoot, manifest);
}

function cacheOnlySeedPath() {
  return {
    path: "official_api_compile",
    extraction_attempts: 1,
    cache_hits: 1,
    llm_calls: 0,
    offline_fallbacks: 0,
    live_extraction_failures: 0,
    cached_extraction_failures: 0,
    facts_produced: 0,
    signals_dropped: 0,
    parse_dropped: 0,
    compile_overflow_dropped: 0,
    signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
  };
}
