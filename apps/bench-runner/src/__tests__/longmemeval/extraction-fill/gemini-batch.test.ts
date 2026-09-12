import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireExtractionCacheWriteLease, withExtractionCacheWriteLease } from
  "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import { executeGeminiBatchOperation, accountedCost } from
  "../../../runs/extraction/fill/batch/executor.js";
import { createGeminiBatchHttp } from "../../../runs/extraction/fill/batch/http.js";
import { batchDigest, canonicalBatchPlan, prepareBatchJobs } from
  "../../../runs/extraction/fill/batch/plan.js";
import { decodeGeminiGenerateContent, encodeGeminiGenerateContent } from
  "../../../runs/extraction/fill/batch/native-codec.js";
import type { GeminiBatchInvocation, GeminiBatchPlan } from
  "../../../runs/extraction/fill/batch/contract.js";
import * as batchStore from "../../../runs/extraction/fill/batch/store.js";
import { buildOfficialApiExtractionRequest, stringifyOfficialApiExtractionRequest } from "@do-soul/alaya-soul";
import { createGardenHttpExtractor } from "../../../runs/compile-seed/compile-seed-http.js";

describe("durable Gemini Batch HTTP extraction", () => {
  let root: string;
  let server: Server;
  let endpoint: string;
  let creates: number;
  let uploads: string[];
  let displayName: string;
  let state: string;
  let output: string;
  let ambiguousCreate: boolean;
  let foreignOperation: boolean;
  let cancels: number;
  let metadataOverride: Record<string, unknown>;
  const admitted = new Set<string>();
  const reserve = vi.fn<GeminiBatchInvocation["reserveSubmission"]>(async (lines) =>
    Object.fromEntries(lines.map((line, index) => [line.key, index + 1])));
  const importer = vi.fn<GeminiBatchInvocation["importLine"]>(async ({ line }) => { admitted.add(line.key); });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "alaya-gemini-batch-"));
    creates = 0; uploads = []; displayName = ""; state = "BATCH_STATE_RUNNING";
    output = result("line-a") + result("line-b");
    ambiguousCreate = false; foreignOperation = false; cancels = 0;
    metadataOverride = {};
    admitted.clear(); reserve.mockClear(); importer.mockClear();
    importer.mockImplementation(async ({ line }) => { admitted.add(line.key); });
    server = createServer(async (req, res) => {
      const buffers: Buffer[] = [];
      for await (const chunk of req) buffers.push(Buffer.from(chunk));
      const body = Buffer.concat(buffers).toString("utf8");
      expect(req.headers["x-goog-api-key"]).toBe("synthetic-key");
      res.setHeader("content-type", "application/json");
      if (req.url === "/upload/v1beta/files") {
        expect(req.headers["x-goog-upload-protocol"]).toBe("resumable");
        res.setHeader("x-goog-upload-url", `${endpoint}/upload-session`);
        res.end("{}");
      } else if (req.url === "/upload-session") {
        uploads.push(body);
        res.end(JSON.stringify({ file: { name: "files/input" } }));
      } else if (req.url?.endsWith(":batchGenerateContent")) {
        creates += 1;
        const payload = JSON.parse(body);
        expect(payload.batch.inputConfig.fileName).toBe("files/input");
        displayName = payload.batch.displayName;
        if (ambiguousCreate) { req.socket.destroy(); return; }
        res.end(JSON.stringify({ name: "batches/job" }));
      } else if (req.url === "/v1beta/batches/job:cancel") {
        expect(req.method).toBe("POST"); cancels += 1; res.end("{}");
      } else if (req.url === "/v1beta/batches/job") {
        res.end(JSON.stringify({
          name: foreignOperation ? "batches/foreign" : "batches/job",
          metadata: {
            displayName, model: "models/gemini-2.5-flash-lite",
            inputConfig: { fileName: "files/input" }, state,
            ...(state === "BATCH_STATE_SUCCEEDED" ? { output: { responsesFile: "files/output" } } : {}),
            ...metadataOverride
          }
        }));
      } else if (req.url === "/download/v1beta/files/output:download?alt=media") {
        res.end(output);
      } else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server address missing");
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  async function run(operation: GeminiBatchInvocation["operation"], changes: Partial<GeminiBatchInvocation> = {}) {
    const lease = acquireExtractionCacheWriteLease(root);
    return withExtractionCacheWriteLease(lease, () => executeGeminiBatchOperation({
      operation, root, lease, plan: plan(),
      http: createGeminiBatchHttp({ endpoint, apiKey: "synthetic-key", timeoutMs: 1_000 }),
      importLine: importer, reserveSubmission: reserve, ...changes
    }));
  }

  function mutateJob(change: (job: import("../../../runs/extraction/fill/batch/contract.js").GeminiBatchJob) => void) {
    const path = join(root, `batch-state-${plan().identity}.json`);
    const state = JSON.parse(readFileSync(path, "utf8"));
    change(state.jobs[0]);
    writeFileSync(path, JSON.stringify(state));
  }

  it.each(["gemini-3.1-minimal-v1", "gemini-3.1-low-v1"] as const)("uploads the same %s normalized source schema body used by interactive extraction", async (requestProfile) => {
    const source = "I collect vintage postcards.";
    const userPrompt = stringifyOfficialApiExtractionRequest(
      buildOfficialApiExtractionRequest(source, [{ role: "user", content: source }])
    );
    const base = { ...plan(), model: "gemini-3.1-flash-lite", requestProfile };
    const line = { ...base.lines[0]!, userPrompt, requestSha256: batchDigest(userPrompt) };
    const sourcePlan = { ...base, lines: [line] };
    await run("prepare", { plan: sourcePlan });
    await run("submit", { plan: sourcePlan });
    const batchBody = JSON.parse(uploads[0]!.trim()).request;
    expect(batchBody.generationConfig.responseJsonSchema.properties.signals.items.additionalProperties).toBe(true);
    expect(batchBody.generationConfig.responseJsonSchema.properties.signals).not.toHaveProperty("maxItems");
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ candidates: [{
      finishReason: "STOP", content: { parts: [{ text: '{"signals":[]}' }] }
    }] }));
    await createGardenHttpExtractor({ model: base.model, requestProfile: base.requestProfile,
      providerUrl: "https://synthetic.invalid", apiKey: "synthetic-key" }, { fetch: fetchImpl })
      .extract({ systemPrompt: line.systemPrompt, userPrompt, retryMode: "disabled",
        maxOutputTokens: base.limits.maxOutputTokens, outputTokenField: "maxOutputTokens" });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual(batchBody);
    metadataOverride = { model: "models/gemini-3.1-flash-lite" };
    state = "BATCH_STATE_SUCCEEDED";
    output = result(line.key);
    const imported = await run("resume", { plan: sourcePlan });
    expect(imported.jobs[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 7, totalTokens: 17 });
    expect(accountedCost(imported.jobs[0]!, { plan: sourcePlan })).toBeCloseTo(
      (10 * sourcePlan.limits.inputUsdPerMillion + 7 * sourcePlan.limits.outputUsdPerMillion) / 1_000_000
    );
  });

  it("uploads exact files, creates once, resumes and admits shuffled results idempotently", async () => {
    await run("prepare");
    expect(creates).toBe(0);
    const submitted = await run("submit");
    expect(submitted.jobs[0]?.status).toBe("submitted");
    expect(uploads).toHaveLength(1);
    expect(batchDigest(uploads[0]!)).toBe(submitted.jobs[0]?.inputSha256);
    const wire = JSON.parse(uploads[0]!.split("\n")[0]!);
    expect(wire.request.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(reserve).toHaveBeenCalledTimes(1);
    await run("submit");
    expect(creates).toBe(1);
    state = "BATCH_STATE_SUCCEEDED";
    output = result("line-b") + result("line-a");
    const imported = await run("resume");
    expect([...admitted].sort()).toEqual(["line-a", "line-b"]);
    expect(imported.jobs[0]?.usage).toEqual({ inputTokens: 20, outputTokens: 14, totalTokens: 34 });
    expect(imported.jobs[0]?.usageUnknown).toBe(false);
    expect(importer.mock.calls[0]?.[0].provenance).toMatchObject({
      transport: "gemini-batch", job: "batches/job", inputFile: "files/input", finishReason: "STOP"
    });
    await run("import");
    expect(importer).toHaveBeenCalledTimes(2);
    expect(creates).toBe(1);
  });

  it("persists ambiguous acceptance and requires exact remote reconciliation without resubmission", async () => {
    const prepared = await run("prepare");
    ambiguousCreate = true;
    await expect(run("submit")).rejects.toThrow();
    const unknown = await run("status");
    expect(unknown.jobs[0]?.status).toBe("submission_unknown");
    expect(accountedCost(unknown.jobs[0]!, { plan: plan() })).toBeGreaterThan(0);
    await run("submit");
    expect(creates).toBe(1);
    foreignOperation = true;
    const reconcile = { localJob: prepared.jobs[0]!.id, remoteJob: "batches/job" };
    await expect(run("status", { reconcile })).rejects.toThrow("binding");
    foreignOperation = false;
    const reconciled = await run("status", { reconcile });
    expect(reconciled.jobs[0]?.status).toBe("running");
    expect(creates).toBe(1);
  });

  it("records unknown before a partially committed authority reservation", async () => {
    await run("prepare");
    await expect(run("submit", { reserveSubmission: async () => { throw new Error("reservation interrupted"); } }))
      .rejects.toThrow("reservation interrupted");
    const unknown = await run("status");
    expect(unknown.jobs[0]?.status).toBe("submission_unknown");
    await run("submit");
    expect(creates).toBe(0);
  });

  it("replays an interrupted shared admission without another provider dispatch", async () => {
    await run("prepare"); await run("submit"); state = "BATCH_STATE_SUCCEEDED";
    let interrupted = false;
    importer.mockImplementation(async ({ line }) => {
      admitted.add(line.key);
      if (!interrupted) { interrupted = true; throw new Error("after cache publication"); }
    });
    await expect(run("resume")).rejects.toThrow("after cache publication");
    await run("import");
    expect(admitted.size).toBe(2);
    expect(importer).toHaveBeenCalledTimes(3);
    expect(creates).toBe(1);
  });

  it.each(["duplicate", "foreign", "truncated"])("quarantines %s result inventory before any admission", async (fault) => {
    await run("prepare"); await run("submit"); state = "BATCH_STATE_SUCCEEDED";
    output = fault === "duplicate" ? result("line-a") + result("line-a")
      : fault === "foreign" ? result("foreign") : result("line-a").slice(0, -5);
    const imported = await run("resume");
    expect(importer).not.toHaveBeenCalled();
    expect(Object.values(imported.jobs[0]!.outcomes).map((value) => value.status))
      .toEqual(["quarantined", "quarantined"]);
    expect(imported.jobs[0]?.usageUnknown).toBe(true);
  });

  it("accepts a complete final JSONL record without a final newline", async () => {
    await run("prepare"); await run("submit"); state = "BATCH_STATE_SUCCEEDED";
    output = (result("line-a") + result("line-b")).trimEnd();
    await run("resume");
    expect(admitted.size).toBe(2);
  });

  it("preserves shared semantic quarantine without retrying permanent rejection", async () => {
    await run("prepare"); await run("submit"); state = "BATCH_STATE_SUCCEEDED";
    importer.mockImplementation(async () => ({ status: "quarantined", reason: "foreign assertion" }));
    const imported = await run("resume");
    expect(imported.jobs[0]?.outcomes["line-a"]).toEqual({ status: "quarantined", reason: "foreign assertion" });
    await run("import");
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("does not certify a missing or truncated line and retains unknown cost", async () => {
    await run("prepare"); await run("submit"); state = "BATCH_STATE_SUCCEEDED";
    output = result("line-a", "MAX_TOKENS");
    const recordLineOutcome = vi.fn();
    const imported = await run("resume", { recordLineOutcome });
    expect(imported.jobs[0]?.outcomes).toEqual({
      "line-a": { status: "quarantined", reason: "Gemini response is truncated or not complete" },
      "line-b": { status: "failed", reason: "missing provider result" }
    });
    expect(imported.jobs[0]?.usageUnknown).toBe(true);
    expect(accountedCost(imported.jobs[0]!, { plan: plan() })).toBeGreaterThan(0);
    expect(recordLineOutcome.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["line-a", "invalid", { inputTokens: 10, outputTokens: 7, totalTokens: 17 }],
      ["line-b", "missing", undefined]
    ]);
  });

  it("reports provider errors distinctly and leaves missing usage charged conservatively", async () => {
    await run("prepare"); await run("submit"); state = "BATCH_STATE_SUCCEEDED";
    output = JSON.stringify({ key: "line-a", error: { code: 429, message: "quota" } }) + "\n";
    const recordLineOutcome = vi.fn();
    const imported = await run("resume", { recordLineOutcome });
    expect(recordLineOutcome.mock.calls.map((call) => call.slice(0, 3)))
      .toEqual([["line-a", "provider_error", undefined], ["line-b", "missing", undefined]]);
    expect(imported.jobs[0]?.usageUnknown).toBe(true);
    expect(accountedCost(imported.jobs[0]!, { plan: plan() })).toBe(imported.jobs[0]?.costBoundUsd);
  });

  it("cancels known jobs and holds charges until terminal evidence", async () => {
    await run("prepare"); await run("submit");
    const cancelled = await run("cancel");
    expect(cancelled.jobs[0]?.status).toBe("cancel_requested");
    expect(cancels).toBe(1);
    expect(cancelled.jobs[0]?.usageUnknown).toBe(true);
    state = "BATCH_STATE_CANCELLED";
    const final = await run("status");
    expect(final.jobs[0]?.status).toBe("cancelled");
    expect(accountedCost(final.jobs[0]!, { plan: plan() })).toBeGreaterThan(0);
  });

  it("cancels unsubmitted work without a provider call", async () => {
    await run("prepare");
    const cancelled = await run("cancel");
    expect(cancelled.jobs[0]?.status).toBe("cancelled");
    await run("submit");
    expect(creates).toBe(0); expect(cancels).toBe(0);
  });

  it("retains cancellation intent across unknown create and cancels only the reconciled job", async () => {
    const prepared = await run("prepare"); ambiguousCreate = true;
    await expect(run("submit")).rejects.toThrow();
    const unknown = await run("cancel");
    expect(unknown.jobs[0]?.cancelRequested).toBe(true);
    expect(unknown.jobs[0]?.status).toBe("submission_unknown"); expect(cancels).toBe(0);
    await run("status", { reconcile: { localJob: prepared.jobs[0]!.id, remoteJob: "batches/job" } });
    expect(cancels).toBe(1); expect(creates).toBe(1);
  });

  it("refuses a concurrent root writer and changed request/model identity", async () => {
    await run("prepare");
    const lease = acquireExtractionCacheWriteLease(root);
    try { await expect(run("submit")).rejects.toThrow(); } finally { lease.release(); }
    const changed = { ...plan(), lines: [{ ...plan().lines[0]!, userPrompt: "foreign" }, plan().lines[1]!] };
    await expect(run("submit", { plan: changed })).rejects.toThrow("drift");
    expect(creates).toBe(0);
  });

  it("retains remote work as unresolved at poll bounds", async () => {
    const limited = { ...plan(), limits: { ...plan().limits, maxPolls: 1 } };
    await run("prepare", { plan: limited }); await run("submit", { plan: limited });
    await run("status", { plan: limited });
    const stopped = await run("status", { plan: limited });
    expect(stopped.jobs[0]?.status).toBe("running");
    expect(stopped.jobs[0]?.polls).toBe(1);
    expect(stopped.jobs[0]?.diagnostic).toContain("unresolved");
  });

  it.each(["model", "inputFile", "displayName"])("rejects conflicting %s identity on ordinary polling", async (field) => {
    await run("prepare"); await run("submit");
    metadataOverride = field === "inputFile" ? { inputConfig: { fileName: "files/foreign" } }
      : { [field]: "foreign" };
    await expect(run("status")).rejects.toThrow("binding mismatch");
    expect(creates).toBe(1);
  });

  it("rejects an unsubmitted state carrying remote acceptance evidence", async () => {
    await run("prepare"); await run("submit");
    mutateJob((job) => { job.status = "prepared"; });
    await expect(run("submit")).rejects.toThrow("contradicts submission");
    expect(creates).toBe(1);
  });

  it("rejects known usage without evidence and mutated attempt ordinals", async () => {
    await run("prepare"); await run("submit");
    mutateJob((job) => { job.usageUnknown = false; });
    await expect(run("status")).rejects.toThrow("known usage lacks retained evidence");
    mutateJob((job) => { job.usageUnknown = true; job.attemptOrdinals = { "line-a": 99, "line-b": 100 }; });
    await expect(run("status")).rejects.toThrow("attempt receipt binding mismatch");
  });

  it("rederives root accounting from retained output instead of mutable zero usage", async () => {
    await run("prepare"); await run("submit"); state = "BATCH_STATE_SUCCEEDED";
    await run("resume");
    mutateJob((job) => { job.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }; job.usageUnknown = false; });
    const reopened = await run("status");
    expect(reopened.jobs[0]?.usage).toEqual({ inputTokens: 20, outputTokens: 14, totalTokens: 34 });
    expect(accountedCost(reopened.jobs[0]!, { plan: plan() })).toBeGreaterThan(0);
  });

  it("recovers retained output after a state-write interruption with downloads forbidden", async () => {
    await run("prepare"); await run("submit"); state = "BATCH_STATE_SUCCEEDED";
    const original = batchStore.saveBatchState;
    let crash = true;
    vi.spyOn(batchStore, "saveBatchState").mockImplementation((lease, plan, state) => {
      if (crash && state.jobs[0]?.rawOutputSha256 !== undefined) {
        crash = false; throw new Error("interrupted before digest publication");
      }
      original(lease, plan, state);
    });
    await expect(run("resume")).rejects.toThrow("before digest publication");
    const http = createGeminiBatchHttp({ endpoint, apiKey: "synthetic-key", timeoutMs: 1_000 });
    await run("import", { http: { ...http, download: async () => { throw new Error("download forbidden"); } } });
    expect(admitted.size).toBe(2); expect(creates).toBe(1);
  });

  it("reopens an accepted create whose durable witness publication failed and reconciles without resubmission", async () => {
    const prepared = await run("prepare");
    const original = batchStore.publishArtifact;
    vi.spyOn(batchStore, "publishArtifact").mockImplementation((lease, name, text) => {
      if (name.startsWith("batch-created-")) throw new Error("create witness publication interrupted");
      return original(lease, name, text);
    });
    await expect(run("submit")).rejects.toThrow("witness publication interrupted");
    const unknown = await run("status");
    expect(unknown.jobs[0]?.status).toBe("submission_unknown");
    await run("status", { reconcile: { localJob: prepared.jobs[0]!.id, remoteJob: "batches/job" } });
    expect(creates).toBe(1);
  });

  it("allows an explicit failed-unit window while retaining root spend and preventing overlap", async () => {
    await run("prepare"); await run("submit");
    const retry: GeminiBatchPlan = { ...plan(), identity: "c".repeat(64), lines: [plan().lines[1]!] };
    await expect(run("prepare", { plan: retry })).rejects.toThrow("overlaps pending");
    state = "BATCH_STATE_SUCCEEDED";
    output = result("line-a") + JSON.stringify({ key: "line-b", error: { code: 500 } }) + "\n";
    const initial = await run("resume");
    const initialCharge = accountedCost(initial.jobs[0]!, { plan: plan() });
    const retryBound = prepareBatchJobs(retry)[0]!.costBoundUsd;
    const tight = { ...retry, limits: { ...retry.limits, maxUsd: initialCharge + retryBound / 2 } };
    await run("prepare", { plan: tight });
    await expect(run("submit", { plan: tight })).rejects.toThrow("spend ceiling");
    expect(creates).toBe(1);
    await run("cancel", { plan: tight });
    const authorized = { ...retry, identity: "d".repeat(64) };
    await run("prepare", { plan: authorized }); await run("submit", { plan: authorized });
    output = result("line-b");
    const repaired = await run("resume", { plan: authorized });
    expect(repaired.jobs[0]?.outcomes["line-b"]?.status).toBe("admitted");
    expect(creates).toBe(2);
    const preserved = await run("status");
    expect(preserved.jobs[0]?.outcomes["line-b"]?.status).toBe("failed");
  });
});

describe("Gemini request packing and usage", () => {
  it("conserves units when jobs regroup and ignores input line order", () => {
    const source = plan();
    const reordered = { ...source, lines: [...source.lines].reverse() };
    expect(canonicalBatchPlan(reordered)).toEqual(canonicalBatchPlan(source));
    const split = prepareBatchJobs({ ...source, limits: { ...source.limits, maxRequestsPerJob: 1 } });
    expect(split).toHaveLength(2);
    expect(split.flatMap((job) => job.lineKeys)).toEqual(["line-a", "line-b"]);
  });

  it("rejects quota and spend overflow before transport", () => {
    const source = plan();
    expect(() => prepareBatchJobs({ ...source, limits: { ...source.limits, maxFileBytes: 1 } })).toThrow("cap");
    expect(() => prepareBatchJobs({ ...source, limits: { ...source.limits, maxUsd: 0 } })).toThrow("spend");
    expect(() => prepareBatchJobs({ ...source, limits: { ...source.limits, maxRequestsPerJob: 1, maxJobs: 1 } }))
      .toThrow("job cap");
  });

  it("rejects unsupported thinking settings and keeps missing usage unknown", () => {
    expect(() => encodeGeminiGenerateContent(plan().lines[0]!, {
      model: "gemini-3-pro", requestProfile: "gemini-2.5-nonthinking-v1", maxOutputTokens: 100
    })).toThrow("unsupported");
    expect(() => encodeGeminiGenerateContent(plan().lines[0]!, {
      model: "gemini-2.5-flash-lite", requestProfile: "gemini-2.5-nonthinking-v1", maxOutputTokens: 65_537
    })).toThrow("unsupported");
    const response = JSON.parse(result("line-a")).response;
    delete response.usageMetadata;
    expect(decodeGeminiGenerateContent(response).usage).toBeUndefined();
    for (const field of ["maxUsd", "maxOutputTokens", "inputUsdPerMillion"] as const) {
      const missingCap = structuredClone(plan());
      delete (missingCap.limits as { -readonly [K in keyof GeminiBatchPlan["limits"]]?: number })[field];
      expect(() => canonicalBatchPlan(missingCap)).toThrow("missing or unsupported");
    }
  });
});

function result(key: string, finishReason = "STOP"): string {
  return JSON.stringify({ key, response: {
    candidates: [{ finishReason, content: { parts: [{ text: '{"signals":[{"content":"synthetic"}]}' }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 17 }
  } }) + "\n";
}

function plan(): GeminiBatchPlan {
  return {
    identity: "a".repeat(64), model: "gemini-2.5-flash-lite", requestProfile: "gemini-2.5-nonthinking-v1",
    lines: ["a", "b"].map((suffix) => ({
      key: `line-${suffix}`, unitKeys: [`unit-${suffix}`], requestSha256: suffix.repeat(64),
      systemPrompt: "Extract grounded signals.", userPrompt: `Source ${suffix}.`
    })),
    limits: {
      maxJobs: 2, maxRequestsPerJob: 2, maxFileBytes: 100_000, maxInputTokensPerJob: 10_000,
      maxEnqueuedTokens: 20_000, maxOutputTokens: 100, maxUsd: 1,
      inputUsdPerMillion: 1, outputUsdPerMillion: 2,
      deadlineMs: 60_000, requestTimeoutMs: 1_000, maxPolls: 10
    }
  };
}
