// @ts-nocheck
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BenchSignalExtractor } from "../../../../../runs/compile-seed.js";
import { extractionCacheManifestPath } from
  "../../../../../runs/extraction/cache/extraction-cache-manifest.js";
import { runExtractionFill } from
  "../../../../../runs/extraction/extraction-fill.js";
import type { LongMemEvalQuestion } from
  "../../../../../datasets/longmemeval/ingestion/dataset.js";
import { providerBackedResponseResult } from "../../../extraction/extraction-cache-test-fixture.js";

import { startCatalogRefillCrashChild } from "./crash-child.js";

interface RecoveryFixture {
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
  let running: ReturnType<typeof startCatalogRefillCrashChild> | undefined;
  // This nested hook joins the child before the outer fixture hook deletes its roots.
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });
  it("reconciles a completion witness left before resume cleanup without provider work", async () => {
    fixture.setCredentialFixture();
    const questions = fixture.questions();
    await fixture.writeFixtureDataset(questions);
    await fixture.prefillFirstQuestion();
    const authority = await fixture.writeAuthority(fixture.remainingKeys(questions));
    let calls = 0;
    const interruptedExtract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      calls += 1;
      if (calls === 2) { await input.onTransportAttempt?.(); throw fixture.providerTimeoutFailure(); }
      return providerBackedResponseResult(input, fixture.groundedResponse(input.userPrompt));
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
      return providerBackedResponseResult(input, fixture.groundedResponse(input.userPrompt));
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

  it.skipIf(process.platform === "win32").for([
    ["in-progress-result-manifest-published", "partial-result", 2],
    ["failure-manifest-published", "provider-failure", 1]
  ] as const)("recovers after SIGKILL at %s", async ([phase, mode, expectedCalls], { signal }) => {
    fixture.setCredentialFixture();
    const questions = fixture.questions();
    await fixture.writeFixtureDataset(questions);
    await fixture.prefillFirstQuestion();
    const authority = await fixture.writeAuthority(fixture.remainingKeys(questions));
    const roots = fixture.roots();
    running = startCatalogRefillCrashChild({
      mode, variant: fixture.variant, ...roots, authorityReceiptPath: authority.authority,
      targetSelectionReceiptPath: authority.selection
    }, phase, signal);
    const crashed = await running.closed;
    signal.throwIfAborted();

    expect(crashed, crashed.output).toMatchObject(process.platform === "win32"
      ? { code: 1, signal: null }
      : { code: null, signal: "SIGKILL" });
    expect(crashed.output).toContain(`CATALOG_REFILL_BOUNDARY:${phase}\n`);
    expect(fixture.controlArtifacts(".catalog-refill-resume.")).toEqual([]);
    const staleLock = join(roots.cacheRoot, ".extraction-fill.lock");
    expect(existsSync(staleLock)).toBe(true);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      expect(fixture.controlArtifacts(".catalog-refill-resume.")).toHaveLength(1);
      return providerBackedResponseResult(input, fixture.groundedResponse(input.userPrompt));
    });

    const result = await runExtractionFill({
      variant: fixture.variant, concurrency: 1, ...roots,
      authorityReceiptPath: authority.authority,
      targetSelectionReceiptPath: authority.selection,
      extractorFactory: () => ({ extract }), log: () => undefined
    });

    expect(extract).toHaveBeenCalledTimes(expectedCalls);
    expect(result.manifest).toMatchObject({ fill_status: "complete", cached_turns: 4 });
    expect(result.authorityTelemetry).toMatchObject({
      attempts: mode === "provider-failure" ? 3 : 2, successfulShards: 2
    });
    expect(fixture.controlArtifacts(".catalog-refill-resume.")).toEqual([]);
  }, 30_000);
}
