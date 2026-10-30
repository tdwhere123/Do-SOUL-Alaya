import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fieldContractSha256, SourceIndexLifecycle } from "@do-soul/alaya-core";
import { initDatabase, SqliteSignalRepo, SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo, SqliteFieldProjectionGenerationRepo,
  SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { configuration as sourceIndexConfiguration, BUDGET as SOURCE_INDEX_BUDGET } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { createCompileSeedRunner } from "../../../runs/compile-seed.js";
import { resolveCompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-config.js";
import { inspectTurnContentKeySpace } from "../../../runs/extraction/turn-contents.js";
import { runCli } from "../../../cli/cli.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { readExtractionCacheManifestIdentity } from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import type { GeminiBatchLimits, GeminiBatchPlan } from "../../../runs/extraction/fill/batch/contract.js";
import { buildAuthorityQuestion, buildGroundedInterpretationResponse, EXTRACTION_FILL_VARIANT,
  registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots));
afterEach(() => vi.unstubAllGlobals());

it.each([1, 2])("consumes %i session statements through the fill CLI and native recall without duplicate spend or roots", async (expectedDrafts) => {
  const sourcePacking = "session-statements" as const;
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gemini-2.5-flash-lite");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "gemini-2.5-nonthinking-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  const questions = [buildAuthorityQuestion("q1", "alpha", "decoy")];
  if (expectedDrafts === 2) questions[0]!.haystack_sessions[0]![0]!.content += " I completed beta.";
  await writeDataset(questions);
  const inspection = await inspectExtractionAuthority({ variant: EXTRACTION_FILL_VARIANT,
    cacheRoot, dataDir, pinnedMetaRoot, sourcePacking, revision: readCurrentExtractionAuthorityRevision(), action: "fill" });
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
      return new Response(plan.lines.map((line) => {
        const response = JSON.parse(buildGroundedInterpretationResponse(line.userPrompt));
        if (expectedDrafts === 2) for (const message of response.messages) {
          if (message.statements[0]?.text.includes("alpha")) message.statements = [
            { text: "I completed alpha.", relation: "recorded event" },
            { text: "I completed beta.", relation: "recorded event" }
          ];
        }
        return JSON.stringify({ key: line.key, response: {
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(response) }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
        } });
      }).join("\n"));
    }
    throw new Error(`unexpected fixture request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const run = (operation: string, packing?: string) => runCli(["extraction-fill", "--variant", "oracle",
    "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-authority", receiptPath,
    "--batch-operation", operation, "--batch-limits", limitsPath,
    ...(packing === undefined ? [] : ["--extraction-source-packing", packing])]);
  expect(await run("prepare", sourcePacking)).toBe(0);
  expect(await run("prepare", "reference-eight")).toBe(2);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await run("submit")).toBe(0);
  expect(creates).toBe(1);
  expect(await run("resume")).toBe(0);
  expect(readExtractionCacheManifestIdentity(cacheRoot)?.manifest.fill_status).toBe("complete");
  const calls = fetchMock.mock.calls.length;
  expect(await run("import")).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(calls);
  expect(creates).toBe(1);
  const turn = inspectTurnContentKeySpace(questions, sourcePacking).distinctExtractionTurns[0]!;
  const config = resolveCompileSeedExtractionConfig(process.env, readExtractionCacheManifestIdentity(cacheRoot)!.manifest);
  expect(config.sourcePacking).toBe(sourcePacking);
  const runner = createCompileSeedRunner({ cacheRoot, sourcePacking: config.sourcePacking,
    requiredExtractionTurns: inspectTurnContentKeySpace(questions, sourcePacking).distinctExtractionTurns,
    requiredTurnContents: inspectTurnContentKeySpace(questions, sourcePacking).distinctExtractionTurns.map((item) => item.turnContent),
    requiredQuestionWindow: { offset: 0, limit: 1 }, diagnosticDir: null,
    extractorFactory: () => ({ extract: async () => { throw new Error("prepared consumer must stay cache-only"); } }) });
  vi.stubEnv("ALAYA_INGEST_RECONCILIATION_ENABLED", "0");
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "");
  const daemon = await startBenchDaemon({ dataDirRoot: join(cacheRoot, "consumer"),
    workspaceId: "batch-consumer", runId: "batch-consumer-run" });
  try {
    const result = await runner.seedTurn({ daemon, turnContent: turn.turnContent,
      turnMessages: turn.turnMessages, seedIndex: 1, evidenceRefBase: "batch-consumer-evidence",
      workspaceId: daemon.workspaceId, runId: daemon.runId, sourceObservedAt: turn.turnMessages[0]!.source_time!.normalized });
    expect(result.seeds).toHaveLength(expectedDrafts);
    const seed = result.seeds[0]!;
    expect(seed.evidenceId).not.toBeNull();
    await daemon.checkpointFieldProjection();
    // initDatabase reuses the daemon's connection; daemon.shutdown owns its close.
    const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
    const signal = await new SqliteSignalRepo(db).getById(seed.signalId);
    expect(signal).toMatchObject({ interpretation_contract: "source-statements-v1",
      raw_payload: { source_statement: {
        message: { role: "user", text: questions[0]!.haystack_sessions[0]![0]!.content,
          recorded_time: { raw: "2025-12-01", level: "session", precision: "day" } },
        statement: { text: "I completed alpha.", relation: "recorded event" }
      } } });
    const evidence = await new SqliteEvidenceCapsuleRepo(db).findById(seed.evidenceId!);
    expect(evidence?.excerpt).toContain("I completed alpha.");
    const sourceRecords = new SqliteFieldSourceRecordRepo(db, fieldContractSha256)
      .listByWorkspace(daemon.workspaceId);
    const originalSource = sourceRecords.find((row) => row.source_id === "compile-seed:batch-consumer:batch-consumer-run:1");
    expect(originalSource?.source_body).toContain("I completed alpha.");
    expect(sourceRecords).toHaveLength(1);
    expect(sourceRecords.filter(row => result.seeds.some(item => item.evidenceId === row.evidence_object_id))).toEqual([]);
    const generation = new SqliteFieldProjectionGenerationRepo(db, fieldContractSha256)
      .readActive(daemon.workspaceId);
    expect(generation?.status).toBe("active");
    // Field formation alone is not native query readiness. Prepare the lexical index
    // for every captured source through its lifecycle owner, without embedding calls.
    const index = new SqliteSourceIndexRepository(db, fieldContractSha256);
    const lifecycle = new SourceIndexLifecycle(index, fieldContractSha256);
    const native = lifecycle.begin(lifecycle.select(daemon.workspaceId, sourceIndexConfiguration()));
    const captured = lifecycle.capture(daemon.workspaceId, native.generation_id, 128, SOURCE_INDEX_BUDGET);
    expect(captured.generation.enumeration_complete).toBe(true);
    const targets = index.listTargets(daemon.workspaceId, native.generation_id, null, 128);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(lifecycle.prepare(daemon.workspaceId, native.generation_id,
      target.root_key, SOURCE_INDEX_BUDGET).status).toBe("ready");
    for (const result_kind_view of ["source_only", "mixed"] as const) {
      const recalled = await daemon.recall("alpha", { result_kind_view,
        enumeration_policy: "native_query", maxResults: 10 });
      const delivered = recalled.results.find((row) => row.target.kind === "source_evidence" &&
        row.target.root_id === originalSource?.record_id);
      expect(delivered).toMatchObject({
        target: { kind: "source_evidence", root_kind: "source_record", root_id: originalSource?.record_id },
        content_preview: expect.stringContaining("alpha")
      });
      expect(delivered).not.toHaveProperty("object_id");
      expect(recalled.results.filter(row => row.target.kind === "source_evidence" && row.target.root_id === originalSource?.record_id)).toHaveLength(1);
      expect(recalled.provider_calls).toBe(0);
      expect(recalled.garden_enqueue).toBe(0);
    }
    expect(runner.stats.llmCalls).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  } finally { await daemon.shutdown(); }
  const reopened = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
  try {
    const sources = new SqliteFieldSourceRecordRepo(reopened, fieldContractSha256).listByWorkspace(daemon.workspaceId);
    expect(sources.some((row) => row.source_body?.includes("I completed alpha."))).toBe(true);
    if (expectedDrafts === 2) {
      expect(sources.some((row) => row.source_body?.includes("I completed beta."))).toBe(true);
    }
  } finally { reopened.close(); }
}, 60_000);
