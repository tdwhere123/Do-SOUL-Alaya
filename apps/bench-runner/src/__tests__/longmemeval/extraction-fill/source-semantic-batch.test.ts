import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest, prepareSourceSemanticRevision } from "@do-soul/alaya-soul";
import { runCli } from "../../../cli/cli.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import * as authorityInspection from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { assertSourceSemanticShardCapacity, inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { inspectCachedExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";
import { inspectCachedSourcePacket } from "../../../runs/extraction/cache/source-packet-artifact.js";
import { readExtractionCacheManifestIdentity } from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { resolveCompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-config.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, extractionArtifactRequests } from "../../../runs/extraction/request-artifact.js";
import { decodeGeminiGenerateContent } from "../../../runs/extraction/fill/batch/native-codec.js";
import { batchDigest } from "../../../runs/extraction/fill/batch/plan.js";
import type { GeminiBatchLimits, GeminiBatchPlan, GeminiBatchState } from "../../../runs/extraction/fill/batch/contract.js";
import { buildAuthorityQuestion, registerExtractionFillHooks, setExtractionCredentialFixture, buildExtractionFillQuestion } from "./fixture.js";
import { tableCompletedResponse } from "./source-semantic-table-response.test-support.js";

const PROFILE = { contract: "source-interpretation-profile-v1" as const, description: "Completed event structure",
  predicates: [{ symbol: "complete", meaning: "An actor completed a theme.", governing_roles: [] }],
  roles: [{ symbol: "theme", meaning: "The thing completed." }] };
const MODEL = "gemini-2.5-flash-lite";
const REQUEST_PROFILE = "gemini-2.5-nonthinking-v1" as const;
const VARIANT = "longmemeval_s" as const;
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), VARIANT);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function authoredResponse(userPrompt: string, mode: "semantic" | "unknown_alias" | "duplicate_gap_channel" | "partial" = "semantic") {
  const request = parseSourceSemanticRequest(JSON.parse(userPrompt));
  const assertion = request.source_request.source_assertions.find((row) => row.text.includes("completed"))!;
  const theme = assertion.text.includes("alpha") ? "alpha" : "decoy";
  const envelope = tableCompletedResponse(assertion.assertion_id, theme);
  if (mode === "unknown_alias") envelope.content.nodes[0]!.arguments[0]!.target = { kind: "entity_ref", key: "missing" };
  if (mode === "duplicate_gap_channel" || mode === "partial") {
    const gaps = [{ kind: "unresolved_referent", affected: [{ kind: "entity_ref", key: "theme" }],
      support: { assertion_id: assertion.assertion_id, text: theme } }];
    if (mode === "partial") envelope.content.gaps = gaps;
    else (envelope.outcome as { gaps?: typeof gaps }).gaps = gaps;
  }
  return JSON.stringify(envelope);
}

async function setup(providerUrl = "https://fixture-provider.invalid", questionOnly = false, revise: boolean | "complete_invalid_json" = false,
  sourcePacking: ExtractionSourcePacking = "reference-eight") {
  setExtractionCredentialFixture(); vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", providerUrl);
  await writeDataset([questionOnly
    ? buildExtractionFillQuestion("questions", "Where is the atlas?", "When will Talia leave?")
    : sourcePacking === "complete-source" ? buildExtractionFillQuestion("q0",
      "I completed alpha. The room was quiet. The desk was clear. The lamp was on. The window was open. " +
      "The door was closed. The shelf was full. The clock was ticking. The floor was clean. It is ready.", "I completed decoy.")
      : buildAuthorityQuestion("q0", "alpha", "decoy")]);
  const limits: GeminiBatchLimits = { maxJobs: 1, maxRequestsPerJob: 100, maxFileBytes: 1000000,
    maxInputTokensPerJob: 1000000, maxEnqueuedTokens: 1000000, maxOutputTokens: 4096,
    maxUsd: 1, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    deadlineMs: 60000, requestTimeoutMs: 5000, maxPolls: 10 };
  const limitsPath = join(cacheRoot, "limits.json"); writeFileSync(limitsPath, JSON.stringify(limits));
  const revisionPath = join(cacheRoot, "revisions.json");
  let generation = EXTRACTION_OPEN_SEMANTICS_GENERATION;
  if (revise) {
    const preview = join(cacheRoot, "base-preview.json");
    expect(await runCli(["extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
      "--extraction-cache-root", cacheRoot, "--extraction-open-semantics", "--batch-operation", "prepare",
      "--batch-limits", limitsPath, "--extraction-preflight-out", preview])).toBe(0);
    const lines = JSON.parse(readFileSync(preview, "utf8")).planned_requests as GeminiBatchPlan["lines"];
    const revisions = lines.map((line) => {
      const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
      if (revise !== "complete_invalid_json") return prepareSourceSemanticRevision(request, authoredResponse(line.userPrompt, "unknown_alias"));
      const completed = decodeGeminiGenerateContent({ candidates: [{ finishReason: "STOP",
        content: { parts: [{ text: authoredResponse(line.userPrompt) + "}" }] } }] });
      return prepareSourceSemanticRevision(request, completed.rawJson, [], { responseCompletion: "complete" });
    });
    generation = { ...generation, revisions };
    writeFileSync(revisionPath, JSON.stringify(revisions));
  }
  const inspection = await inspectExtractionAuthority({ variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
    sourcePacking, openSemantics: generation, revision: readCurrentExtractionAuthorityRevision(), action: "fill" });
  const receipt = createExtractionAuthorityReceipt({ action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 },
    inspection });
  const receiptPath = join(cacheRoot, "authority.json"); writeExtractionAuthorityReceipt(receiptPath, receipt);
  writeFileSync(limitsPath, JSON.stringify({ ...limits, maxUsd: receipt.price.estimated_upper_usd }));
  let creates = 0, displayName = "", failCreate = false;
  let responseMode: "semantic" | "oversize" | "disposition" | "unknown_alias" | "duplicate_gap_channel" | "partial" = "semantic";
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/upload/v1beta/files") return new Response(null, { headers: { "x-goog-upload-url": "https://fixture-provider.invalid/upload-session" } });
    if (path === "/upload-session") return Response.json({ file: { name: "files/input" } });
    if (path.endsWith(":batchGenerateContent")) {
      creates++; displayName = JSON.parse(String(init?.body)).batch.displayName;
      if (failCreate) throw new Error("offline create interrupted");
      return Response.json({ name: "batches/job" });
    }
    if (path === "/v1beta/batches/job") return Response.json({ name: "batches/job", metadata: { displayName,
      model: `models/${MODEL}`, state: "BATCH_STATE_SUCCEEDED", inputConfig: { fileName: "files/input" }, output: { responsesFile: "files/output" } } });
    if (path === "/download/v1beta/files/output:download") return new Response(plan().lines.map((line) => JSON.stringify({ key: line.key,
      response: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: responseMode === "oversize"
        ? "x".repeat(1024 * 1024 + 1) : responseMode === "disposition" ? dispositionResponse(line.userPrompt) : authoredResponse(line.userPrompt, responseMode) }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } } })).join("\n"));
    throw new Error(`unexpected offline request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const args = ["extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics", "--batch-limits", limitsPath,
    "--extraction-source-packing", sourcePacking,
    ...(revise ? ["--extraction-source-revisions", revisionPath] : [])];
  const run = (operation: string, extra: readonly string[] = []) => runCli([...args, "--extraction-authority", receiptPath,
    "--batch-operation", operation, ...extra]);
  const plan = () => JSON.parse(readFileSync(join(cacheRoot, "gemini-batch-plan.json"), "utf8")) as GeminiBatchPlan;
  const state = () => JSON.parse(readFileSync(join(cacheRoot, `batch-state-${plan().identity}.json`), "utf8")) as GeminiBatchState;
  return { run, plan, state, args, fetchMock, receiptPath, keys: inspection.missingKeys,
    creates: () => creates, failCreate: (value: boolean) => { failCreate = value; },
    mode: (mode: typeof responseMode) => { responseMode = mode; } };
}

it("retains the entire source across native authorization, import and cache reopen without fixed-size splitting", async () => {
  const fixture = await setup("https://fixture-provider.invalid", false, false, "complete-source");
  expect(await fixture.run("prepare")).toBe(0);
  expect(fixture.fetchMock).not.toHaveBeenCalled();
  expect(fixture.plan().lines).toHaveLength(2);
  const line = fixture.plan().lines.find(line => line.userPrompt.includes("alpha"))!;
  const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
  expect(request.source_request.source_scope).toBe("complete-source");
  expect(request.source_request.source_assertions).toHaveLength(11);
  expect(request.source_request.source_assertions[9]?.text).toBe("It is ready.");
  expect(request.source_request.source_assertions[10]?.source_role).toBe("assistant");
  expect(await fixture.run("submit")).toBe(0);
  expect(await fixture.run("resume")).toBe(0);
  expect(fixture.creates()).toBe(1);
  expect(readExtractionCacheManifestIdentity(cacheRoot)?.manifest).toMatchObject({ source_packing: "complete-source" });
  expect(inspectCachedSourceSemantic(cacheRoot, line.key, MODEL, REQUEST_PROFILE)).toMatchObject({ status: "hit" });
  const calls = fixture.fetchMock.mock.calls.length;
  expect(await fixture.run("import")).toBe(0);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(calls);
}, 60000);

it("rejects complete-source before preparing a closed extraction generation", () => {
  expect(() => resolveCompileSeedExtractionConfig({ ALAYA_BENCH_EXTRACTION_SOURCE_PACKING: "complete-source" }))
    .toThrow(/complete-source packing requires open semantics/u);
  expect(() => extractionArtifactRequests({ turnContent: "I completed alpha." }, "complete-source"))
    .toThrow(/complete-source packing requires open semantics/u);
  expect(() => extractionArtifactRequests({ turnContent: "I completed alpha." }, "complete-source", PROFILE))
    .toThrow(/complete-source packing requires open semantics/u);
});

it("allows a repaired observer to recover the retained plan while keeping import and dispatch revision-pinned", async () => {
  const fixture = await setup();
  expect(await fixture.run("prepare")).toBe(0);
  expect(await fixture.run("submit")).toBe(0);
  const before = fixture.state().jobs[0]!;
  const planBefore = fixture.plan();
  const originalRevision = readCurrentExtractionAuthorityRevision();
  const revision = vi.spyOn(authorityInspection, "readCurrentExtractionAuthorityRevision").mockReturnValue("f".repeat(40));
  expect(await fixture.run("recover")).toBe(2);
  expect(await fixture.run("recover", ["--batch-local-job", before.id, "--batch-remote-job", before.remoteJob!])).toBe(0);
  expect(fixture.state().jobs[0]).toMatchObject({ status: "succeeded", outcomes: {}, submittedAt: before.submittedAt,
    attemptOrdinals: before.attemptOrdinals, usageUnknown: true });
  expect(fixture.plan()).toEqual(planBefore);
  const recovered = fixture.state().jobs[0]!;
  const witness = JSON.parse(readFileSync(join(cacheRoot,
    `batch-poll-${batchDigest(`${recovered.id}:${recovered.polls}`)}.json`), "utf8"));
  expect(witness.recovery).toEqual({ authority: originalRevision, observer: "f".repeat(40) });
  const calls = fixture.fetchMock.mock.calls.length;
  for (const operation of ["submit", "resume", "status", "import"]) expect(await fixture.run(operation)).toBe(2);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(calls);
  revision.mockReturnValue(originalRevision);
  expect(await fixture.run("import")).toBe(0);
  expect(fixture.creates()).toBe(1);
  for (const key of fixture.keys) expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE)).toMatchObject({ status: "hit" });
}, 60000);

it.each([true, "complete_invalid_json"] as const)("binds explicit revisions (%s) through native authority, plan, import and reopened typed cache", async (revisionMode) => {
  const fixture = await setup("https://fixture-provider.invalid", false, revisionMode);
  expect(await fixture.run("prepare")).toBe(0);
  expect(fixture.fetchMock).not.toHaveBeenCalled();
  for (const line of fixture.plan().lines) {
    const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
    expect(request.source_request.revision?.revision_number).toBe(1);
    expect(request.source_request.revision?.structural_diagnostics.length).toBeGreaterThan(0);
    if (revisionMode === "complete_invalid_json") {
      expect(request.source_request.revision?.contract).toBe("source-semantic-revision-v2");
      expect(request.source_request.revision?.structural_diagnostics[0]?.code).toBe("invalid_json");
    }
  }
  expect(await fixture.run("submit")).toBe(0);
  expect(await fixture.run("resume")).toBe(0);
  expect(fixture.creates()).toBe(1);
  const manifest = readExtractionCacheManifestIdentity(cacheRoot)!.manifest;
  expect(manifest.source_semantic_generation?.revisions).toHaveLength(2);
  expect(() => resolveCompileSeedExtractionConfig(process.env, manifest, undefined, undefined, true)).toThrow(/generation/u);
  for (const line of fixture.plan().lines) {
    expect(inspectCachedSourceSemantic(cacheRoot, line.key, MODEL, REQUEST_PROFILE)).toMatchObject({ status: "hit" });
  }
});

it("preflights without a grant, then prepare-submit-resume-import-reopen stays offline and unbound", async () => {
  const fixture = await setup();
  const out = join(cacheRoot, "preflight.json");
  expect(await runCli([...fixture.args, "--batch-operation", "prepare", "--extraction-preflight-out", out])).toBe(0);
  expect(fixture.fetchMock).not.toHaveBeenCalled();
  const preview = JSON.parse(readFileSync(out, "utf8"));
  expect(preview).toMatchObject({ execution_authorized: false, provider_calls: 0, selected_requests: 2 });
  expect(readExtractionCacheManifestIdentity(cacheRoot)).toBeUndefined();
  expect(preview.planned_requests.map((line: { key: string }) => line.key)).toEqual(fixture.keys);
  expect(await fixture.run("prepare")).toBe(0); expect(fixture.fetchMock).not.toHaveBeenCalled();
  expect(await fixture.run("submit")).toBe(0); expect(await fixture.run("resume")).toBe(0);
  const calls = fixture.fetchMock.mock.calls.length;
  expect(await fixture.run("import")).toBe(0); expect(await fixture.run("import")).toBe(0);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(calls); expect(fixture.creates()).toBe(1);
  const identity = readExtractionCacheManifestIdentity(cacheRoot)!;
  expect(identity.manifest).toMatchObject({
    source_semantic_generation: EXTRACTION_OPEN_SEMANTICS_GENERATION, fill_status: "complete"
  });
  expect(identity.manifest).not.toHaveProperty("source_interpretation_profile");
  expect(() => resolveCompileSeedExtractionConfig(process.env, identity.manifest)).toThrow(/explicit matching opt-in/u);
  const key = fixture.plan().lines.find((line) => line.userPrompt.includes("alpha"))!.key;
  expect(inspectCachedExtraction(cacheRoot, key, MODEL, REQUEST_PROFILE)).toMatchObject({ status: "invalid" });
  expect(inspectCachedSourcePacket(cacheRoot, key, MODEL, REQUEST_PROFILE)).toMatchObject({ status: "invalid" });
  const cached = inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE);
  expect(cached).toMatchObject({ status: "hit", sourceBinding: "unbound" });
  if (cached.status === "hit") expect(cached.admitted.outcome.status).toBe("interpreted");
  const authorityPath = join(cacheRoot, `batch-authority-${fixture.plan().identity}.json`);
  const retained = readFileSync(authorityPath, "utf8");
  rmSync(authorityPath);
  expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("invalid");
  writeFileSync(authorityPath, retained);
  expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE)).toMatchObject({ status: "hit" });
}, 60000);

it("records a lost create as unknown and refuses a second dispatch until exact reconciliation", async () => {
  const fixture = await setup();
  expect(await fixture.run("prepare")).toBe(0);
  fixture.failCreate(true);
  expect(await fixture.run("submit")).toBe(2);
  expect(fixture.creates()).toBe(1);
  expect(fixture.state().jobs[0]?.status).toBe("submission_unknown");
  fixture.failCreate(false);
  expect(await fixture.run("submit")).toBe(0);
  expect(fixture.creates()).toBe(1);
  expect(fixture.state().jobs[0]?.status).toBe("submission_unknown");
  const job = fixture.state().jobs[0]!;
  expect(await fixture.run("status", ["--batch-local-job", job.id, "--batch-remote-job", "batches/job"])).toBe(0);
  expect(await fixture.run("resume")).toBe(0);
  expect(await fixture.run("import")).toBe(0);
  expect(fixture.creates()).toBe(1);
  for (const key of fixture.keys) expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE)).toMatchObject({ status: "hit" });
}, 60000);

it.each(["unknown_alias", "duplicate_gap_channel"] as const)("retains %s admission diagnostics across native Batch import and reopen", async (mode) => {
  const fixture = await setup(); fixture.mode(mode);
  expect(await fixture.run("prepare")).toBe(0);
  expect(await fixture.run("submit")).toBe(0);
  expect(await fixture.run("resume")).toBe(0);
  const calls = fixture.fetchMock.mock.calls.length;
  expect(await fixture.run("import")).toBe(0);
  const outcomes = fixture.state().jobs[0]!.outcomes;
  for (const line of fixture.plan().lines) {
    const outcome = outcomes[line.key]!;
    expect(outcome.status).toBe("quarantined");
    expect(outcome.reason).toContain(mode === "unknown_alias" ? "missing_entity: missing" : "unrecognized_keys");
    if (mode === "duplicate_gap_channel") expect(outcome.reason).toContain('"path":["outcome"]');
    expect(outcome.reason).toContain("raw_response_id=sha256:");
    expect(outcome.reason!.length).toBeLessThan(16384);
    expect(inspectCachedSourceSemantic(cacheRoot, line.key, MODEL, REQUEST_PROFILE).status).not.toBe("hit");
  }
  expect(await fixture.run("import")).toBe(0);
  expect(fixture.state().jobs[0]!.outcomes).toEqual(outcomes);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(calls);
  const job = fixture.state().jobs[0]!;
  expect(readFileSync(join(cacheRoot, `batch-output-${job.id}.jsonl`), "utf8")).toContain("STOP");
}, 60000);

it("preserves partial interpretation gaps through native Batch cache replay", async () => {
  const fixture = await setup(); fixture.mode("partial");
  expect(await fixture.run("prepare")).toBe(0); expect(await fixture.run("submit")).toBe(0);
  expect(await fixture.run("resume")).toBe(0); expect(await fixture.run("import")).toBe(0);
  for (const line of fixture.plan().lines) {
    const cached = inspectCachedSourceSemantic(cacheRoot, line.key, MODEL, REQUEST_PROFILE);
    expect(cached.status).toBe("hit");
    if (cached.status !== "hit") throw new Error("partial semantics must replay");
    expect(cached.admitted.draft?.gaps).toHaveLength(1);
    expect(cached.admitted.outcome).toEqual({ status: "interpreted", gaps: cached.admitted.interpretation?.gaps });
    expect(cached.admitted.interpretation?.gaps).toEqual(expect.arrayContaining([...cached.admitted.draft!.gaps]));
  }
}, 60000);

it("rejects combining open semantics with a packet profile", async () => {
  const fixture = await setup();
  const profilePath = join(cacheRoot, "..", "profile.json");
  writeFileSync(profilePath, JSON.stringify(PROFILE));
  expect(await runCli([...fixture.args, "--extraction-packet-profile", profilePath, "--batch-operation", "prepare"])).toBe(2);
  expect(fixture.fetchMock).not.toHaveBeenCalled();
  expect(readExtractionCacheManifestIdentity(cacheRoot)).toBeUndefined();
});

it("does not let a packet-profile cache satisfy open generation", async () => {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  await writeDataset([buildAuthorityQuestion("q0", "alpha", "decoy")]);
  const profilePath = join(cacheRoot, "..", "profile.json");
  writeFileSync(profilePath, JSON.stringify(PROFILE));
  const inspection = await inspectExtractionAuthority({ variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
    sourceInterpretationProfile: PROFILE, revision: readCurrentExtractionAuthorityRevision(), action: "fill" });
  const receipt = createExtractionAuthorityReceipt({ action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 },
    inspection });
  const receiptPath = join(cacheRoot, "authority.json"); writeExtractionAuthorityReceipt(receiptPath, receipt);
  const limitsPath = join(cacheRoot, "limits.json");
  writeFileSync(limitsPath, JSON.stringify({ maxJobs: 1, maxRequestsPerJob: 100, maxFileBytes: 1000000,
    maxInputTokensPerJob: 1000000, maxEnqueuedTokens: 1000000, maxOutputTokens: 4096,
    maxUsd: receipt.price.estimated_upper_usd, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    deadlineMs: 60000, requestTimeoutMs: 5000, maxPolls: 10 }));
  const packetArgs = ["extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-packet-profile", profilePath, "--batch-limits", limitsPath];
  expect(await runCli([...packetArgs, "--extraction-authority", receiptPath, "--batch-operation", "prepare"])).toBe(0);
  const packetManifest = readExtractionCacheManifestIdentity(cacheRoot)!.manifest;
  expect(packetManifest.source_interpretation_profile).toEqual(PROFILE);
  expect(packetManifest.source_semantic_generation).toBeUndefined();
  expect(await runCli(["extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics", "--batch-limits", limitsPath,
    "--extraction-authority", receiptPath, "--batch-operation", "prepare"])).toBe(2);
  expect(() => resolveCompileSeedExtractionConfig(process.env, packetManifest, undefined, undefined, true))
    .toThrow(/explicit matching opt-in/u);
  await expect(runExtractionFill({ variant: VARIANT, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, cacheRoot }))
    .rejects.toThrow(/explicit matching opt-in/u);
}, 60000);

it("enforces the 32 MiB shard bound and the 1 MiB envelope before reservation or admission", async () => {
  const fixture = await setup();
  const previewPath = join(cacheRoot, "bounded-preview.json");
  expect(await runCli([...fixture.args, "--batch-operation", "prepare", "--extraction-preflight-out", previewPath])).toBe(0);
  const line = JSON.parse(readFileSync(previewPath, "utf8")).planned_requests[0];
  expect(() => assertSourceSemanticShardCapacity("s".repeat(20 * 1024 * 1024), line)).toThrow(/before reservation/u);
  expect(() => assertSourceSemanticShardCapacity("source", { ...line, unitKeys: ["x".repeat(20 * 1024 * 1024)] })).toThrow(/before reservation/u);
  expect(fixture.fetchMock).not.toHaveBeenCalled();
  fixture.mode("oversize");
  expect(await fixture.run("prepare")).toBe(0);
  expect(await fixture.run("submit")).toBe(0);
  expect(await fixture.run("resume")).toBe(0);
  expect(fixture.creates()).toBe(1);
  for (const key of fixture.keys) {
    expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE).status).not.toBe("hit");
  }
}, 60000);

function dispositionResponse(userPrompt: string): string {
  const request = parseSourceSemanticRequest(JSON.parse(userPrompt)), row = request.source_request.source_assertions[0]!;
  return JSON.stringify({ contract: request.source_request.proposal_contract, outcome: {
    status: "no_executable_proposition", description: "Unreviewed producer disposition",
    context_support: [{ assertion_id: row.assertion_id, text: row.text }]
  } });
}
it("imports and reopens a legal no-proposition disposition without changing it to abstention", async () => {
  const fixture = await setup(); fixture.mode("disposition");
  expect(await fixture.run("prepare")).toBe(0); expect(await fixture.run("submit")).toBe(0);
  expect(await fixture.run("resume")).toBe(0);
  expect(await fixture.run("import")).toBe(0);
  for (const line of fixture.plan().lines) {
    const inspected = inspectCachedSourceSemantic(cacheRoot, line.key, MODEL, REQUEST_PROFILE);
    expect(inspected.status).toBe("hit");
    if (inspected.status !== "hit") throw new Error("disposition must remain a retained cache hit");
    expect(inspected.admitted.outcome.status).toBe("no_executable_proposition");
    expect(inspected.admitted.draft).toBeUndefined();
    expect(inspected.parsedDraftCount).toBe(0);
    expect(inspected.deterministicEmpty).toBe(false);
  }
});


it("plans question-only rounds through native authority and Batch without collapsing them into host-empty source", async () => {
  const fixture = await setup(undefined, true);
  expect(fixture.keys).toHaveLength(2);
  expect(await fixture.run("prepare")).toBe(0);
  expect(fixture.fetchMock).not.toHaveBeenCalled();
  expect(fixture.plan().lines).toHaveLength(2);
  const rows = fixture.plan().lines.flatMap((line) => parseSourceSemanticRequest(JSON.parse(line.userPrompt)).source_request.source_assertions);
  expect(rows.map((row) => row.text)).toEqual(expect.arrayContaining([
    "User: Where is the atlas?", "User: When will Talia leave?", "Assistant: Acknowledged."
  ]));
  expect(rows.find((row) => row.text === "Assistant: Acknowledged.")?.source_role).toBe("assistant");
}, 60000);
