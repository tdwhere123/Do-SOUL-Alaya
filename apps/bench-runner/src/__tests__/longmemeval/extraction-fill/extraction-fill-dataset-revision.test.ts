import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExtractionFill } from "../../../longmemeval/extraction/extraction-fill.js";
import {
  readExtractionCacheManifest,
  writeExtractionCacheManifest
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import type { BenchSignalExtractor } from "../../../longmemeval/compile-seed.js";
import {
  buildLongMemEvalFixtureQuestion,
  writeLongMemEvalFixtureDataset
} from "../longmemeval-fixture.js";

const VARIANT = "longmemeval_oracle";
let root: string;
let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fill-dataset-revision-"));
  cacheRoot = join(root, "cache");
  dataDir = join(root, "data");
  pinnedMetaRoot = join(root, "pinned");
  await Promise.all([cacheRoot, dataDir, pinnedMetaRoot].map(
    (path) => mkdir(path, { recursive: true })
  ));
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gpt-5.4-mini");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("extraction-fill dataset revision", () => {
  it("writes the verified pinned revision on a fresh fill", async () => {
    await writeQuestions(1);

    const result = await fill(1);

    expect(result.manifest.dataset_revision).toBe(await pinnedRevision());
  });

  it("preserves the pinned revision when extending the fill window", async () => {
    await writeQuestions(2);

    const first = await fill(1);
    const extended = await fill(2);

    expect(extended.manifest.dataset_revision).toBe(first.manifest.dataset_revision);
    expect(extended.manifest.dataset_revision).toBe(await pinnedRevision());
    expect(extended.manifest.requested_turns).toBeGreaterThan(first.manifest.requested_turns ?? 0);
  });

  it("rejects a conflicting revision before creating the live delegate", async () => {
    await writeQuestions(1);
    await fill(1);
    const manifest = readExtractionCacheManifest(cacheRoot);
    expect(manifest).toBeDefined();
    writeExtractionCacheManifest(cacheRoot, {
      ...manifest!, dataset_revision: "f".repeat(64)
    });
    const extractorFactory = vi.fn(() => extractor());

    await expect(runExtractionFill({
      variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
      extractorFactory, log: () => undefined
    })).rejects.toThrow(/dataset revision.*mismatch/iu);
    expect(extractorFactory).not.toHaveBeenCalled();
  });

  it("refuses to pin an unpinned cache that already contains turns", async () => {
    await writeQuestions(1);
    await fill(1);
    const manifest = readExtractionCacheManifest(cacheRoot);
    expect(manifest?.cached_turns).toBeGreaterThan(0);
    writeExtractionCacheManifest(cacheRoot, {
      ...manifest!, dataset_revision: "unpinned"
    });
    const extractorFactory = vi.fn(() => extractor());

    await expect(runExtractionFill({
      variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
      extractorFactory, log: () => undefined
    })).rejects.toThrow(/unpinned.*non-empty|new cache root/iu);
    expect(extractorFactory).not.toHaveBeenCalled();
    expect(readExtractionCacheManifest(cacheRoot)?.dataset_revision).toBe("unpinned");
  });
});

async function writeQuestions(count: number): Promise<void> {
  await writeLongMemEvalFixtureDataset({
    variant: VARIANT,
    dataDir,
    pinnedMetaRoot,
    questions: Array.from({ length: count }, (_, index) =>
      buildLongMemEvalFixtureQuestion(`q${index + 1}`, `s${index + 1}`)
    )
  });
}

function fill(limit: number) {
  return runExtractionFill({
    variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot, limit,
    extractorFactory: () => extractor(), log: () => undefined
  });
}

function extractor(): BenchSignalExtractor {
  return { extract: async () => ({ rawJson: '{"signals":[]}' }) };
}

async function pinnedRevision(): Promise<string> {
  const parsed = JSON.parse(
    await readFile(join(pinnedMetaRoot, `${VARIANT}.meta.json`), "utf8")
  ) as { readonly sha256: string };
  return parsed.sha256;
}
