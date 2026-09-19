import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { runCli } from "../../../cli/cli.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { assertSourceSemanticShardCapacity, inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { inspectCachedExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";
import { inspectCachedSourcePacket } from "../../../runs/extraction/cache/source-packet-artifact.js";
import { readExtractionCacheManifestIdentity } from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { resolveCompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-config.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import type { GeminiBatchLimits, GeminiBatchPlan, GeminiBatchState } from "../../../runs/extraction/fill/batch/contract.js";
import { buildAuthorityQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";

const PROFILE = { contract: "source-interpretation-profile-v1" as const, description: "Completed event structure",
  predicates: [{ symbol: "complete", meaning: "An actor completed a theme.", governing_roles: [] }],
  roles: [{ symbol: "theme", meaning: "The thing completed." }] };
const MODEL = "gemini-2.5-flash-lite";
const REQUEST_PROFILE = "gemini-2.5-nonthinking-v1" as const;
const VARIANT = "longmemeval_s" as const;
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), VARIANT);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function authoredResponse(userPrompt: string) {
  const request = parseSourceSemanticRequest(JSON.parse(userPrompt));
  const assertion = request.source_request.source_assertions.find((row) => row.text.includes("completed"))!;
  const catalog = request.source_catalog.assertions.find((row) => row.assertion_id === assertion.assertion_id)!;
  const segment = (text: string) => catalog.segments.find((row) => row.text === text)!;
  const mention = (id: string, text: string) => ({
    id, assertion_id: assertion.assertion_id, source_ref: { first: segment(text).id, last: segment(text).id }
  });
  const theme = assertion.text.includes("alpha") ? "alpha" : "decoy";
  return JSON.stringify({
    contract: "source-interpretation-response-v3",
    outcome: { status: "interpreted", gaps: [] },
    draft: {
      contract: "source-interpretation-v3",
      mentions: [mention("m0", "completed"), mention("m1", theme)],
      referents: [{ id: "r0", referent_kind: "grouped", mentions: ["m1"] }],
      frames: [{
        id: "f0", assertion_ids: [assertion.assertion_id],
        context_owner: { kind: "source_act", source_act: "assertion" },
        additional_support: [],
        predicate_support: { kind: "explicit", reading: "complete", mentions: ["m0"] },
        slots: [{ id: "theme", role_reading: "theme", support: [{ kind: "lexical", mentions: ["m1"] }] }],
        bindings: [{ slot_id: "theme", target: { kind: "node", id: "r0" }, support: [] }]
      }],
      operators: [],
      gaps: []
    }
  });
}

async function setup(providerUrl = "https://fixture-provider.invalid") {
  setExtractionCredentialFixture(); vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", providerUrl);
  await writeDataset([buildAuthorityQuestion("q0", "alpha", "decoy")]);
  const inspection = await inspectExtractionAuthority({ variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
    openSemantics: true, revision: readCurrentExtractionAuthorityRevision(), action: "fill" });
  const receipt = createExtractionAuthorityReceipt({ action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 },
    inspection });
  const receiptPath = join(cacheRoot, "authority.json"); writeExtractionAuthorityReceipt(receiptPath, receipt);
  const limits: GeminiBatchLimits = { maxJobs: 1, maxRequestsPerJob: 100, maxFileBytes: 1000000,
    maxInputTokensPerJob: 1000000, maxEnqueuedTokens: 1000000, maxOutputTokens: 4096,
    maxUsd: receipt.price.estimated_upper_usd, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    deadlineMs: 60000, requestTimeoutMs: 5000, maxPolls: 10 };
  const limitsPath = join(cacheRoot, "limits.json"); writeFileSync(limitsPath, JSON.stringify(limits));
  let creates = 0, displayName = "", failCreate = false, responseMode: "semantic" | "oversize" | "disposition" = "semantic";
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
      response: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: responseMode === "semantic"
        ? authoredResponse(line.userPrompt) : responseMode === "disposition" ? dispositionResponse(line.userPrompt) : "x".repeat(1024 * 1024 + 1) }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } } })).join("\n"));
    throw new Error(`unexpected offline request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const args = ["extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics", "--batch-limits", limitsPath];
  const run = (operation: string, extra: readonly string[] = []) => runCli([...args, "--extraction-authority", receiptPath,
    "--batch-operation", operation, ...extra]);
  const plan = () => JSON.parse(readFileSync(join(cacheRoot, "gemini-batch-plan.json"), "utf8")) as GeminiBatchPlan;
  const state = () => JSON.parse(readFileSync(join(cacheRoot, `batch-state-${plan().identity}.json`), "utf8")) as GeminiBatchState;
  return { run, plan, state, args, fetchMock, receiptPath, keys: inspection.missingKeys,
    creates: () => creates, failCreate: (value: boolean) => { failCreate = value; },
    mode: (mode: typeof responseMode) => { responseMode = mode; } };
}

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
    .rejects.toThrow(/explicit isolated Batch/u);
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
  const request = parseSourceSemanticRequest(JSON.parse(userPrompt)), row = request.source_catalog.assertions[0]!;
  return JSON.stringify({ contract: "source-interpretation-response-v3", outcome: {
    status: "no_executable_proposition", description: "Unreviewed producer disposition",
    context_support: [{ kind: "source_reference", assertion_id: row.assertion_id,
      source_ref: { first: row.segments[0]!.id, last: row.segments.at(-1)!.id } }]
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
