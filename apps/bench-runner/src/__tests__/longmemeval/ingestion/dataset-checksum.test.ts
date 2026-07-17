import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadDataset,
  loadDatasetWithIdentity
} from "../../../longmemeval/ingestion/fetch.js";
import { aggregateLongMemEvalRunResults } from "../../../longmemeval/runner/archive/runner-archive-aggregate.js";
import { buildLongMemEvalRunPayload } from "../../../longmemeval/runner/archive/runner-archive-payload.js";
import { prepareLongMemEvalRun } from "../../../longmemeval/runner/prepare-context.js";
import { LongMemEvalDiagnosticsSpool } from "../../../longmemeval/diagnostics/spool.js";
import { emptySeedFuelInventory } from "../../../longmemeval/extraction/seed-fuel/seed-fuel-inventory.js";
import { createStratifiedQuestionManifest } from "../../../longmemeval/selection/question-manifest.js";
import type { LongMemEvalRunOptions } from "../../../longmemeval/runner.js";
import { writeExtractionCacheTestManifest } from
  "../extraction/extraction-cache-test-fixture.js";

const committedPinRead = vi.hoisted(() => ({ sha256: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: unknown[]) => {
      const requestedPath = String(args[0]).replaceAll("\\", "/");
      if (committedPinRead.sha256 !== null && requestedPath.endsWith(
        "/docs/bench-history/datasets/longmemeval_oracle.meta.json"
      )) {
        return Promise.resolve(JSON.stringify({ sha256: committedPinRead.sha256 }));
      }
      return Reflect.apply(actual.readFile, undefined, args);
    }
  };
});

let tmpDir: string;
let dataDir: string;
let pinnedMetaRoot: string;

const VARIANT = "longmemeval_oracle" as const;

// Minimal but schema-valid LongMemEval question for the test fixture.
const FIXTURE_QUESTIONS = [
  {
    question_id: "fixture-1",
    question_type: "single_session",
    question: "fixture probe",
    answer: "fixture answer",
    question_date: "2026-01-01",
    haystack_session_ids: ["session-a"],
    haystack_dates: ["2025-12-01"],
    haystack_sessions: [
      [{ role: "user", content: "fixture content", has_answer: true }]
    ],
    answer_session_ids: ["session-a"]
  },
  {
    question_id: "fixture-2",
    question_type: "single_session",
    question: "second fixture probe",
    answer: "second fixture answer",
    question_date: "2026-01-02",
    haystack_session_ids: ["session-b"],
    haystack_dates: ["2025-12-02"],
    haystack_sessions: [
      [{ role: "user", content: "second fixture content", has_answer: true }]
    ],
    answer_session_ids: ["session-b"]
  }
];

async function seedLocalDataset(rawOverride?: string): Promise<string> {
  const raw = rawOverride ?? JSON.stringify(FIXTURE_QUESTIONS);
  await writeFile(join(dataDir, `${VARIANT}.json`), raw, "utf8");
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

async function seedPinnedMeta(sha256: string): Promise<void> {
  await writeFile(
    join(pinnedMetaRoot, `${VARIANT}.meta.json`),
    JSON.stringify(
      {
        name: VARIANT,
        sha256,
        question_count: FIXTURE_QUESTIONS.length,
        first_pinned_at: "2026-05-14T00:00:00Z",
        pinned_by_commit: "test"
      },
      null,
      2
    ),
    "utf8"
  );
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "alaya-dataset-checksum-"));
  dataDir = join(tmpDir, "data");
  pinnedMetaRoot = join(tmpDir, "pinned-meta");
  await mkdir(dataDir, { recursive: true });
  await mkdir(pinnedMetaRoot, { recursive: true });
});

afterEach(async () => {
  committedPinRead.sha256 = null;
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("loadDataset checksum verification", () => {
  it("loads the dataset when the local sha256 matches the pinned sha256", async () => {
    const sha = await seedLocalDataset();
    await seedPinnedMeta(sha);

    const result = await loadDataset(VARIANT, { dataDir, pinnedMetaRoot });

    expect(result).toHaveLength(FIXTURE_QUESTIONS.length);
    expect(result[0]?.question_id).toBe("fixture-1");
  });

  it("keeps a custom checksum authority diagnostic-only", async () => {
    const sha = await seedLocalDataset();
    await seedPinnedMeta(sha);

    const result = await loadDatasetWithIdentity(VARIANT, {
      dataDir,
      pinnedMetaRoot
    });

    expect(result.promotionAuthority).toBeNull();
  });

  it("grants custom data bytes authority only through the default committed pin", async () => {
    committedPinRead.sha256 = await seedLocalDataset();

    const result = await loadDatasetWithIdentity(VARIANT, { dataDir });

    expect(result.sourcePath).toBe(join(dataDir, `${VARIANT}.json`));
    expect(result.checksumSource.replaceAll("\\", "/")).toMatch(
      /\/docs\/bench-history\/datasets\/longmemeval_oracle\.meta\.json$/u
    );
    expect(result.promotionAuthority).not.toBeNull();
  });
});

describe("prepareLongMemEvalRun release evidence authority", () => {
  it.each([
    ["full dataset", {}],
    ["canonical prefix", { limit: 1 }]
  ] satisfies ReadonlyArray<[string, Partial<LongMemEvalRunOptions>]>)(
    "grants authority to an offset-zero %s",
    async (_label, overrides) => {
      committedPinRead.sha256 = await seedLocalDataset();

      await expect(prepareCanonicalAuthority(overrides)).resolves.not.toBeNull();
    }
  );

  it("keeps a nonzero-offset window diagnostic-only", async () => {
    committedPinRead.sha256 = await seedLocalDataset();

    await expect(prepareCanonicalAuthority({ offset: 1 })).resolves.toBeNull();
  });

  it("keeps a question-manifest selection diagnostic-only", async () => {
    const datasetSha256 = await seedLocalDataset();
    committedPinRead.sha256 = datasetSha256;
    const manifestPath = join(tmpDir, "question-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify(createStratifiedQuestionManifest({
        variant: VARIANT,
        datasetSha256,
        questions: FIXTURE_QUESTIONS,
        targetCount: 1
      })),
      "utf8"
    );

    await expect(prepareCanonicalAuthority({
      questionManifest: manifestPath
    })).resolves.toBeNull();
  });
});

async function prepareCanonicalAuthority(
  overrides: Partial<LongMemEvalRunOptions>
) {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "fixture-model");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "");
  vi.stubEnv("ALAYA_SEED_EXTRACTION_DIAG_DIR", join(tmpDir, "diagnostics"));
  const extractionCacheRoot = join(tmpDir, "authority-extraction-cache");
  writeExtractionCacheTestManifest({
    cacheRoot: extractionCacheRoot,
    model: "fixture-model",
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
  });
  const spool = await LongMemEvalDiagnosticsSpool.create();
  try {
    const context = await prepareLongMemEvalRun({
      variant: VARIANT,
      historyRoot: join(tmpDir, "authority-history"),
      dataDir,
      dataDirRoot: join(tmpDir, "authority-seed-root"),
      extractionCacheRoot,
      embeddingMode: "disabled",
      ...overrides
    }, undefined, spool);
    return context.releaseEvidenceAuthority;
  } finally {
    await spool.dispose();
  }
}

describe("loadDataset checksum verification", () => {
  it("throws checksum mismatch when the local file is mutated after pinning", async () => {
    const sha = await seedLocalDataset();
    await seedPinnedMeta(sha);

    // Mutate the local file so its sha drifts away from the pinned value.
    const localPath = join(dataDir, `${VARIANT}.json`);
    const original = await readFile(localPath, "utf8");
    await writeFile(localPath, original + "\n// mutated\n", "utf8");

    await expect(
      loadDataset(VARIANT, { dataDir, pinnedMetaRoot })
    ).rejects.toThrow(/dataset checksum mismatch: longmemeval_oracle/);
  });

  it("throws 'dataset not pinned' when the pinned meta file is missing", async () => {
    await seedLocalDataset();
    // Intentionally do NOT seed pinned meta.
    await unlink(join(pinnedMetaRoot, `${VARIANT}.meta.json`)).catch(() => {
      // Already absent; that is the precondition under test.
    });

    await expect(
      loadDataset(VARIANT, { dataDir, pinnedMetaRoot })
    ).rejects.toThrow(/dataset not pinned: longmemeval_oracle/);
  });
});

describe("loadDataset checksum verification", () => {
  it("archives the verified dataset identity when pinned meta changes after preparation", async () => {
    const verifiedSha = await seedLocalDataset();
    await seedPinnedMeta(verifiedSha);
    vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "fixture-model");
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
    const spool = await LongMemEvalDiagnosticsSpool.create();

    try {
      const context = await prepareLongMemEvalRun({
        variant: VARIANT,
        historyRoot: join(tmpDir, "history"),
        dataDir,
        dataDirRoot: join(tmpDir, "seed-root"),
        pinnedMetaRoot,
        extractionCacheRoot: join(tmpDir, "extraction-cache"),
        embeddingMode: "disabled"
      }, undefined, spool);

      await seedPinnedMeta("f".repeat(64));
      const build = buildLongMemEvalRunPayload({
        opts: context.opts,
        questionsLength: context.questions.length,
        windowLength: context.window.length,
        datasetSha256: context.datasetSha256,
        datasetChecksumSource: context.datasetChecksumSource,
        selectionContract: context.selectionContract,
        aggregate: aggregateLongMemEvalRunResults([]),
        extractionStats: context.seedRunner.stats,
        seedFuelInventory: emptySeedFuelInventory(),
        alayaVersion: context.alayaVersion,
        commitSha7: context.commitSha7,
        runAt: context.runAt,
        embeddingProviderLabel: context.embeddingProviderLabel,
        policyShape: context.policyShape,
        simulateReport: context.simulateReport,
        recallWeightOverrides: undefined
      });

      expect(build.payload.dataset).toMatchObject({
        checksum_sha256: verifiedSha,
        checksum_source: join(pinnedMetaRoot, `${VARIANT}.meta.json`)
      });
    } finally {
      await spool.dispose();
    }
  });
});
