import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
vi.hoisted(() => {
  for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key];
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(input)).hostname !== "127.0.0.1" || init?.redirect !== "error") throw new Error("only no-redirect loopback transport allowed");
    return nativeFetch(input, init);
  });
});
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { sourceStatementRequests } from "../../../runs/extraction/source-statement-request.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from
  "../../../runs/extraction/authority/inspection.js";
import { createExtractionSampleScope, assertSampleKeys, assertSampleReceipt } from
  "../../../runs/extraction/authority/sample-scope.js";
import { extractionSamplePolicies, createExtractionSamplePolicyRegistry } from
  "../../../runs/extraction/authority/sample-policy.js";
import { createExtractionAuthorityReceipt, computeExtractionAuthorityLineageDigest, readExtractionAuthorityReceipt,
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

async function sampleScenario(questionCount = 100, sampleSize = 8) {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gemini-3.1-flash-lite");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "gemini-3.1-low-v1");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_SOURCE_PACKING", "");
  const questions = Array.from({ length: questionCount }, (_, i) => {
    const question = buildExtractionFillQuestion(`q${i}`, "unused", "I enjoy gardening.");
    const ids = Array.from({ length: i === 0 ? 18 : 1 }, (_, session) => `q${i}-source-${session}`);
    return { ...question, haystack_session_ids: [...ids, question.haystack_session_ids[1]!],
      haystack_dates: [...ids.map(() => "2025-12-01"), "2025-11-01"],
      haystack_sessions: [...ids.map((_, session) => [
        { role: "user", content: `I recorded durable detail number ${session + 1}.`, has_answer: true },
        { role: "assistant", content: "Acknowledged." }
      ]), question.haystack_sessions[1]!], answer_session_ids: ids };
  });
  questions[0] = { ...questions[0]!,
    haystack_session_ids: [...questions[0]!.haystack_session_ids, "assistant-only"],
    haystack_dates: [...questions[0]!.haystack_dates, "2025-12-01"],
    haystack_sessions: [...questions[0]!.haystack_sessions, [{ role: "assistant", content: "Acknowledged." }]]
  };
  await writeDataset(questions);
  const inspectInput = { ...roots, variant: "longmemeval_s" as const, limit: questionCount,
    revision: readCurrentExtractionAuthorityRevision(), action: "sample" as const,
    sourcePacking: "session-statements" as const };
  const inspection = await inspectExtractionAuthority(inspectInput);
  const turns = inspectTurnContentKeySpace(questions, "session-statements");
  const sourceTurns = turns.distinctExtractionTurns.filter((value) => value.turnContent.includes("detail number"));
  const requests = sourceTurns.flatMap(turn => sourceStatementRequests(turn.turnMessages));
  const keys = sourceTurns.flatMap(turn => computeExtractionTurnCacheKeys("gemini-3.1-flash-lite", "gemini-3.1-low-v1",
    SOURCE_STATEMENTS_PROMPT, turn, "session-statements"));
  const selected = keys.slice(0, sampleSize);
  const scope = createExtractionSampleScope(selected, inspection);
  rmSync(roots.cacheRoot, { recursive: true });
  const selection = questionCount === 100
    ? createFreshRetiredSourceRebuildTargetSelection({ cacheRoot: roots.cacheRoot,
      operator: "fixture-operator", observation: inspection.observation }) : undefined;
  if (selection === undefined) mkdirSync(roots.cacheRoot);
  const receipt = createExtractionAuthorityReceipt({ action: "sample", sampleScope: scope,
    observation: inspection.observation, inspection,
    ...(selection === undefined ? {} : { targetSelectionDigest: selection.receipt_digest }),
    outputTokenCap: { field: "maxOutputTokens", value: 512 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100_000 } });
  const receiptPath = join(roots.cacheRoot, "..", "sample-authority.json");
  const selectionPath = join(roots.cacheRoot, "..", "target-selection.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  if (selection !== undefined) writeExtractionTargetSelectionReceipt(selectionPath, selection);
  const limits: GeminiBatchLimits = { maxJobs: 1, maxRequestsPerJob: selected.length,
    maxFileBytes: 1_000_000, maxInputTokensPerJob: 1_000_000, maxEnqueuedTokens: 1_000_000,
    maxOutputTokens: 512, maxUsd: receipt.price.estimated_upper_usd,
    inputUsdPerMillion: 1, outputUsdPerMillion: 2, deadlineMs: 60_000,
    requestTimeoutMs: 1_000, maxPolls: 10 };
  const provider = await startProvider();
  const run = (operation: GeminiBatchOperation, changes: Partial<ExtractionFillOptions> = {}) =>
    runExtractionFill({ ...roots, variant: "longmemeval_s", limit: questionCount,
      authorityReceiptPath: receiptPath,
      ...(selection === undefined ? {} : { targetSelectionReceiptPath: selectionPath }),
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
        const prompt = input.request.contents[0].parts[0].text;
        const raw = state.quarantine ? '{"signals":[{}]}' : state.empty
          ? JSON.stringify({ messages: JSON.parse(prompt).messages.map(({ message_id }: { message_id: string }) =>
            ({ message_id, statements: [] })) })
          : buildGroundedInterpretationResponse(prompt);
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

it("binds a finite native sample to the complete inventory of captured sessions", async () => {
  const fixture = await sampleScenario();
  expect(fixture.requests).toHaveLength(18);
  expect(fixture.requests.slice(0, 8).map(({ source }) => source.messages.map(message => [message.role, message.text])))
    .toEqual(Array.from({ length: 8 }, (_, i) => [["user", `I recorded durable detail number ${i + 1}.`],
      ["assistant", "Acknowledged."]]));
  expect(new Set(fixture.requests.map(({ source }) => source.session_id)).size).toBe(18);
  expect(fixture.inspection.observation.inventory.missingTurns).toBe(20);
  expect(fixture.receipt.limits).toMatchObject({ starting_missing: 20,
    maximum_attempts: 8, successful_shard_ceiling: 8 });
  expect(readExtractionAuthorityReceipt(fixture.receiptPath)).toEqual(fixture.receipt);
  expect(fixture.receipt.sample_policy?.identity).toBe("longmemeval-first-100-sample-v1");
  for (const binding of [undefined, { identity: "unknown", manifest_sha256: "a".repeat(64) },
    { ...fixture.receipt.sample_policy!, manifest_sha256: "f".repeat(64) }]) {
    expect(() => assertSampleReceipt({ ...fixture.receipt, sample_policy: binding })).toThrow(/policy/u);
  }
  const policies = createExtractionSamplePolicyRegistry([
    { identity: "bounded-source-policy-v1", manifest: "source-window-v1", rules: { inventory: "first-100", allowedKeys: fixture.selected.slice(0, 1) } },
    { identity: "bounded-source-policy-v2", manifest: "source-window-v2", rules: { inventory: "first-100", allowedKeys: fixture.selected } }
  ]);
  const oldPolicy = policies.binding("bounded-source-policy-v1"), newPolicy = policies.binding("bounded-source-policy-v2");
  expect(() => policies.assert(oldPolicy, fixture.inspection.observation, fixture.selected, false)).toThrow(/keys/u);
  expect(() => policies.assert(newPolicy, fixture.inspection.observation, fixture.selected, false)).not.toThrow();
  expect(() => extractionSamplePolicies.assert(newPolicy, fixture.inspection.observation, fixture.selected, false)).toThrow(/unknown/u);
  expect(computeExtractionAuthorityLineageDigest(fixture.inspection.observation, undefined, fixture.scope, oldPolicy))
    .not.toBe(computeExtractionAuthorityLineageDigest(fixture.inspection.observation, undefined, fixture.scope, newPolicy));
  expect(() => assertSampleReceipt({ ...fixture.receipt, target_selection_digest: undefined }))
    .toThrow(/selection/u);
  for (const keys of [[], [...fixture.selected, fixture.selected[0]!], ["f".repeat(64)]]) {
    expect(() => createExtractionSampleScope(keys, fixture.inspection)).toThrow();
  }
  const assistant = fixture.turns.distinctExtractionTurns.find(turn => turn.turnMessages.every(message => message.role === "assistant"))!;
  const [assistantKey] = computeExtractionTurnCacheKeys("gemini-3.1-flash-lite", "gemini-3.1-low-v1",
    SOURCE_STATEMENTS_PROMPT, assistant, "session-statements");
  expect(fixture.inspection.nonemptyKeys).toContain(assistantKey);
  expect(() => createExtractionSampleScope([assistantKey!], fixture.inspection)).not.toThrow();
  const proposedPath = join(roots.cacheRoot, "..", "proposed-keys.json");
  const issuedPath = join(roots.cacheRoot, "..", "issued-sample.json");
  writeFileSync(proposedPath, JSON.stringify(fixture.selected));
  const args = ["--variant", "s", "--limit", "100", "--data-dir", roots.dataDir,
    "--pinned-meta-root", roots.pinnedMetaRoot, "--extraction-cache-root", roots.cacheRoot,
    "--extraction-source-packing", "session-statements", "--extraction-action", "sample",
    "--extraction-sample-keys", proposedPath, "--extraction-target-selection", fixture.selectionPath,
    "--extraction-receipt-out", issuedPath, "--extraction-output-token-cap", "512",
    "--extraction-output-token-field", "maxOutputTokens", "--extraction-input-price-usd-per-million", "1",
    "--extraction-output-price-usd-per-million", "2", "--extraction-max-input-tokens", "100000",
    "--extraction-disk-floor-bytes", "0"];
  const selectionFlag = args.indexOf("--extraction-target-selection");
  expect(await runAuthorizeExtractionCommand([
    ...args.slice(0, selectionFlag), ...args.slice(selectionFlag + 2)
  ])).toBe(2);
  expect(existsSync(issuedPath)).toBe(false);
  expect(await runAuthorizeExtractionCommand(args)).toBe(0);
  const issued = readExtractionAuthorityReceipt(issuedPath);
  expect(issued.sample_scope).toEqual(fixture.scope);
  expect(issued.lineage_digest).toBe(fixture.receipt.lineage_digest);
  writeFileSync(proposedPath, JSON.stringify(["f".repeat(64)]));
  expect(await runAuthorizeExtractionCommand(args)).toBe(2);
  for (const keys of [fixture.selected.slice(0, 7), [...fixture.selected, fixture.keys[8]!],
    [...fixture.selected.slice(0, 7), fixture.keys[8]!], [...fixture.selected.slice(0, 7), fixture.selected[0]!]]) {
    expect(() => assertSampleKeys(fixture.scope, keys)).toThrow("exactly");
  }
  const prepared = await fixture.run("prepare", { sourcePacking: "session-statements" });
  expect(prepared.manifest).toMatchObject({ schema_version: 4, source_packing: "session-statements", expected_turns: 20 });
  expect(prepared.batchState!.jobs).toHaveLength(1);
  expect([...prepared.batchState!.jobs[0]!.lineKeys].sort()).toEqual([...fixture.selected].sort());
  expect(fixture.provider.state.creates).toBe(0);
  await expect(fixture.run("prepare", { sourcePacking: "reference-eight" })).rejects.toThrow(/retired passive generation/iu);
  await expect(fixture.run("prepare", { batch: undefined })).rejects.toThrow(/sample/iu);
  await expect(fixture.run("prepare", { batch: { operation: "prepare",
    limits: { ...fixture.limits, maxJobs: 2 } } })).rejects.toThrow(/sample/iu);
});

it("reopens session manifests, submits once through HTTP, and keeps sample results partial", async () => {
  const fixture = await sampleScenario();
  await fixture.run("prepare");
  const planPath = join(roots.cacheRoot, "gemini-batch-plan-sample.json");
  const planBytes = readFileSync(planPath, "utf8");
  await fixture.run("submit");
  expect(fixture.provider.state.creates).toBe(1);
  const uploaded = fixture.provider.state.uploads[0]!.trim().split("\n").map((line) => JSON.parse(line));
  expect(uploaded).toHaveLength(8);
  for (const line of uploaded) {
    const request = JSON.parse(line.request.contents[0].parts[0].text);
    expect(request).toMatchObject({ contract: "source-statements-v1", chunk_index: 0, context: [] });
    expect(request.messages).toHaveLength(2);
    const messageSchema = line.request.generationConfig.responseJsonSchema.properties.messages.items;
    expect(messageSchema.required).toEqual(["message_id", "statements"]);
    expect(messageSchema.properties.statements.items.required).toEqual(["text", "relation"]);
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
  expect(readExtractionCacheManifestIdentity(roots.cacheRoot)!.manifest).toMatchObject({ source_packing: "session-statements" });
  expect(() => createCompileSeedRunner({ cacheRoot: roots.cacheRoot,
    requiredTurnContents: fixture.turns.distinctTurnContents,
    requiredExtractionTurns: fixture.turns.distinctExtractionTurns,
    requiredQuestionWindow: { offset: 0, limit: 100 },
    diagnosticDir: null })).toThrow(/incomplete|missing|coverage|in_progress/iu);
});

it("rejects a non-first-100 ordinary Gemini sample through CLI before publishing authority", async () => {
  await expect(sampleScenario(2, 2)).rejects.toThrow(/first-100/u);
  const inspection = await inspectExtractionAuthority({ ...roots, variant: "longmemeval_s", limit: 2,
    revision: readCurrentExtractionAuthorityRevision(), action: "sample", sourcePacking: "session-statements" });
  const proposedPath = join(roots.cacheRoot, "..", "diagnostic-keys.json");
  const issuedPath = join(roots.cacheRoot, "..", "diagnostic-authority.json");
  writeFileSync(proposedPath, JSON.stringify(inspection.nonemptyKeys!.slice(0, 2)));
  expect(await runAuthorizeExtractionCommand([
    "--variant", "s", "--limit", "2", "--data-dir", roots.dataDir,
    "--pinned-meta-root", roots.pinnedMetaRoot, "--extraction-cache-root", roots.cacheRoot,
    "--extraction-source-packing", "session-statements", "--extraction-action", "sample",
    "--extraction-sample-keys", proposedPath, "--extraction-receipt-out", issuedPath,
    "--extraction-output-token-cap", "512", "--extraction-output-token-field", "maxOutputTokens",
    "--extraction-input-price-usd-per-million", "1", "--extraction-output-price-usd-per-million", "2",
    "--extraction-max-input-tokens", "100000", "--extraction-disk-floor-bytes", "0"
  ])).toBe(2);
  expect(existsSync(issuedPath)).toBe(false);
  expect(server).toBeUndefined();
});

it("retains an ambiguous submission intent across reopen and refuses a second dispatch", async () => {
  const fixture = await sampleScenario();
  await fixture.run("prepare");
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
  await fixture.run("prepare");
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
  await fixture.run("prepare");
  await fixture.run("submit");
  fixture.provider.state.finished = true;
  fixture.provider.state.empty = true;
  const imported = await fixture.run("resume");
  expect(imported.authorityTelemetry).toMatchObject({ attempts: 8, successfulShards: 8 });
  expect(imported.manifest).toMatchObject({ fill_status: "in_progress", cached_turns: 8, expected_turns: 20 });
  for (const key of fixture.selected) {
    const persisted = JSON.parse(readFileSync(cacheFilePath(roots.cacheRoot, key), "utf8"));
    expect(JSON.parse(persisted.raw_json)).toEqual({ messages: fixture.requests[fixture.keys.indexOf(key)]!.source.messages
      .map(({ message_id }) => ({ message_id, statements: [] })) });
    expect(persisted).toMatchObject({ empty_classification: "completed_empty",
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
  await fixture.run("prepare");
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
