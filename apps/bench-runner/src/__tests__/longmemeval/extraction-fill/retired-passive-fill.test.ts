import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeExtractionFillOptions, runExtractionFill, type ExtractionFillOptions } from "../../../runs/extraction/extraction-fill.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, assertCurrentConversationGeneration } from "../../../runs/extraction/request-artifact.js";
import { preflightExtractionBatch } from "../../../runs/extraction/fill/batch-preflight.js";
import { preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";

const directories: string[] = [];
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });

const batchLimits = {
  maxJobs: 1, maxRequestsPerJob: 1, maxFileBytes: 1024, maxInputTokensPerJob: 1024,
  maxEnqueuedTokens: 1024, maxOutputTokens: 16, maxUsd: 0, inputUsdPerMillion: 0,
  outputUsdPerMillion: 0, deadlineMs: 1000, requestTimeoutMs: 100, maxPolls: 1
};

it.each([
  { ingestionMode: "lazy_field" },
  { semanticArtifactRoot: "/unused-retired-overlay" },
  { semanticTransport: () => { throw new Error("retired transport must not execute"); } },
  { semanticTransportPolicy: { kind: "retired-policy" } },
  { semanticMaxCalls: 0 },
  { semanticMaxFailures: 0 }
] satisfies Partial<ExtractionFillOptions>[])(
  "refuses every retired selector before cache reads, Batch recovery or preflight work: %j", async selector => {
    const root = mkdtempSync(join(tmpdir(), "retired-overlay-refusal-")); directories.push(root);
    // Using a regular file as the cache root makes an early cache lookup observable as ENOTDIR.
    const cacheRoot = join(root, "retained.json"), bytes = Buffer.from("unchanged retained evidence\n");
    writeFileSync(cacheRoot, bytes);
    const extractorFactory = vi.fn(() => { throw new Error("current producer must not be constructed"); });
    const options = { variant: "longmemeval_s" as const, sourcePacking: "session-statements" as const,
      cacheRoot, dataDir: join(root, "absent-data"), extractorFactory, ...selector };
    const refusal = { code: "UNAVAILABLE", message: expect.stringContaining("passive semantic overlays are retired") };
    await expect(runExtractionFill(options)).rejects.toMatchObject(refusal);
    for (const operation of ["status", "cancel", "recover"] as const) {
      await expect(runExtractionFill({ ...options, batch: { operation, limits: batchLimits } }))
        .rejects.toMatchObject(refusal);
    }
    await expect(preflightSourceSemanticInteractive({ ...options, sourcePacking: "complete-source",
      openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION })).rejects.toMatchObject(refusal);
    await expect(preflightExtractionBatch({ ...options, batch: { operation: "prepare", limits: batchLimits } }))
      .rejects.toMatchObject(refusal);
    expect(extractorFactory).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual(["retained.json"]);
    expect(readFileSync(cacheRoot)).toEqual(bytes);
  }
);

it("preserves current precomputed_full selection and retained Batch lifecycle without an overlay", () => {
  const options = { variant: "longmemeval_s" as const, sourcePacking: "session-statements" as const,
    ingestionMode: "precomputed_full" as const, semanticMaxCalls: undefined };
  expect(freezeExtractionFillOptions(options)).toEqual(options);
  expect(() => assertCurrentConversationGeneration(options)).not.toThrow();
  for (const operation of ["status", "cancel", "recover"]) {
    expect(() => assertCurrentConversationGeneration({ openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION }, operation))
      .not.toThrow();
  }
});

it.each([
  { variant: "longmemeval_s", sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION },
  { variant: "native_source_snapshot", sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION },
  { variant: "longmemeval_s", sourcePacking: "reference-eight" },
  { variant: "longmemeval_s", sourcePacking: "singleton" }
] satisfies Partial<ExtractionFillOptions>[])(
  "refuses new $variant $sourcePacking work before transport, dataset or retained-cache mutation", async generation => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "retired-passive-fill-")); directories.push(cacheRoot);
    const path = join(cacheRoot, "retained.json"), bytes = Buffer.from('{"retained":"opaque historical bytes"}\n');
    writeFileSync(path, bytes);
    const extractorFactory = vi.fn(() => { throw new Error("retired producer was constructed"); });
    await expect(runExtractionFill({ ...generation, cacheRoot, dataDir: join(cacheRoot, "absent-dataset"),
      extractorFactory })).rejects.toThrow("retired passive generation");
    expect(extractorFactory).not.toHaveBeenCalled();
    expect(readdirSync(cacheRoot)).toEqual(["retained.json"]);
    expect(readFileSync(path)).toEqual(bytes);
  }
);
