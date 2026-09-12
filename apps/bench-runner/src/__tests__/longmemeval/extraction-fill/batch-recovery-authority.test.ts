import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from
  "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from
  "../../../runs/extraction/authority/receipt.js";
import * as attemptLedger from "../../../runs/extraction/authority/attempt-ledger.js";
import { accountedCost } from "../../../runs/extraction/fill/batch/executor.js";
import { peelExtractionBatchFlags } from "../../../cli/extraction-fill/batch-flags.js";
import type { GeminiBatchHttp, GeminiBatchLimits, GeminiBatchOperation } from
  "../../../runs/extraction/fill/batch/contract.js";
import { buildAuthorityQuestion, buildGroundedSignalResponse, EXTRACTION_FILL_VARIANT,
  registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots));
afterEach(() => vi.restoreAllMocks());

type ResultKind = "valid" | "error" | "missing" | "truncated" | "foreign-quote" | "substring";

async function setup(questionCount = 1) {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gemini-2.5-flash-lite");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "gemini-2.5-nonthinking-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  await writeDataset(Array.from({ length: questionCount }, (_, index) =>
    buildAuthorityQuestion(`q${index}`, `alpha${index}`, `decoy${index}`)));
  const inspection = await inspectExtractionAuthority({ variant: EXTRACTION_FILL_VARIANT,
    cacheRoot, dataDir, pinnedMetaRoot, revision: readCurrentExtractionAuthorityRevision(), action: "fill" });
  const receipt = createExtractionAuthorityReceipt({ action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 512 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100_000 },
    inspection: { writerLock: inspection.writerLock, disk: inspection.disk,
      credentialStatus: inspection.credentialStatus, modelReadiness: inspection.modelReadiness } });
  const receiptPath = join(cacheRoot, "authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  const limits: GeminiBatchLimits = { maxJobs: 10, maxRequestsPerJob: 100, maxFileBytes: 1_000_000,
    maxInputTokensPerJob: 1_000_000, maxEnqueuedTokens: 1_000_000, maxOutputTokens: 512,
    maxUsd: receipt.price.estimated_upper_usd, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    deadlineMs: 60_000, requestTimeoutMs: 5_000, maxPolls: 10 };
  const inputs = new Map<string, string>();
  const jobs = new Map<string, { model: string; inputFile: string; displayName: string }>();
  let next = 0;
  const provider = { results: ["valid", "valid"] as ResultKind[], state: "SUCCEEDED", downloads: 0, malformed: false };
  const http: GeminiBatchHttp = {
    endpoint: "https://fixture-provider.invalid",
    upload: async (raw) => { const name = `files/input${++next}`; inputs.set(name, raw); return name; },
    create: async (model, inputFile, displayName) => {
      const name = `batches/job${next}`; jobs.set(name, { model, inputFile, displayName }); return { name };
    },
    get: async (name) => {
      const job = jobs.get(name)!;
      return { name, done: provider.state !== "RUNNING", metadata: { state: `BATCH_STATE_${provider.state}`,
        model: job.model, displayName: job.displayName, inputConfig: { fileName: job.inputFile } },
        ...(provider.state === "SUCCEEDED" ? { response: { responsesFile: `files/output${name.slice(-1)}` } } : {}) };
    },
    cancel: async () => undefined,
    download: async (name) => {
      provider.downloads += 1;
      const lines = inputs.get(`files/input${name.slice(-1)}`)!.trim().split("\n");
      const output = lines.map((line, index) => {
        const request = JSON.parse(line);
        const kind = provider.results[index] ?? "valid";
        if (kind === "missing") return "";
        if (kind === "error") return JSON.stringify({ key: request.key, error: { code: 500, message: "synthetic" } });
        const raw = JSON.parse(buildGroundedSignalResponse(request.request.contents[0].parts[0].text));
        if (kind === "foreign-quote") raw.signals[0].matched_text = "I completed a foreign activity.";
        if (kind === "substring") raw.signals[0].matched_text = raw.signals[0].matched_text.replace(/^I /u, "");
        return JSON.stringify({ key: request.key, response: {
          candidates: [{ finishReason: kind === "truncated" ? "MAX_TOKENS" : "STOP",
            content: { parts: [{ text: JSON.stringify(raw) }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
        } });
      }).filter(Boolean).join("\n");
      return provider.malformed ? output.slice(0, -2) : output;
    }
  };
  const run = (operation: GeminiBatchOperation, window = "initial", requestLimit?: number) => runExtractionFill({
    variant: EXTRACTION_FILL_VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
    authorityReceiptPath: receiptPath, batch: { operation, limits, window,
      ...(requestLimit === undefined ? {} : { requestLimit }) }, batchHttp: http, log: () => undefined
  });
  return { run, provider, jobs, limits };
}

it("bounds fresh windows deterministically and preserves saved selection until the full scope is cached", async () => {
  const { run } = await setup(2);
  const all = await run("prepare", "inventory");
  const keys = all.batchState!.jobs.flatMap((job) => job.lineKeys).sort();
  expect(keys).toHaveLength(4);
  await run("cancel", "inventory");
  const canary = await run("prepare", "canary", 1);
  expect(canary.batchState!.jobs.flatMap((job) => job.lineKeys)).toEqual(keys.slice(0, 1));
  const path = join(cacheRoot, "gemini-batch-plan-canary.json");
  const originalPlan = readFileSync(path, "utf8");
  await run("submit", "canary", 1);
  const partial = await run("resume", "canary", 1);
  expect(partial.coverage).toBe(0.25);
  expect(partial.manifest.fill_status).not.toBe("complete");
  const replay = await run("import", "canary", 1);
  expect(replay.batchState!.jobs.flatMap((job) => job.lineKeys)).toEqual(keys.slice(0, 1));
  expect(readFileSync(path, "utf8")).toBe(originalPlan);
  await expect(run("prepare", "canary", 2)).rejects.toThrow("settings changed");
  await expect(run("import", "canary")).rejects.toThrow("settings changed");
  const bulk = await run("prepare", "bulk", 2);
  expect(bulk.batchState!.jobs.flatMap((job) => job.lineKeys)).toEqual(keys.slice(1, 3));
  await run("submit", "bulk", 2); await run("resume", "bulk", 2);
  await run("prepare", "final", 2); await run("submit", "final", 2);
  const complete = await run("resume", "final", 2);
  expect(complete.coverage).toBe(1);
  expect(complete.manifest.fill_status).toBe("complete");
  expect(complete.authorityTelemetry).toMatchObject({ attempts: 4, successfulShards: 4 });
});

it("parses bounded request windows and rejects invalid or repeated CLI limits", async () => {
  const { limits, run } = await setup();
  const path = join(cacheRoot, "limits.json");
  writeFileSync(path, JSON.stringify(limits));
  const base = ["--batch-operation", "prepare", "--batch-limits", path];
  expect(peelExtractionBatchFlags([...base, "--batch-request-limit=32", "--batch-window", "canary", "remaining"]))
    .toMatchObject({ rest: ["remaining"], batch: { requestLimit: 32, window: "canary" } });
  for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992"]) {
    expect(() => peelExtractionBatchFlags([...base, "--batch-request-limit", value])).toThrow("positive integer");
  }
  expect(() => peelExtractionBatchFlags([...base, "--batch-request-limit=1", "--batch-request-limit=2"]))
    .toThrow("only once");
  await expect(run("prepare", "invalid", 0)).rejects.toThrow("positive safe integer");
});

it("settles mixed successful, provider-error, missing and truncated lines with conservative unknown charges", async () => {
  const { run, provider, limits } = await setup(2);
  provider.results = ["valid", "error", "missing", "truncated"];
  await run("prepare"); await run("submit");
  const imported = await run("resume");
  const job = imported.batchState!.jobs[0]!;
  expect(Object.values(job.outcomes).map((outcome) => outcome.status).sort())
    .toEqual(["admitted", "failed", "failed", "quarantined"]);
  expect(imported.authorityTelemetry).toMatchObject({ attempts: 4, pendingKeys: [], unresolvedAttempts: [],
    telemetry: { inputTokens: 20, outputTokens: 40, totalTokens: 60, usageUnavailableRequests: 2,
      unresolvedTransportAttempts: 0, usageUnknownAttempts: 2 } });
  expect(job.usageUnknown).toBe(true);
  expect(accountedCost(job, { plan: { identity: "a".repeat(64), model: "gemini-2.5-flash-lite",
    requestProfile: "gemini-2.5-nonthinking-v1", lines: [], limits } })).toBe(job.costBoundUsd);
});

it("rejects a foreign quote before cache publication while admitting a valid source substring", async () => {
  const { run, provider } = await setup();
  provider.results = ["foreign-quote", "substring"];
  await run("prepare"); await run("submit");
  const imported = await run("resume");
  expect(Object.values(imported.batchState!.jobs[0]!.outcomes).map((outcome) => outcome.status).sort())
    .toEqual(["admitted", "quarantined"]);
  expect(imported.authorityTelemetry?.successfulShards).toBe(1);
  expect(imported.coverage).toBe(0.5);
});

it("reimporting an older quarantined window cannot settle a newer same-key retry reservation", async () => {
  const { run, provider } = await setup();
  provider.results = ["foreign-quote", "valid"];
  await run("prepare"); await run("submit");
  const initial = await run("resume");
  const failed = Object.entries(initial.batchState!.jobs[0]!.outcomes).find(([, value]) => value.status === "quarantined")![0];
  await run("prepare", "repair");
  provider.state = "RUNNING";
  const retry = await run("submit", "repair");
  const reserved = retry.authorityTelemetry!.unresolvedAttempts;
  expect(reserved).toEqual([{ cacheKey: failed, attemptOrdinal: 3 }]);
  const oldImport = await run("import");
  expect(oldImport.authorityTelemetry?.unresolvedAttempts).toEqual(reserved);
  expect(oldImport.authorityTelemetry?.pendingKeys).toEqual([failed]);
  expect(oldImport.authorityTelemetry?.telemetry).toEqual(retry.authorityTelemetry?.telemetry);
});

it("restarts after ledger settlement before job outcome persistence without recounting usage", async () => {
  const { run } = await setup();
  await run("prepare"); await run("submit");
  const original = attemptLedger.openExtractionAttemptLedger;
  let crash = true;
  vi.spyOn(attemptLedger, "openExtractionAttemptLedger").mockImplementation((input) => {
    const ledger = original(input);
    return { ...ledger, recordTransportOutcome: (...args) => {
      const settled = ledger.recordTransportOutcome(...args);
      if (crash) { crash = false; throw new Error("interrupted after durable settlement"); }
      return settled;
    } };
  });
  await expect(run("resume")).rejects.toThrow("interrupted after durable settlement");
  const resumed = await run("import");
  expect(resumed.authorityTelemetry).toMatchObject({ attempts: 2, successfulShards: 2, unresolvedAttempts: [],
    telemetry: { inputTokens: 20, outputTokens: 40, totalTokens: 60, usageUnavailableRequests: 0 } });
});

it.each(["FAILED", "CANCELLED", "EXPIRED"])("settles %s jobs without output as failed work with unknown spend", async (state) => {
  const { run, provider } = await setup();
  await run("prepare"); await run("submit"); provider.state = state;
  const finished = await run("resume");
  expect(finished.authorityTelemetry).toMatchObject({ pendingKeys: [], unresolvedAttempts: [],
    telemetry: { usageUnavailableRequests: 2, usageUnknownAttempts: 2 } });
  expect(Object.values(finished.batchState!.jobs[0]!.outcomes).every((outcome) => outcome.status === "failed")).toBe(true);
  expect(finished.batchState!.jobs[0]?.usageUnknown).toBe(true);
  expect(provider.downloads).toBe(0);
});

it("quarantines malformed output while settling old bound attempts so an explicit retry can commit", async () => {
  const { run, provider } = await setup();
  provider.malformed = true;
  await run("prepare"); await run("submit");
  const malformed = await run("resume");
  expect(malformed.authorityTelemetry?.unresolvedAttempts).toEqual([]);
  expect(malformed.authorityTelemetry?.telemetry.usageUnknownAttempts).toBe(2);
  await run("prepare", "repair"); await run("submit", "repair"); provider.malformed = false;
  const repaired = await run("resume", "repair");
  expect(repaired.authorityTelemetry?.successfulShards).toBe(2);
});

it("blocks overlapping retries until a terminal job without output closes its local attempts", async () => {
  const { run, provider, jobs } = await setup();
  await run("prepare"); await run("submit"); provider.state = "FAILED";
  await run("status");
  await expect(run("prepare", "repair")).rejects.toThrow("overlaps pending");
  await expect(run("submit", "repair")).rejects.toThrow("not prepared");
  expect(jobs.size).toBe(1);
  const closed = await run("import");
  expect(closed.authorityTelemetry?.pendingKeys).toEqual([]);
  expect(closed.authorityTelemetry?.unresolvedAttempts).toEqual([]);
  await run("prepare", "repair");
  const pending = await run("submit", "repair");
  const oldImport = await run("import");
  expect(oldImport.authorityTelemetry?.pendingKeys).toEqual(pending.authorityTelemetry?.pendingKeys);
  expect(oldImport.authorityTelemetry?.unresolvedAttempts.map((attempt) => attempt.attemptOrdinal)).toEqual([3, 4]);
  provider.state = "SUCCEEDED";
  const repaired = await run("resume", "repair");
  expect(repaired.authorityTelemetry).toMatchObject({ attempts: 4, successfulShards: 2,
    pendingKeys: [], unresolvedAttempts: [] });
});

it("atomically releases the terminal attempt slot before an interrupted callback can strand it", async () => {
  const { run, provider } = await setup();
  await run("prepare"); await run("submit"); provider.state = "FAILED";
  const original = attemptLedger.openExtractionAttemptLedger;
  let crash = true;
  let interrupted: attemptLedger.ExtractionAttemptLedgerSnapshot | undefined;
  vi.spyOn(attemptLedger, "openExtractionAttemptLedger").mockImplementation((input) => {
    const ledger = original(input);
    return { ...ledger, recordTransportOutcome: (...args) => {
      const settled = ledger.recordTransportOutcome(...args);
      if (crash) {
        crash = false; interrupted = ledger.snapshot();
        throw new Error("interrupted after terminal ledger publication");
      }
      return settled;
    } };
  });
  await expect(run("resume")).rejects.toThrow("after terminal ledger publication");
  expect(interrupted?.pendingKeys).toHaveLength(1);
  expect(interrupted?.pendingKeys).toEqual(interrupted?.unresolvedAttempts.map((attempt) => attempt.cacheKey));
  expect(interrupted?.telemetry.usageUnknownAttempts).toBe(2);
  const reopened = await run("import");
  expect(reopened.authorityTelemetry).toMatchObject({ attempts: 2, pendingKeys: [], unresolvedAttempts: [],
    telemetry: { usageUnavailableRequests: 2, usageUnknownAttempts: 2,
      terminalRetryClassifications: { failure_non_retryable_response: 2 } } });
});
