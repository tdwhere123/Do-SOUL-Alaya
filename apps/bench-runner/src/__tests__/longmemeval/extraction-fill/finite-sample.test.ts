import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT, buildOfficialApiExtractionRequests } from "@do-soul/alaya-soul";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from
  "../../../runs/extraction/authority/inspection.js";
import { createExtractionSampleScope, assertSampleKeys } from
  "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, readExtractionAuthorityReceipt,
  writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { createFreshRetiredSourceRebuildTargetSelection,
  writeExtractionTargetSelectionReceipt } from "../../../runs/extraction/authority/target-selection/receipt.js";
import { computeExtractionTurnCacheKeys } from "../../../runs/compile-seed/cache/cache-key.js";
import { cacheFilePath, inspectCachedExtraction, inspectCachedRawExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";
import { createCompileSeedRunner } from "../../../runs/compile-seed.js";
import { runAuthorizeExtractionCommand } from "../../../cli/extraction-authority/command.js";
import { readExtractionCacheManifestIdentity } from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { runExtractionFill, type ExtractionFillOptions } from "../../../runs/extraction/extraction-fill.js";
import { inspectTurnContentKeySpace } from "../../../runs/extraction/turn-contents.js";
import { computeExtractionKeySetSha256 } from "../../../runs/extraction/content-closure.js";
import { createGeminiBatchHttp } from "../../../runs/extraction/fill/batch/http.js";
import type { GeminiBatchLimits, GeminiBatchOperation } from "../../../runs/extraction/fill/batch/contract.js";
import { buildExtractionFillQuestion, buildGroundedInterpretationResponse,
  registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";

let roots: { cacheRoot: string; dataDir: string; pinnedMetaRoot: string };
const writeDataset = registerExtractionFillHooks((value) => { roots = value; }, "longmemeval_s");
let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function sampleScenario() {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gemini-3.1-flash-lite");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "gemini-3.1-low-v1");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_SOURCE_PACKING", "");
  const source = Array.from({ length: 18 }, (_, i) => `I recorded durable detail number ${i + 1}.`).join(" ");
  const questions = Array.from({ length: 100 }, (_, i) =>
    buildExtractionFillQuestion(`q${i}`, source, "I enjoy gardening."));
  questions[0] = { ...questions[0]!,
    haystack_session_ids: [...questions[0]!.haystack_session_ids, "assistant-only"],
    haystack_dates: [...questions[0]!.haystack_dates, "2025-12-01"],
    haystack_sessions: [...questions[0]!.haystack_sessions, [{ role: "assistant", content: "Acknowledged." }]]
  };
  await writeDataset(questions);
  const inspectInput = { ...roots, variant: "longmemeval_s" as const, limit: 100,
    revision: readCurrentExtractionAuthorityRevision(), action: "sample" as const,
    sourcePacking: "singleton" as const };
  const inspection = await inspectExtractionAuthority(inspectInput);
  const turns = inspectTurnContentKeySpace(questions, "singleton");
  const turn = turns.distinctExtractionTurns.find((value) => value.turnContent.includes("detail number"))!;
  const requests = buildOfficialApiExtractionRequests(turn.turnContent, turn.turnMessages, "singleton");
  const keys = computeExtractionTurnCacheKeys("gemini-3.1-flash-lite", "gemini-3.1-low-v1",
    OFFICIAL_API_SYSTEM_PROMPT, turn, "singleton");
  const selected = keys.slice(0, 8);
  const scope = createExtractionSampleScope(selected, inspection);
  rmSync(roots.cacheRoot, { recursive: true });
  const selection = createFreshRetiredSourceRebuildTargetSelection({ cacheRoot: roots.cacheRoot,
    operator: "fixture-operator", observation: inspection.observation });
  const receipt = createExtractionAuthorityReceipt({ action: "sample", sampleScope: scope,
    observation: inspection.observation, inspection,
    targetSelectionDigest: selection.receipt_digest,
    outputTokenCap: { field: "maxOutputTokens", value: 512 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100_000 } });
  const receiptPath = join(roots.cacheRoot, "..", "sample-authority.json");
  const selectionPath = join(roots.cacheRoot, "..", "target-selection.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  writeExtractionTargetSelectionReceipt(selectionPath, selection);
  const limits: GeminiBatchLimits = { maxJobs: 1, maxRequestsPerJob: selected.length,
    maxFileBytes: 1_000_000, maxInputTokensPerJob: 1_000_000, maxEnqueuedTokens: 1_000_000,
    maxOutputTokens: 512, maxUsd: receipt.price.estimated_upper_usd,
    inputUsdPerMillion: 1, outputUsdPerMillion: 2, deadlineMs: 60_000,
    requestTimeoutMs: 1_000, maxPolls: 10 };
  const provider = await startProvider();
  const run = (operation: GeminiBatchOperation, changes: Partial<ExtractionFillOptions> = {}) =>
    runExtractionFill({ ...roots, variant: "longmemeval_s", limit: 100,
      authorityReceiptPath: receiptPath, targetSelectionReceiptPath: selectionPath,
      batch: { operation, limits, window: "sample" }, batchHttp: provider.http,
      log: () => undefined, ...changes });
  return { inspection, scope, receipt, receiptPath, selection, selectionPath, requests, keys, selected,
    turns, limits, provider, run };
}

async function startProvider() {
  let endpoint = "";
  const state = { creates: 0, uploads: [] as string[], ambiguous: false,
    finished: false, displayName: "", quarantine: false, empty: false };
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    res.setHeader("content-type", "application/json");
    if (req.url === "/upload/v1beta/files") {
      res.setHeader("x-goog-upload-url", `${endpoint}/upload-session`); res.end("{}");
    } else if (req.url === "/upload-session") {
      state.uploads.push(body); res.end(JSON.stringify({ file: { name: "files/input" } }));
    } else if (req.url?.endsWith(":batchGenerateContent")) {
      state.creates += 1; state.displayName = JSON.parse(body).batch.displayName;
      if (state.ambiguous) { req.socket.destroy(); return; }
      res.end(JSON.stringify({ name: "batches/job" }));
    } else if (req.url === "/v1beta/batches/job") {
      res.end(JSON.stringify({ name: "batches/job", metadata: {
        displayName: state.displayName, model: "models/gemini-3.1-flash-lite",
        inputConfig: { fileName: "files/input" },
        state: state.finished ? "BATCH_STATE_SUCCEEDED" : "BATCH_STATE_RUNNING",
        ...(state.finished ? { output: { responsesFile: "files/output" } } : {})
      } }));
    } else if (req.url === "/download/v1beta/files/output:download?alt=media") {
      res.end(state.uploads[0]!.trim().split("\n").reverse().map((line) => {
        const input = JSON.parse(line);
        const raw = state.quarantine ? '{"signals":[{}]}' : state.empty ? '{"interpretations":[]}'
          : buildGroundedInterpretationResponse(input.request.contents[0].parts[0].text);
        return JSON.stringify({ key: input.key, response: {
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: raw }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
        } });
      }).join("\n"));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture address unavailable");
  endpoint = `http://127.0.0.1:${address.port}`;
  return { state, http: createGeminiBatchHttp({ endpoint, apiKey: "fixture", timeoutMs: 1_000 }) };
}

it("binds a finite native sample to the complete inventory and retains the 18-way source plan", async () => {
  const fixture = await sampleScenario();
  expect(fixture.requests).toHaveLength(18);
  expect(fixture.requests.slice(0, 8).map((request) => [request.batch_index, request.batch_count,
    request.source_assertions[0]!.assertion_id])).toEqual(Array.from({ length: 8 }, (_, i) => [i, 18, i + 1]));
  expect(new Set(fixture.requests.map((request) => request.source_corpus_identity)).size).toBe(1);
  expect(fixture.inspection.observation.inventory.missingTurns).toBe(20);
  expect(fixture.receipt.limits).toMatchObject({ starting_missing: 20,
    maximum_attempts: 8, successful_shard_ceiling: 8 });
  expect(readExtractionAuthorityReceipt(fixture.receiptPath)).toEqual(fixture.receipt);
  for (const keys of [[], [...fixture.selected, fixture.selected[0]!], ["f".repeat(64)]]) {
    expect(() => createExtractionSampleScope(keys, fixture.inspection)).toThrow();
  }
  const empty = fixture.inspection.missingKeys.find((key) => !fixture.inspection.nonemptyKeys!.includes(key))!;
  expect(empty).toBeDefined();
  expect(() => createExtractionSampleScope([empty], fixture.inspection)).toThrow(/nonempty/u);
  expect(() => createExtractionAuthorityReceipt({ action: "sample",
    sampleScope: { keys: [empty], key_set_sha256: computeExtractionKeySetSha256([empty]) },
    observation: fixture.inspection.observation, inspection: fixture.inspection,
    targetSelectionDigest: fixture.selection.receipt_digest,
    outputTokenCap: { field: "maxOutputTokens", value: 512 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 100_000 }
  })).toThrow(/nonempty/u);
  const proposedPath = join(roots.cacheRoot, "..", "proposed-keys.json");
  const issuedPath = join(roots.cacheRoot, "..", "issued-sample.json");
  writeFileSync(proposedPath, JSON.stringify(fixture.selected));
  const args = ["--variant", "s", "--limit", "100", "--data-dir", roots.dataDir,
    "--pinned-meta-root", roots.pinnedMetaRoot, "--extraction-cache-root", roots.cacheRoot,
    "--extraction-source-packing", "singleton", "--extraction-action", "sample",
    "--extraction-sample-keys", proposedPath, "--extraction-target-selection", fixture.selectionPath,
    "--extraction-receipt-out", issuedPath, "--extraction-output-token-cap", "512",
    "--extraction-output-token-field", "maxOutputTokens", "--extraction-input-price-usd-per-million", "1",
    "--extraction-output-price-usd-per-million", "2", "--extraction-max-input-tokens", "100000",
    "--extraction-disk-floor-bytes", "0"];
  expect(await runAuthorizeExtractionCommand(args)).toBe(0);
  const issued = readExtractionAuthorityReceipt(issuedPath);
  expect(issued.sample_scope).toEqual(fixture.scope);
  expect(issued.lineage_digest).toBe(fixture.receipt.lineage_digest);
  writeFileSync(proposedPath, JSON.stringify([empty]));
  expect(await runAuthorizeExtractionCommand(args)).toBe(2);
  for (const keys of [fixture.selected.slice(0, 7), [...fixture.selected, fixture.keys[8]!],
    [...fixture.selected.slice(0, 7), fixture.keys[8]!], [...fixture.selected.slice(0, 7), fixture.selected[0]!]]) {
    expect(() => assertSampleKeys(fixture.scope, keys)).toThrow("exactly");
  }
  const prepared = await fixture.run("prepare", { sourcePacking: "singleton" });
  expect(prepared.manifest).toMatchObject({ schema_version: 4, source_packing: "singleton", expected_turns: 20 });
  expect(prepared.batchState!.jobs).toHaveLength(1);
  expect([...prepared.batchState!.jobs[0]!.lineKeys].sort()).toEqual([...fixture.selected].sort());
  expect(fixture.provider.state.creates).toBe(0);
  await expect(fixture.run("prepare", { sourcePacking: "reference-eight" })).rejects.toThrow(/packing/iu);
  await expect(fixture.run("prepare", { batch: undefined })).rejects.toThrow(/sample/iu);
  await expect(fixture.run("prepare", { batch: { operation: "prepare",
    limits: { ...fixture.limits, maxJobs: 2 } } })).rejects.toThrow(/sample/iu);
});

it("reopens singleton manifests, submits once through HTTP, and keeps sample results partial", async () => {
  const fixture = await sampleScenario();
  await fixture.run("prepare", { sourcePacking: "singleton" });
  const planPath = join(roots.cacheRoot, "gemini-batch-plan-sample.json");
  const planBytes = readFileSync(planPath, "utf8");
  await fixture.run("submit");
  expect(fixture.provider.state.creates).toBe(1);
  const uploaded = fixture.provider.state.uploads[0]!.trim().split("\n").map((line) => JSON.parse(line));
  expect(uploaded).toHaveLength(8);
  for (const line of uploaded) {
    const request = JSON.parse(line.request.contents[0].parts[0].text);
    expect(request.batch_count).toBe(18);
    expect(request.source_assertions).toHaveLength(1);
    expect(line.request.generationConfig.responseJsonSchema.properties.interpretations).not.toHaveProperty("maxItems");
  }
  fixture.provider.state.finished = true;
  const imported = await fixture.run("resume");
  expect(imported.authorityTelemetry).toMatchObject({ attempts: 8, successfulShards: 8 });
  expect(imported.manifest).toMatchObject({ fill_status: "in_progress", expected_turns: 20, cached_turns: 8 });
  expect(imported.manifest).not.toHaveProperty("content_closure_index");
  await fixture.run("import");
  await fixture.run("submit");
  expect(fixture.provider.state.creates).toBe(1);
  expect(readFileSync(planPath, "utf8")).toBe(planBytes);
  expect(readExtractionCacheManifestIdentity(roots.cacheRoot)!.manifest).toMatchObject({ source_packing: "singleton" });
  expect(() => createCompileSeedRunner({ cacheRoot: roots.cacheRoot,
    requiredTurnContents: fixture.turns.distinctTurnContents,
    requiredExtractionTurns: fixture.turns.distinctExtractionTurns,
    requiredQuestionWindow: { offset: 0, limit: 100 }, allowLiveExtraction: false,
    diagnosticDir: null })).toThrow(/incomplete|missing|coverage|in_progress/iu);
});

it("retains an ambiguous submission intent across reopen and refuses a second dispatch", async () => {
  const fixture = await sampleScenario();
  await fixture.run("prepare", { sourcePacking: "singleton" });
  fixture.provider.state.ambiguous = true;
  await expect(fixture.run("submit")).rejects.toThrow();
  expect(fixture.provider.state.creates).toBe(1);
  const retried = await fixture.run("submit");
  expect(retried.batchState!.jobs[0]!.status).toBe("submission_unknown");
  expect(retried.authorityTelemetry).toMatchObject({ attempts: 8, successfulShards: 0 });
  await expect(fixture.run("prepare", { batch: { operation: "prepare", limits: fixture.limits,
    window: "another" } })).rejects.toThrow(/unknown|overlap|job/iu);
  expect(fixture.provider.state.creates).toBe(1);
});

it("does not retry sample keys after transport success is quarantined by strict admission", async () => {
  const fixture = await sampleScenario();
  await fixture.run("prepare", { sourcePacking: "singleton" });
  await fixture.run("submit");
  fixture.provider.state.finished = true;
  fixture.provider.state.quarantine = true;
  const result = await fixture.run("resume");
  expect(result.authorityTelemetry).toMatchObject({ attempts: 8, successfulShards: 0 });
  expect(result.manifest).toMatchObject({ fill_status: "in_progress", cached_turns: 0 });
  const plan = JSON.parse(readFileSync(join(roots.cacheRoot, "gemini-batch-plan-sample.json"), "utf8"));
  const statePath = join(roots.cacheRoot, `batch-state-${plan.identity}.json`);
  const state = readFileSync(statePath);
  const ledgerPath = join(roots.cacheRoot, `extraction-attempt-ledger.${fixture.receipt.lineage_digest}.json`);
  const ledger = readFileSync(ledgerPath);
  // Strictly malformed responses remain durable outcomes without becoming cache shards.
  for (const key of fixture.selected) expect(existsSync(cacheFilePath(roots.cacheRoot, key))).toBe(false);
  for (const operation of ["import", "submit"] as const) {
    const reopened = await fixture.run(operation);
    expect(reopened.authorityTelemetry).toMatchObject({ attempts: 8, successfulShards: 0 });
    expect(reopened.manifest).toMatchObject({ fill_status: "in_progress", cached_turns: 0 });
    expect(readFileSync(statePath)).toEqual(state);
    expect(readFileSync(ledgerPath)).toEqual(ledger);
  }
  await expect(fixture.run("prepare", { batch: { operation: "prepare", limits: fixture.limits,
    window: "retry" } })).rejects.toThrow(/jobs|overlap|sample/iu);
  expect(existsSync(join(roots.cacheRoot, "gemini-batch-plan-retry.json"))).toBe(false);
  expect(readFileSync(statePath)).toEqual(state);
  expect(readFileSync(ledgerPath)).toEqual(ledger);
  expect(fixture.provider.state.creates).toBe(1);
});

it("imports witnessed empty Batch responses, reopens their completion and never redispatches", async () => {
  const fixture = await sampleScenario();
  await fixture.run("prepare", { sourcePacking: "singleton" });
  await fixture.run("submit");
  fixture.provider.state.finished = true;
  fixture.provider.state.empty = true;
  const imported = await fixture.run("resume");
  expect(imported.authorityTelemetry).toMatchObject({ attempts: 8, successfulShards: 8 });
  expect(imported.manifest).toMatchObject({ fill_status: "in_progress", cached_turns: 8, expected_turns: 20 });
  for (const key of fixture.selected) {
    const persisted = JSON.parse(readFileSync(cacheFilePath(roots.cacheRoot, key), "utf8"));
    expect(persisted).toMatchObject({ raw_json: '{"interpretations":[]}', empty_classification: "completed_empty",
      request_completion: { version: 1, status: "completed_empty" },
      transport_provenance: { model: "gemini-3.1-flash-lite" }, response_metadata: {
        finish_reason: "STOP", completion_contract_version: 1, completion_witness: "finish_reason" } });
    expect(inspectCachedExtraction(roots.cacheRoot, key, "gemini-3.1-flash-lite", "gemini-3.1-low-v1"))
      .toMatchObject({ status: "hit", rawSignalCount: 0, parsedDraftCount: 0 });
    expect(inspectCachedRawExtraction(roots.cacheRoot, key, "gemini-3.1-flash-lite", "gemini-3.1-low-v1"))
      .toMatchObject({ status: "hit", rawSignalCount: 0 });
  }
  const ledgerPath = join(roots.cacheRoot, `extraction-attempt-ledger.${fixture.receipt.lineage_digest}.json`);
  const ledger = readFileSync(ledgerPath);
  await fixture.run("import");
  await fixture.run("submit");
  expect(fixture.provider.state.creates).toBe(1);
  expect(readFileSync(ledgerPath)).toEqual(ledger);
});

it("rejects persisted sample plans with omitted, substituted, or duplicate lines before dispatch", async () => {
  const fixture = await sampleScenario();
  await fixture.run("prepare", { sourcePacking: "singleton" });
  const path = join(roots.cacheRoot, "gemini-batch-plan-sample.json");
  const original = readFileSync(path, "utf8");
  const saved = JSON.parse(original);
  for (const lines of [saved.lines.slice(0, 7),
    [...saved.lines.slice(0, 7), { ...saved.lines[7], key: fixture.keys[8] }],
    [...saved.lines.slice(0, 7), saved.lines[0]]]) {
    writeFileSync(path, JSON.stringify({ ...saved, lines }));
    await expect(fixture.run("submit")).rejects.toThrow();
  }
  writeFileSync(path, original);
  expect(fixture.provider.state.creates).toBe(0);
});
