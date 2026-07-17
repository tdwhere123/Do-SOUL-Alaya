import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { KpiPayload } from "@do-soul/alaya-eval";
import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import { LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME } from
  "../../../longmemeval/provenance/evidence-manifest.js";
import { buildMockQuestion } from "../runner/longmemeval-runner-fixture.js";

export interface RunnerIntegrationFixture {
  readonly variant: "longmemeval_oracle" | "longmemeval_s";
  readonly dataDir: string;
  readonly historyRoot: string;
  readonly pinnedMetaRoot: string;
  readonly extractionCacheRoot: string;
  readonly datasetSha256: string;
}

export function stubOfflineExtractionEnv(): void {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "test-extraction-model");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
}

export function buildRunnerQuestions(
  prefix: string,
  count: number
): LongMemEvalQuestion[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    return buildMockQuestion(`${prefix}${suffix}`, `${prefix}-session-${suffix}`);
  });
}

export async function createRunnerFixture(input: {
  readonly root: string;
  readonly label: string;
  readonly variant: RunnerIntegrationFixture["variant"];
  readonly questions: readonly LongMemEvalQuestion[];
}): Promise<RunnerIntegrationFixture> {
  const dataDir = join(input.root, `longmemeval-${input.label}`);
  const historyRoot = join(input.root, `history-${input.label}`);
  const pinnedMetaRoot = join(input.root, `pinned-meta-${input.label}`);
  const extractionCacheRoot = join(input.root, `extraction-cache-${input.label}`);
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(pinnedMetaRoot, { recursive: true })
  ]);
  const datasetRaw = JSON.stringify(input.questions);
  const datasetSha256 = createHash("sha256").update(datasetRaw, "utf8").digest("hex");
  await Promise.all([
    writeFile(join(dataDir, `${input.variant}.json`), datasetRaw, "utf8"),
    writeFile(
      join(pinnedMetaRoot, `${input.variant}.meta.json`),
      JSON.stringify({
        name: input.variant,
        sha256: datasetSha256,
        question_count: input.questions.length,
        first_pinned_at: "2026-05-14T00:00:00Z",
        pinned_by_commit: "test"
      }),
      "utf8"
    )
  ]);
  return {
    variant: input.variant,
    dataDir,
    historyRoot,
    pinnedMetaRoot,
    extractionCacheRoot,
    datasetSha256
  };
}

export async function assertPartialTierOneArchive(input: {
  readonly result: {
    readonly slug: string;
    readonly kpiPath: string;
    readonly payload: KpiPayload;
    readonly evidenceContext: unknown;
  };
  readonly historyRoot: string;
  readonly benchName: "public-multiturn" | "public-crossquestion";
  readonly otherBenchName: "public-multiturn" | "public-crossquestion";
}): Promise<void> {
  expect(input.result.evidenceContext).toBeNull();
  const archiveRoot = join(input.historyRoot, input.benchName, input.result.slug);
  const manifest = await readJson<{
    run: { bench_name: string; selection_contract: { selected_count: number } };
    evidence_status: string;
    artifacts: Array<{ role: string }>;
  }>(join(archiveRoot, LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME));
  expect(manifest.run.bench_name).toBe(input.benchName);
  expect(manifest.run.selection_contract.selected_count).toBe(
    input.result.payload.evaluated_count
  );
  expect(manifest.evidence_status).toBe("partial");
  expect(manifest.artifacts.map(({ role }) => role)).toEqual(expect.arrayContaining([
    "kpi", "diagnostics", "full_diagnostics", "cohort_ledger", "comparison", "run_provenance"
  ]));
  await expect(pointerSlug(input.historyRoot, input.benchName, "latest-run.json"))
    .resolves.toBe(input.result.slug);
  await expect(pointerSlug(input.historyRoot, input.benchName, "latest-passing.json"))
    .rejects.toMatchObject({ code: "ENOENT" });
  await expect(pointerSlug(input.historyRoot, input.otherBenchName, "latest-run.json"))
    .rejects.toMatchObject({ code: "ENOENT" });
}

export async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8")) as T;
}

async function pointerSlug(
  historyRoot: string,
  benchName: string,
  filename: string
): Promise<string> {
  const pointer = await readJson<{ slug: string }>(join(historyRoot, benchName, filename));
  return pointer.slug;
}
