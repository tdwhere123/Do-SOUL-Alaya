// @ts-nocheck
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "@do-soul/alaya-storage";
import {
  writeExtractionCacheManifest
} from "../../../../runs/extraction/cache/extraction-cache-manifest.js";
import { writeRecallEvalSnapshot } from
  "../../../../datasets/longmemeval/runner/runner-helpers.js";
import {
  BENCH_DAEMON_DB_FILENAME,
  snapshotExtractionAuthorityPath,
  snapshotManifestPath,
  snapshotSidecarPath
} from "../../../../runs/snapshot/materialize.js";
import {
  createCurrentPostFillCacheAuthorityProof
} from "../../../../runs/snapshot/current/current-substrate-authority.js";
import { writeCompletedExtractionCacheFixture } from
  "../../extraction/completed-extraction-cache-fixture.js";
import { makeShardProvenance } from "../../runner/runner-concurrency-fixture.js";
import { removeTempDirectory } from "../../../support/temp-cleanup.js";

const DATASET_SHA = "d".repeat(64);
const MODEL = "test-extraction-model";
const ENV = {
  OFFICIAL_API_GARDEN_MODEL: MODEL,
  ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: "provider-default-v1"
} as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempDirectory(root)));
});

describe("snapshot writer preflight proof atomicity", () => {
  it("rejects malformed sidecar before publication and releases the lock for corrected preflight", async () => {
    const fixture = createFixture();
    const input = writerInput(fixture);
    writeFileSync(fixture.snapshotOut, "retained original target");
    await expect(writeRecallEvalSnapshot({ ...input, snapshotQuestions: [{
      questionId: "invalid", questionDate: "2026-01-01T00:00:00.000Z", unvalidated: true
    }] })).rejects.toThrow(/sidecar.*malformed/iu);
    expect(readFileSync(fixture.snapshotOut, "utf8")).toBe("retained original target");
    expect(snapshotArtifactPaths(fixture.snapshotOut).slice(1).filter(existsSync)).toEqual([]);
    // This empty source has no eligible relation. Corrected retry must reach
    // that independent gate (not a leaked publish lease), still without writes.
    await expect(writeRecallEvalSnapshot(input)).rejects.toThrow(/at least one eligible answers_with/iu);
    expect(readFileSync(fixture.snapshotOut, "utf8")).toBe("retained original target");
    expect(snapshotArtifactPaths(fixture.snapshotOut).slice(1).filter(existsSync)).toEqual([]);
  });

  it("writes nothing when the complete manifest changes after proof creation", async () => {
    const fixture = createFixture();
    const input = writerInput(fixture);
    writeExtractionCacheManifest(fixture.cacheRoot, {
      ...fixture.manifest,
      builder: "repinned-after-preflight"
    });

    await expect(writeRecallEvalSnapshot(input))
      .rejects.toThrow(/manifest changed|proof.*identity|preflight/iu);
    expect(snapshotArtifactPaths(fixture.snapshotOut).filter(existsSync)).toEqual([]);
  });
});

function createFixture() {
  const root = join(mkdtempRoot(), "writer");
  const seedDataDirRoot = join(root, "seed");
  const cacheRoot = join(root, "cache");
  mkdirSync(seedDataDirRoot, { recursive: true });
  initDatabase({
    filename: join(seedDataDirRoot, BENCH_DAEMON_DB_FILENAME)
  }).close();
  const manifest = writeCompletedExtractionCacheFixture({
    cacheRoot,
    turnContents: [],
    datasetRevision: DATASET_SHA,
    windowOffset: 0,
    windowLimit: 0,
    model: MODEL
  });
  const authorityInput = {
    cacheRoot,
    datasetSha256: DATASET_SHA,
    requiredTurnContents: [],
    requiredExtractionTurns: [],
    requiredQuestionWindow: { offset: 0, limit: 0 },
    env: ENV
  } as const;
  return {
    cacheRoot,
    seedDataDirRoot,
    manifest,
    proof: createCurrentPostFillCacheAuthorityProof(authorityInput),
    snapshotOut: join(root, "snapshot.db")
  };
}

function writerInput(fixture: ReturnType<typeof createFixture>) {
  const runProvenance = makeShardProvenance(0, 0);
  return {
    snapshotOut: fixture.snapshotOut,
    seedDataDirRoot: fixture.seedDataDirRoot,
    variant: "longmemeval_s" as const,
    commitSha7: "abc1234",
    canonicalQuestions: [],
    snapshotQuestions: [],
    extractionCacheRoot: fixture.cacheRoot,
    extractionCachePreflightProof: fixture.proof,
    datasetSha256: DATASET_SHA,
    seedExtractionPath: emptyCacheOnlySeedPath(),
    runProvenance: {
      ...runProvenance,
      dataset_sha256: DATASET_SHA,
      selection: { ...runProvenance.selection, dataset_sha256: DATASET_SHA }
    }
  };
}

function snapshotArtifactPaths(snapshotOut: string): readonly string[] {
  return [
    snapshotOut,
    snapshotSidecarPath(snapshotOut),
    snapshotManifestPath(snapshotOut),
    snapshotExtractionAuthorityPath(snapshotOut)
  ];
}

function mkdtempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "writer-preflight-proof-"));
  roots.push(root);
  return root;
}

function emptyCacheOnlySeedPath() {
  return {
    path: "official_api_compile" as const,
    extraction_attempts: 0,
    cache_hits: 0,
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
