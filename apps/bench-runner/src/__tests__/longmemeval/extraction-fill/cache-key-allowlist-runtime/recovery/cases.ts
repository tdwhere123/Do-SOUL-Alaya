import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { BenchSignalExtractor } from "../../../../../bench/compile-seed.js";
import { extractionCacheManifestPath } from
  "../../../../../bench/extraction/cache/extraction-cache-manifest.js";
import { runExtractionFill } from
  "../../../../../bench/extraction/extraction-fill.js";
import type { LongMemEvalQuestion } from
  "../../../../../longmemeval/ingestion/dataset.js";
import { providerBackedExtractionResult } from "../../fixture.js";

const CRASH_CHILD_ENV = "ALAYA_TEST_CATALOG_REFILL_CRASH_CHILD";
const FAILPOINT_ENV = "ALAYA_TEST_CATALOG_REFILL_SIGKILL_AFTER";

interface RecoveryFixture {
  readonly entryUrl: string;
  readonly variant: string;
  readonly roots: () => {
    readonly cacheRoot: string;
    readonly dataDir: string;
    readonly pinnedMetaRoot: string;
  };
  readonly setCredentialFixture: () => void;
  readonly questions: () => readonly LongMemEvalQuestion[];
  readonly writeFixtureDataset: (questions: readonly LongMemEvalQuestion[]) => Promise<void>;
  readonly prefillFirstQuestion: () => Promise<void>;
  readonly remainingKeys: (questions: readonly LongMemEvalQuestion[]) => readonly string[];
  readonly writeAuthority: (keys: readonly string[]) => Promise<{
    readonly authority: string;
    readonly selection: string;
  }>;
  readonly controlArtifacts: (prefix: string) => string[];
  readonly providerTimeoutFailure: () => Error;
  readonly groundedResponse: (prompt: string) => string;
}

export function registerCatalogRefillRecoveryCases(fixture: RecoveryFixture): void {
  it("reconciles a completion witness left before resume cleanup without provider work", async () => {
    fixture.setCredentialFixture();
    const questions = fixture.questions();
    await fixture.writeFixtureDataset(questions);
    await fixture.prefillFirstQuestion();
    const authority = await fixture.writeAuthority(fixture.remainingKeys(questions));
    let calls = 0;
    const interruptedExtract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      calls += 1;
      if (calls === 2) throw fixture.providerTimeoutFailure();
      return providerBackedExtractionResult(fixture.groundedResponse(input.userPrompt));
    });
    const roots = fixture.roots();
    await expect(runExtractionFill({
      variant: fixture.variant, concurrency: 1, ...roots,
      authorityReceiptPath: authority.authority,
      targetSelectionReceiptPath: authority.selection,
      extractorFactory: () => ({ extract: interruptedExtract }), log: () => undefined
    })).rejects.toThrow(/terminal task failure.*failure_timeout/u);
    const resumeName = fixture.controlArtifacts(".catalog-refill-resume.")[0]!;
    const staleResumeBytes = readFileSync(join(roots.cacheRoot, resumeName));
    const fillExtract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      return providerBackedExtractionResult(fixture.groundedResponse(input.userPrompt));
    });
    const completed = await runExtractionFill({
      variant: fixture.variant, ...roots,
      authorityReceiptPath: authority.authority,
      targetSelectionReceiptPath: authority.selection,
      extractorFactory: () => ({ extract: fillExtract }), log: () => undefined
    });
    const manifestBytes = readFileSync(extractionCacheManifestPath(roots.cacheRoot));
    const witnessBytes = readFileSync(join(roots.cacheRoot,
      fixture.controlArtifacts(".catalog-refill-completion.")[0]!));
    writeFileSync(join(roots.cacheRoot, resumeName), staleResumeBytes);
    const reconcileExtract = vi.fn<BenchSignalExtractor["extract"]>();

    const reconciled = await runExtractionFill({
      variant: fixture.variant, ...roots,
      authorityReceiptPath: authority.authority,
      targetSelectionReceiptPath: authority.selection,
      extractorFactory: () => ({ extract: reconcileExtract }), log: () => undefined
    });

    expect(reconcileExtract).not.toHaveBeenCalled();
    expect(reconciled.manifest).toEqual(completed.manifest);
    expect(readFileSync(extractionCacheManifestPath(roots.cacheRoot))).toEqual(manifestBytes);
    expect(readFileSync(join(roots.cacheRoot,
      fixture.controlArtifacts(".catalog-refill-completion.")[0]!))).toEqual(witnessBytes);
    expect(fixture.controlArtifacts(".catalog-refill-resume.")).toEqual([]);
  });

  it.each([
    ["in-progress-result-manifest-published", "partial-result", 2],
    ["failure-manifest-published", "provider-failure", 1]
  ] as const)("recovers after SIGKILL at %s", async (phase, mode, expectedCalls) => {
    fixture.setCredentialFixture();
    const questions = fixture.questions();
    await fixture.writeFixtureDataset(questions);
    await fixture.prefillFirstQuestion();
    const authority = await fixture.writeAuthority(fixture.remainingKeys(questions));
    const roots = fixture.roots();
    const crashed = await runCatalogRefillCrashChild(fixture.entryUrl, {
      mode, ...roots, authorityReceiptPath: authority.authority,
      targetSelectionReceiptPath: authority.selection
    }, phase);

    expect(crashed).toMatchObject({ code: null, signal: "SIGKILL" });
    expect(fixture.controlArtifacts(".catalog-refill-resume.")).toEqual([]);
    const staleLock = join(roots.cacheRoot, ".extraction-fill.lock");
    expect(existsSync(staleLock)).toBe(true);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      expect(fixture.controlArtifacts(".catalog-refill-resume.")).toHaveLength(1);
      await input.onTransportAttempt?.();
      return providerBackedExtractionResult(fixture.groundedResponse(input.userPrompt));
    });

    const result = await runExtractionFill({
      variant: fixture.variant, concurrency: 1, ...roots,
      authorityReceiptPath: authority.authority,
      targetSelectionReceiptPath: authority.selection,
      extractorFactory: () => ({ extract }), log: () => undefined
    });

    expect(extract).toHaveBeenCalledTimes(expectedCalls);
    expect(result.manifest).toMatchObject({ fill_status: "complete", cached_turns: 4 });
    expect(fixture.controlArtifacts(".catalog-refill-resume.")).toEqual([]);
  }, 30_000);
}

interface CrashChildInput {
  readonly mode: "partial-result" | "provider-failure";
  readonly cacheRoot: string;
  readonly dataDir: string;
  readonly pinnedMetaRoot: string;
  readonly authorityReceiptPath: string;
  readonly targetSelectionReceiptPath: string;
}

export function registerCatalogRefillCrashChild(
  variant: string,
  groundedResponse: (prompt: string) => string,
  providerTimeoutFailure: () => Error
): void {
  if (process.env[CRASH_CHILD_ENV] === undefined) return;
  it("runs catalog refill to the selected durable boundary", async () => {
    const input = JSON.parse(process.env[CRASH_CHILD_ENV]!) as CrashChildInput;
    let calls = 0;
    const extract: BenchSignalExtractor["extract"] = async (request) => {
      await request.onTransportAttempt?.();
      calls += 1;
      if (input.mode === "provider-failure" && calls === 2) throw providerTimeoutFailure();
      return providerBackedExtractionResult(groundedResponse(request.userPrompt));
    };
    await runExtractionFill({
      variant, concurrency: 1, cacheRoot: input.cacheRoot, dataDir: input.dataDir,
      pinnedMetaRoot: input.pinnedMetaRoot,
      authorityReceiptPath: input.authorityReceiptPath,
      targetSelectionReceiptPath: input.targetSelectionReceiptPath,
      ...(input.mode === "partial-result" ? { questionBatchLimit: 1 } : {}),
      extractorFactory: () => ({ extract }), log: () => undefined
    });
    throw new Error("catalog refill SIGKILL failpoint was not reached");
  }, 20_000);
}

function runCatalogRefillCrashChild(
  entryUrl: string,
  input: CrashChildInput,
  phase: "in-progress-result-manifest-published" | "failure-manifest-published"
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  const child = spawn(process.execPath, [
    join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run",
    fileURLToPath(entryUrl), "--pool=threads", "--maxWorkers=1"
  ], {
    cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, [CRASH_CHILD_ENV]: JSON.stringify(input), [FAILPOINT_ENV]: phase }
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
