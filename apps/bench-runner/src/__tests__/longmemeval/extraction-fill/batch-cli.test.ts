import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { initDatabase, SqliteSignalRepo, SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo, SqliteFieldProjectionGenerationRepo,
  SqliteFieldFactorRepo, SqliteFieldSourceSpanRepo } from "@do-soul/alaya-storage";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { createCachingSignalExtractor } from "../../../runs/compile-seed/compile-seed-cache.js";
import { resolveCompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-config.js";
import { extractSeedInputs } from "../../../runs/compile-seed/compile-seed-extract.js";
import { newFillStats } from "../../../runs/extraction/fill/fill-stats.js";
import { inspectTurnContentKeySpace } from "../../../runs/extraction/turn-contents.js";
import { runCli } from "../../../cli/cli.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { readExtractionCacheManifestIdentity } from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import type { GeminiBatchLimits, GeminiBatchPlan } from "../../../runs/extraction/fill/batch/contract.js";
import { buildAuthorityQuestion, buildGroundedSignalResponse, EXTRACTION_FILL_VARIANT,
  registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots));
afterEach(() => vi.unstubAllGlobals());

it("prepares, submits, resumes and reimports through the actual fill CLI without duplicate spend", async () => {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gemini-2.5-flash-lite");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "gemini-2.5-nonthinking-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  const questions = [buildAuthorityQuestion("q1", "alpha", "decoy")];
  await writeDataset(questions);
  const inspection = await inspectExtractionAuthority({ variant: EXTRACTION_FILL_VARIANT,
    cacheRoot, dataDir, pinnedMetaRoot, revision: readCurrentExtractionAuthorityRevision(), action: "fill" });
  const receipt = createExtractionAuthorityReceipt({ action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 512 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100_000 },
    inspection: { writerLock: inspection.writerLock, disk: inspection.disk,
      credentialStatus: inspection.credentialStatus, modelReadiness: inspection.modelReadiness } });
  const receiptPath = join(cacheRoot, "authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  const limits: GeminiBatchLimits = { maxJobs: 1, maxRequestsPerJob: 100, maxFileBytes: 1_000_000,
    maxInputTokensPerJob: 1_000_000, maxEnqueuedTokens: 1_000_000, maxOutputTokens: 512,
    maxUsd: receipt.price.estimated_upper_usd, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    deadlineMs: 60_000, requestTimeoutMs: 5_000, maxPolls: 10 };
  const limitsPath = join(cacheRoot, "limits.json");
  writeFileSync(limitsPath, JSON.stringify(limits));
  let creates = 0;
  let inputFile = "files/input";
  let displayName = "";
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/upload/v1beta/files") return new Response(null, {
      headers: { "x-goog-upload-url": "https://fixture-provider.invalid/upload-session" } });
    if (path === "/upload-session") return Response.json({ file: { name: inputFile } });
    if (path.endsWith(":batchGenerateContent")) {
      creates += 1;
      const body = JSON.parse(String(init?.body));
      displayName = body.batch.displayName;
      inputFile = body.batch.inputConfig.fileName;
      return Response.json({ name: "batches/job", metadata: { state: "BATCH_STATE_PENDING",
        model: "models/gemini-2.5-flash-lite", displayName, inputConfig: { fileName: inputFile } } });
    }
    if (path === "/v1beta/batches/job") return Response.json({ name: "batches/job", done: true,
      metadata: { state: "BATCH_STATE_SUCCEEDED", model: "models/gemini-2.5-flash-lite",
        displayName, inputConfig: { fileName: inputFile } }, response: { responsesFile: "files/output" } });
    if (path === "/download/v1beta/files/output:download") {
      const plan = JSON.parse(readFileSync(join(cacheRoot, "gemini-batch-plan.json"), "utf8")) as GeminiBatchPlan;
      return new Response(plan.lines.map((line) => JSON.stringify({ key: line.key, response: {
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: buildGroundedSignalResponse(line.userPrompt) }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
      } })).join("\n"));
    }
    throw new Error(`unexpected fixture request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const run = (operation: string) => runCli(["extraction-fill", "--variant", "oracle",
    "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-authority", receiptPath,
    "--batch-operation", operation, "--batch-limits", limitsPath]);
  expect(await run("prepare")).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await run("submit")).toBe(0);
  expect(creates).toBe(1);
  expect(await run("resume")).toBe(0);
  expect(readExtractionCacheManifestIdentity(cacheRoot)?.manifest.fill_status).toBe("complete");
  const calls = fetchMock.mock.calls.length;
  expect(await run("import")).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(calls);
  expect(creates).toBe(1);
  const turn = inspectTurnContentKeySpace(questions).distinctExtractionTurns[0]!;
  const stats = newFillStats();
  const provider = new OfficialApiGardenProvider({ diagnosticDir: null, injectedExtractorCapability: "cache_only",
    extractor: createCachingSignalExtractor({ cacheRoot, stats, allowLiveExtraction: false,
      config: resolveCompileSeedExtractionConfig(),
      delegate: { extract: async () => { throw new Error("prepared consumer must stay cache-only"); } } }) });
  const daemon = await startBenchDaemon({ dataDirRoot: join(cacheRoot, "consumer"),
    workspaceId: "batch-consumer", runId: "batch-consumer-run" });
  try {
    const drafts = await extractSeedInputs({ provider, stats, turnContent: turn.turnContent, seedIndex: 1,
      context: { workspace_id: daemon.workspaceId, run_id: daemon.runId, surface_id: null,
        turn_messages: turn.turnMessages } });
    expect(drafts).toHaveLength(1);
    const result = await daemon.proposeMemoriesFromCompileSignals(drafts.map((draft) => ({
      ...draft, evidenceRef: "batch-consumer-evidence"
    })));
    expect(result.dropped).toEqual([]);
    expect(result.seeds).toHaveLength(1);
    expect(result.createdEvidence).toBe(true);
    const seed = result.seeds[0]!;
    expect(seed.evidenceId).not.toBeNull();
    await daemon.checkpointFieldProjection();
    // initDatabase reuses the daemon's connection; daemon.shutdown owns its close.
    const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
    const signal = await new SqliteSignalRepo(db).getById(seed.signalId);
    expect(signal?.raw_payload).toMatchObject({ matched_text: "I completed alpha.",
      source_locator: { assertion_id: 1 } });
    const evidence = await new SqliteEvidenceCapsuleRepo(db).findById(seed.evidenceId!);
    expect(evidence?.excerpt).toContain("I completed alpha.");
    const source = new SqliteFieldSourceRecordRepo(db, fieldContractSha256)
      .listByWorkspace(daemon.workspaceId).find((row) => row.evidence_object_id === seed.evidenceId);
    expect(source?.source_body).toContain("I completed alpha.");
    if (source === undefined) throw new Error("materialization must retain its original source record");
    const spans = new SqliteFieldSourceSpanRepo(db, fieldContractSha256)
      .listByWorkspace(daemon.workspaceId).filter((row) => row.record_id === source.record_id);
    expect(spans.length).toBeGreaterThan(0);
    const incidences = new SqliteFieldFactorRepo(db, fieldContractSha256)
      .listIncidences(daemon.workspaceId);
    expect(incidences.some((row) => spans.some((span) => span.span_id === row.span_id))).toBe(true);
    const generation = new SqliteFieldProjectionGenerationRepo(db, fieldContractSha256)
      .readActive(daemon.workspaceId);
    expect(generation?.status).toBe("active");
    for (const result_kind_view of ["source_only", "mixed"] as const) {
      const recalled = await daemon.recall("alpha", { result_kind_view,
        enumeration_policy: "canonical", maxResults: 10 });
      const delivered = recalled.results.find((row) => row.target.kind === "source_evidence");
      expect(delivered).toMatchObject({
        target: { kind: "source_evidence", root_kind: "source_record", root_id: source.record_id,
          evidence_object_id: seed.evidenceId },
        content_preview: expect.stringContaining("alpha")
      });
      expect(delivered).not.toHaveProperty("object_id");
      expect(recalled.provider_calls).toBe(0);
      expect(recalled.garden_enqueue).toBe(0);
    }
    expect(stats.llmCalls).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  } finally { await daemon.shutdown(); }
}, 60_000);
