import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchSignalExtractor } from "../../../longmemeval/compile-seed.js";
import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import {
  createFreshDirectDeepSeek500Authorization
} from "../../../longmemeval/extraction/authority/direct-deepseek-500.js";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision
} from "../../../longmemeval/extraction/authority/inspection.js";
import {
  createExtractionAuthorityReceipt,
  writeExtractionAuthorityReceipt
} from "../../../longmemeval/extraction/authority/receipt.js";
import { runExtractionFill } from "../../../longmemeval/extraction/extraction-fill.js";

const { acquireWriteLease, loadCanonicalDataset } = vi.hoisted(() => ({
  acquireWriteLease: vi.fn(),
  loadCanonicalDataset: vi.fn()
}));

vi.mock("../../../longmemeval/ingestion/fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../longmemeval/ingestion/fetch.js")>();
  return { ...actual, loadDatasetWithIdentity: loadCanonicalDataset };
});

vi.mock("../../../longmemeval/extraction/fill/manifest/fill-root-guard.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../longmemeval/extraction/fill/manifest/fill-root-guard.js")
  >();
  return {
    ...actual,
    acquireExtractionCacheWriteLease: (cacheRoot: string) => {
      acquireWriteLease(cacheRoot);
      return actual.acquireExtractionCacheWriteLease(cacheRoot);
    }
  };
});

const DIRECT_VARIANT = "longmemeval_s";
const DIRECT_ROOT_MARKER = ".alaya-direct-deepseek-500-root.json";
const temporaryRoots: string[] = [];

interface DirectRuntimeFixture {
  readonly cacheRoot: string;
  readonly receiptPath: string;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("direct DeepSeek runtime extraction", () => {
  it("fills the exact direct 500Q receipt without R3 and ignores its root marker", async () => {
    const fixture = await createDirectRuntimeFixture();
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      input.onTransportAttempt?.();
      return { rawJson: '{"signals":[]}' };
    });

    const result = await runExtractionFill({
      variant: DIRECT_VARIANT,
      limit: 500,
      concurrency: 64,
      cacheRoot: fixture.cacheRoot,
      authorityReceiptPath: fixture.receiptPath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });

    expect(extract).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ newlyExtracted: 2, coverage: 1 });
    expect(result.authorityTelemetry).toMatchObject({ attempts: 2, successfulShards: 2 });
    expect(existsSync(join(fixture.cacheRoot, DIRECT_ROOT_MARKER))).toBe(true);
    expect(loadCanonicalDataset.mock.calls.every(([, options]) =>
      options.dataDir === undefined && options.pinnedMetaRoot === undefined
    )).toBe(true);
  });

  it("rejects a replaced direct root marker before the simulated transport continues", async () => {
    const fixture = await createDirectRuntimeFixture();
    let transportStarted = false;
    let transportFailure: unknown;
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      try {
        input.onTransportAttempt?.();
      } catch (cause) {
        transportFailure = cause;
        throw cause;
      }
      transportStarted = true;
      return { rawJson: '{"signals":[]}' };
    });

    await expect(runExtractionFill({
      variant: DIRECT_VARIANT,
      limit: 500,
      concurrency: 64,
      cacheRoot: fixture.cacheRoot,
      authorityReceiptPath: fixture.receiptPath,
      extractorFactory: () => {
        writeFileSync(join(fixture.cacheRoot, DIRECT_ROOT_MARKER), "replaced\n", "utf8");
        return { extract };
      },
      log: () => undefined
    })).rejects.toThrow(/terminal task failure/u);

    expect(extract).toHaveBeenCalled();
    expect(transportStarted).toBe(false);
    expect(errorMessage(transportFailure)).toMatch(/target root changed/u);
  });

  it("rejects pinned metadata before creating a direct fill lease or extractor", async () => {
    const fixture = await createDirectRuntimeFixture();
    const extractorFactory = vi.fn<() => BenchSignalExtractor>();

    await expect(runExtractionFill({
      variant: DIRECT_VARIANT,
      limit: 500,
      cacheRoot: fixture.cacheRoot,
      pinnedMetaRoot: "forbidden-pinned-metadata",
      authorityReceiptPath: fixture.receiptPath,
      extractorFactory,
      log: () => undefined
    })).rejects.toThrow(/direct.*pinnedMetaRoot/iu);

    expect(extractorFactory).not.toHaveBeenCalled();
    expect(acquireWriteLease).not.toHaveBeenCalled();
  });
});

async function createDirectRuntimeFixture(): Promise<DirectRuntimeFixture> {
  configureDirectDeepSeekEnvironment();
  configureCanonicalDataset();
  const root = mkdtempSync(join(tmpdir(), "alaya-direct-deepseek-runtime-"));
  temporaryRoots.push(root);
  const cacheRoot = join(root, "cache");
  const directSpend = createFreshDirectDeepSeek500Authorization({
    cacheRoot,
    operator: "direct-runtime-test"
  });
  const inspection = await inspectExtractionAuthority({
    variant: DIRECT_VARIANT,
    limit: 500,
    cacheRoot,
    revision: readCurrentExtractionAuthorityRevision(),
    action: "fill"
  });
  const receipt = createExtractionAuthorityReceipt({
    action: "fill",
    observation: inspection.observation,
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 300
    },
    diskFloorBytes: 0,
    inspection: inspectionSummary(inspection),
    directSpend,
    maxConcurrency: 64
  });
  const receiptPath = join(root, "direct-authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  return { cacheRoot, receiptPath };
}

function configureDirectDeepSeekEnvironment(): void {
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:DIRECT_RUNTIME_GARDEN_KEY");
  vi.stubEnv("DIRECT_RUNTIME_GARDEN_KEY", "test-key");
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "deepseek-v4-flash");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_MODEL_FAMILY", "deepseek-v4-flash-compatible");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://ai.loli.sh.cn/v1");
}

function configureCanonicalDataset(): void {
  loadCanonicalDataset.mockResolvedValue({
    questions: directQuestions(),
    sha256: "a".repeat(64),
    checksumSource: "in-process-canonical-dataset",
    sourcePath: "in-process-canonical-dataset",
    promotionAuthority: null
  });
}

function directQuestions(): readonly LongMemEvalQuestion[] {
  return Array.from({ length: 500 }, (_, index) => ({
    question_id: `direct-${String(index).padStart(3, "0")}`,
    question_type: "single_session",
    question: "What was the shared direct fixture fact?",
    answer: "shared answer",
    question_date: "2026-01-01",
    haystack_session_ids: ["shared-fact", "shared-decoy"],
    haystack_dates: ["2025-12-01", "2025-11-01"],
    haystack_sessions: [
      [
        { role: "user", content: "Shared direct fixture fact.", has_answer: true },
        { role: "assistant", content: "Acknowledged." }
      ],
      [{ role: "user", content: "Shared direct fixture decoy." }]
    ],
    answer_session_ids: ["shared-fact"]
  }));
}

function inspectionSummary(inspection: Awaited<ReturnType<typeof inspectExtractionAuthority>>) {
  return {
    writerLock: inspection.writerLock,
    disk: inspection.disk,
    credentialStatus: inspection.credentialStatus,
    modelReadiness: inspection.modelReadiness
  };
}

function errorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) throw new Error("expected an Error transport failure");
  return cause.message;
}
