import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExtractionFill } from "../../longmemeval/extraction-fill.js";
import { readExtractionCacheManifest } from "../../longmemeval/extraction-cache-manifest.js";
import type { BenchSignalExtractor } from "../../longmemeval/compile-seed.js";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";

// @anchor extraction-fill-contract: Layer 1 daemon-free cache fill. Drives a
// stub extractor (no live network) over a tiny fixture dataset and asserts
// dedup, write-through, second-run cache hits, and a coverage-bearing manifest.

let tmpDir: string;
let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;

const VARIANT = "longmemeval_oracle";

function buildQuestion(id: string, fact: string, decoy: string): LongMemEvalQuestion {
  return {
    question_id: id,
    question_type: "single_session",
    question: `What about ${id}?`,
    answer: `answer ${id}`,
    question_date: "2026-01-01",
    haystack_session_ids: [`s-${id}`, `decoy-${id}`],
    haystack_dates: ["2025-12-01", "2025-11-01"],
    haystack_sessions: [
      [
        { role: "user", content: fact, has_answer: true },
        { role: "assistant", content: "Acknowledged." }
      ],
      [{ role: "user", content: decoy }]
    ],
    answer_session_ids: [`s-${id}`]
  };
}

async function writeFixtureDataset(
  questions: readonly LongMemEvalQuestion[]
): Promise<void> {
  const raw = JSON.stringify(questions);
  const sha = createHash("sha256").update(raw, "utf8").digest("hex");
  await writeFile(join(dataDir, `${VARIANT}.json`), raw, "utf8");
  await writeFile(
    join(pinnedMetaRoot, `${VARIANT}.meta.json`),
    JSON.stringify({ name: VARIANT, sha256: sha, question_count: questions.length }),
    "utf8"
  );
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "extraction-fill-"));
  cacheRoot = join(tmpDir, "cache");
  dataDir = join(tmpDir, "data");
  pinnedMetaRoot = join(tmpDir, "pinned");
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(pinnedMetaRoot, { recursive: true });
  // The fill pass resolves the model from the single source; set the env so it
  // never relies on a manifest that does not exist yet.
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gpt-5.4-mini");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("runExtractionFill", () => {
  it("dedups turn_content, write-throughs misses, and writes a coverage manifest", async () => {
    // q001 and q002 share an identical answer round -> one cache key. Each has
    // a distinct decoy round. Distinct turns: 2 shared-collapsed-to-1 + 2 decoys
    // = 3 cache keys.
    await writeFixtureDataset([
      buildQuestion("q001", "User: shared fact\nAssistant: Acknowledged.", "User: decoy one"),
      buildQuestion("q002", "User: shared fact\nAssistant: Acknowledged.", "User: decoy two")
    ]);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => ({
      rawJson: '{"signals":[]}'
    }));
    const result = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });

    // 2 questions × (answer round + decoy round); the answer round collapses
    // across the two questions, so 3 distinct turn_content cache keys.
    expect(result.requestedTurns).toBe(3);
    expect(result.newlyExtracted).toBe(3);
    expect(result.cacheHits).toBe(0);
    expect(result.failures).toBe(0);
    expect(extract).toHaveBeenCalledTimes(3);

    const manifest = readExtractionCacheManifest(cacheRoot);
    expect(manifest).toBeDefined();
    expect(manifest?.extraction_model).toBe("gpt-5.4-mini");
    expect(manifest?.coverage).toBe(1);
    expect(manifest?.requested_turns).toBe(3);
    expect(manifest?.builder).toBe("extraction-fill");
    // Shards on disk are the 3 distinct keys.
    const shardDirs = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const shardCount = shardDirs.reduce(
      (sum, dir) => sum + readdirSync(join(cacheRoot, dir)).length,
      0
    );
    expect(shardCount).toBe(3);
    expect(manifest?.cached_turns).toBe(3);
  });

  it("serves a second fill entirely from cache (zero new extractions)", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => ({
      rawJson: '{"signals":[]}'
    }));
    const factory = (): BenchSignalExtractor => ({ extract });

    const first = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: factory,
      log: () => undefined
    });
    expect(first.newlyExtracted).toBe(2);
    expect(first.cacheHits).toBe(0);

    const second = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: factory,
      log: () => undefined
    });
    // Same content -> every key is a hit, no new delegate calls beyond the
    // first run's 2.
    expect(second.cacheHits).toBe(2);
    expect(second.newlyExtracted).toBe(0);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(second.coverage).toBe(1);
  });

  it("counts a failing extraction without crashing the pass (coverage reflects it)", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: beta\nAssistant: ok.", "User: gamma decoy")
    ]);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => {
      throw new Error("simulated provider 500");
    });
    const result = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });
    expect(result.requestedTurns).toBe(2);
    expect(result.failures).toBe(2);
    expect(result.newlyExtracted).toBe(0);
    expect(result.coverage).toBe(0);
    // A manifest is still written so the next preflight sees the gap.
    expect(existsSync(join(cacheRoot, "manifest.json"))).toBe(true);
  });

  it("honours --limit by staging the first N questions only", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: one\nAssistant: ok.", "User: decoy-one"),
      buildQuestion("q002", "User: two\nAssistant: ok.", "User: decoy-two"),
      buildQuestion("q003", "User: three\nAssistant: ok.", "User: decoy-three")
    ]);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => ({
      rawJson: '{"signals":[]}'
    }));
    const result = await runExtractionFill({
      variant: VARIANT,
      limit: 1,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });
    // Only q001 -> answer round + decoy = 2 distinct turns.
    expect(result.requestedTurns).toBe(2);
    expect(extract).toHaveBeenCalledTimes(2);
  });
});
