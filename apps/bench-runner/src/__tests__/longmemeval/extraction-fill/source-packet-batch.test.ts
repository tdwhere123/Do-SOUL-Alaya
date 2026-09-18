import { buildExtractionTransportProvenance } from "../../../runs/extraction/transport-route.js";
import { assertLedgerSuccessfulShard, readValidLedgerShard } from "../../../runs/extraction/authority/attempt-ledger-shards.js";
import { canonicalBatchPlan, prepareBatchJobs } from "../../../runs/extraction/fill/batch/plan.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createFreshRetiredSourceRebuildTargetSelection, writeExtractionTargetSelectionReceipt } from "../../../runs/extraction/authority/target-selection/receipt.js";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalJson, sourceReferenceResolver, sourceInterpretationRelationKey, type QueryProgram } from "@do-soul/alaya-protocol";
import { parseOfficialApiSourcePacketRequest } from "@do-soul/alaya-soul";
import { createAuditedSourceAdmission, EvidenceService, fieldContractSha256 } from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { runCli } from "../../../cli/cli.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { assertSourcePacketShardCapacity, inspectCachedSourcePacket, publishCachedSourcePacket } from "../../../runs/extraction/cache/source-packet-artifact.js";
import { cacheFilePath, inspectCachedExtraction, inspectCachedRawExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";
import { readExtractionCacheManifestIdentity } from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { resolveCompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-config.js";
import type { GeminiBatchLimits, GeminiBatchPlan } from "../../../runs/extraction/fill/batch/contract.js";
import * as durable from "../../../runs/extraction/fill/manifest/durable-exclusive-publication.js";
import { createRecallRealStorage, REAL_SQLITE_TEST_WORKSPACE_ID as WS, REAL_SQLITE_TEST_RUN_ID as RUN }
  from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { createDaemonFieldRepos } from "../../../../../core-daemon/src/runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../../../core-daemon/src/runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerClient } from "../../../../../core-daemon/src/runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl } from "../../../../../core-daemon/src/__tests__/runtime/recall/recall-read-worker-client-fixture.js";
import { buildAuthorityQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";

const PROFILE = { contract: "source-interpretation-profile-v1" as const, description: "Completed event structure",
  predicates: [{ symbol: "complete", meaning: "An actor completed a theme.", governing_roles: [] }],
  roles: [{ symbol: "theme", meaning: "The thing completed." }] };
const MODEL = "gemini-2.5-flash-lite";
const REQUEST_PROFILE = "gemini-2.5-nonthinking-v1" as const;
const VARIANT = "longmemeval_s" as const;
const CLOCK = "2026-09-18T00:00:00.000Z";
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), VARIANT);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function authoredResponse(userPrompt: string) {
  const request = parseOfficialApiSourcePacketRequest(JSON.parse(userPrompt));
  const assertion = request.source_request.source_assertions.find((row) => row.text.includes("completed"))!;
  const resolver = sourceReferenceResolver(request.source_catalog, fieldContractSha256);
  const theme = assertion.text.includes("alpha") ? "alpha" : "decoy";
  const mention = (id: string, text: string) => { const start = assertion.text.indexOf(text);
    return { id, assertion_id: assertion.assertion_id, source_ref: resolver.referenceForSpan(assertion.assertion_id, [start, start + text.length]) }; };
  return JSON.stringify({ contract: "source-interpretation-response-v2", packet: {
    contract: "source-interpretation-v2", profile_id: request.profile_id, source_catalog_id: request.source_catalog.catalog_id,
    mentions: [mention("m0", "completed"), mention("m1", theme)], referents: [{ id: "r0", mentions: ["m1"] }],
    propositions: [{ id: "p0", predicate: "complete", implicit: false, predicate_mentions: ["m0"],
      assertion_ids: [assertion.assertion_id], arguments: [{ role: "theme", target: "r0" }] }], operators: [], roots: ["p0"] } });
}

async function setup(sample = false, includeEmpty = false, providerUrl = "https://fixture-provider.invalid") {
  setExtractionCredentialFixture(); vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", providerUrl);
  await writeDataset(Array.from({ length: sample ? 100 : 1 }, (_, i) => {
    const question = buildAuthorityQuestion(`q${i}`, "alpha", "decoy");
    if (includeEmpty) question.haystack_sessions[1] = [{ role: "user", content: "" }];
    return question;
  }));
  const profilePath = join(cacheRoot, "..", "profile.json"); writeFileSync(profilePath, JSON.stringify(PROFILE));
  const inspection = await inspectExtractionAuthority({ variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
    sourceInterpretationProfile: PROFILE, revision: readCurrentExtractionAuthorityRevision(), action: sample ? "sample" : "fill" });
  let selectionPath: string | undefined;
  let selectionDigest: string | undefined;
  const scope = sample ? createExtractionSampleScope([inspection.missingKeys[0]!], inspection) : undefined;
  if (sample) {
    rmSync(cacheRoot, { recursive: true });
    const selection = createFreshRetiredSourceRebuildTargetSelection({ cacheRoot, operator: "offline-fixture", observation: inspection.observation });
    selectionPath = join(cacheRoot, "..", "target-selection.json");
    writeExtractionTargetSelectionReceipt(selectionPath, selection); selectionDigest = selection.receipt_digest;
  }
  const receipt = createExtractionAuthorityReceipt({ action: sample ? "sample" : "fill", observation: inspection.observation,
    ...(scope === undefined ? {} : { sampleScope: scope, targetSelectionDigest: selectionDigest }),
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 },
    inspection });
  const receiptPath = join(cacheRoot, "authority.json"); writeExtractionAuthorityReceipt(receiptPath, receipt);
  const limits: GeminiBatchLimits = { maxJobs: 1, maxRequestsPerJob: sample ? 1 : 100, maxFileBytes: 1000000,
    maxInputTokensPerJob: 1000000, maxEnqueuedTokens: 1000000, maxOutputTokens: 4096,
    maxUsd: receipt.price.estimated_upper_usd, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    deadlineMs: 60000, requestTimeoutMs: 5000, maxPolls: 10 };
  const limitsPath = join(cacheRoot, "limits.json"); writeFileSync(limitsPath, JSON.stringify(limits));
  let creates = 0, displayName = "", responseMode: "packet" | "empty" | "malformed" = "packet";
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/upload/v1beta/files") return new Response(null, { headers: { "x-goog-upload-url": "https://fixture-provider.invalid/upload-session" } });
    if (path === "/upload-session") return Response.json({ file: { name: "files/input" } });
    if (path.endsWith(":batchGenerateContent")) { creates++; displayName = JSON.parse(String(init?.body)).batch.displayName; return Response.json({ name: "batches/job" }); }
    if (path === "/v1beta/batches/job") return Response.json({ name: "batches/job", metadata: { displayName,
      model: `models/${MODEL}`, state: "BATCH_STATE_SUCCEEDED", inputConfig: { fileName: "files/input" }, output: { responsesFile: "files/output" } } });
    if (path === "/download/v1beta/files/output:download") return new Response(plan().lines.map((line) => JSON.stringify({ key: line.key,
      response: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: responseMode === "packet" ? authoredResponse(line.userPrompt)
        : responseMode === "empty" ? '{"contract":"source-interpretation-response-v2","packet":null}' : "{" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } } })).join("\n"));
    throw new Error(`unexpected offline request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const args = ["extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-packet-profile", profilePath, "--batch-limits", limitsPath];
  const run = (operation: string) => runCli([...args, "--extraction-authority", receiptPath, "--batch-operation", operation,
    ...(selectionPath === undefined ? [] : ["--extraction-target-selection", selectionPath, "--limit", "100"])]);
  const plan = () => JSON.parse(readFileSync(join(cacheRoot, "gemini-batch-plan.json"), "utf8")) as GeminiBatchPlan;
  return { run, plan, args, fetchMock, profilePath, receiptPath, limits, keys: inspection.missingKeys, selectedKeys: scope?.keys,
    creates: () => creates, mode: (mode: typeof responseMode) => { responseMode = mode; } };
}

it("preflights without authority, imports typed packets through the real CLI and reasons from the persisted artifact", async () => {
  const setupResult = await setup();
  const { run, args, fetchMock, keys, plan } = setupResult;
  const out = join(cacheRoot, "preflight.json");
  expect(await runCli([...args, "--batch-operation", "prepare", "--extraction-preflight-out", out])).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
  const preview = JSON.parse(readFileSync(out, "utf8"));
  expect(preview).toMatchObject({ execution_authorized: false, provider_calls: 0, selected_requests: 2 });
  expect(readExtractionCacheManifestIdentity(cacheRoot)).toBeUndefined();
  expect(preview.planned_requests.map((line: { key: string }) => line.key)).toEqual(keys);
  expect(await run("prepare")).toBe(0); expect(fetchMock).not.toHaveBeenCalled();
  expect(await run("submit")).toBe(0); expect(await run("resume")).toBe(0);
  const calls = fetchMock.mock.calls.length;
  expect(await run("import")).toBe(0); expect(fetchMock).toHaveBeenCalledTimes(calls); expect(setupResult.creates()).toBe(1);
  expect(readExtractionCacheManifestIdentity(cacheRoot)!.manifest).toMatchObject({ source_interpretation_profile: PROFILE, fill_status: "complete" });
  expect(() => resolveCompileSeedExtractionConfig(process.env, readExtractionCacheManifestIdentity(cacheRoot)!.manifest)).toThrow(/explicit matching opt-in/u);
  const key = plan().lines.find((line) => line.userPrompt.includes("alpha"))!.key;
  expect(key).toMatch(/^[a-f0-9]{64}$/u);
  expect(inspectCachedExtraction(cacheRoot, key, MODEL, REQUEST_PROFILE)).toMatchObject({ status: "invalid" });
  expect(inspectCachedRawExtraction(cacheRoot, key, MODEL, REQUEST_PROFILE)).toMatchObject({ status: "hit" });
  const cached = inspectCachedSourcePacket(cacheRoot, key, MODEL, REQUEST_PROFILE);
  if (cached.status !== "hit" || cached.admitted.status !== "received") throw new Error("typed draft absent");
  expect(cached.admitted.draft.source).toContain("User: I completed alpha.");
  const stored = JSON.parse(readFileSync(cacheFilePath(cacheRoot, key), "utf8"));
  expect(stored.source_packet.plan).toBeUndefined();
  expect(stored.source_packet.plan_identity).toBe(plan().identity);
  await consumeCachedPacket(key, cached.admitted.draft.source);
}, 60000);

it("replays an interruption after typed durability without a second reservation or provider create", async () => {
  const fixture = await setup(); await fixture.run("prepare"); await fixture.run("submit");
  const original = durable.replaceBytesDurable;
  let interrupted = false;
  vi.spyOn(durable, "replaceBytesDurable").mockImplementation((input) => {
    original(input);
    if (!interrupted && /(?:^|[\\/])[a-f0-9]{2}[\\/][a-f0-9]{64}\.json$/u.test(input.destination)) {
      interrupted = true; throw new Error("offline interruption after typed artifact publication");
    }
  });
  expect(await fixture.run("resume")).toBe(2); expect(interrupted).toBe(true);
  expect(await fixture.run("import")).toBe(0); expect(await fixture.run("import")).toBe(0);
  expect(fixture.creates()).toBe(1);
  for (const key of fixture.keys) expect(inspectCachedSourcePacket(cacheRoot, key, MODEL, REQUEST_PROFILE)).toMatchObject({ status: "hit" });
}, 60000);

it.each(["empty", "malformed"] as const)("keeps a %s response distinct from an admitted packet proof", async (mode) => {
  const fixture = await setup(); fixture.mode(mode); await fixture.run("prepare"); await fixture.run("submit");
  expect(await fixture.run("resume")).toBe(0);
  for (const key of fixture.keys) {
    const cached = inspectCachedSourcePacket(cacheRoot, key, MODEL, REQUEST_PROFILE);
    expect(cached.status).toBe(mode === "empty" ? "hit" : "missing");
    if (cached.status === "hit") expect(cached.admitted.status).toBe("empty");
  }
}, 60000);

it("rejects profile generation and transport drift before dispatch and rejects malformed stored provenance", async () => {
  const fixture = await setup(); expect(await fixture.run("prepare")).toBe(0);
  writeFileSync(fixture.profilePath, JSON.stringify({ ...PROFILE, description: "Changed semantic meaning" }));
  expect(await fixture.run("submit")).toBe(2); expect(fixture.fetchMock).not.toHaveBeenCalled();
  writeFileSync(fixture.profilePath, JSON.stringify(PROFILE));
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_TRANSPORT_MODEL", "gemini-2.5-flash");
  expect(await fixture.run("submit")).toBe(2); expect(fixture.fetchMock).not.toHaveBeenCalled();
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_TRANSPORT_MODEL", "");
  expect(await fixture.run("submit")).toBe(0); expect(await fixture.run("resume")).toBe(0);
  const key = fixture.keys[0]!, path = cacheFilePath(cacheRoot, key), original = readFileSync(path, "utf8");
  const identity = { model: MODEL, requestProfile: REQUEST_PROFILE };
  const successful = readValidLedgerShard(cacheRoot, key, identity)!;
  expect(successful).toBeDefined();
  type WritableShard = {
    source_packet: {
      plan_identity: string;
      authority_receipt_digest: string;
      result: { provenance: Record<string, unknown> & { usage: { inputTokens: number } } };
    };
    admission_identity: { generation_sha256: string };
    response_metadata: { usage: { input_tokens: number } };
  };
  const corruptions: ReadonlyArray<(value: WritableShard) => void> = [
    (value) => { value.source_packet.result.provenance.attemptOrdinal = 0; },
    (value) => { value.source_packet.result.provenance.attemptOrdinal = 99; },
    (value) => { value.source_packet.result.provenance.job = "batches/unrelated"; },
    ...["inputSha256", "outputSha256", "responseSha256"].map((field) => (value: WritableShard) => {
      value.source_packet.result.provenance[field] = "e".repeat(64);
    }),
    (value) => { value.source_packet.result.provenance.finishReason = "MAX_TOKENS"; },
    (value) => { value.source_packet.plan_identity = "f".repeat(64); },
    (value) => { value.source_packet.authority_receipt_digest = "f".repeat(64); },
    (value) => { value.admission_identity.generation_sha256 = "f".repeat(64); },
    (value) => { value.response_metadata.usage.input_tokens += 1; },
    (value) => { value.source_packet.result.provenance.usage.inputTokens += 1; }
  ];
  for (const mutate of corruptions) {
    const value = JSON.parse(original) as WritableShard;
    mutate(value);
    writeFileSync(path, JSON.stringify(value));
    expect(inspectCachedRawExtraction(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("invalid");
    expect(() => assertLedgerSuccessfulShard(cacheRoot, successful, identity)).toThrow(/closure drifted/u);
    await expect(publishCachedSourcePacket({ cacheRoot, cacheKey: key, config: identity,
      owner: undefined as never, workspaceId: WS, runId: RUN, sourceId: "original-message" })).rejects.toThrow(/artifact unavailable/u);
  }
  writeFileSync(path, original);
  await expect(runExtractionFill({ variant: VARIANT, sourceInterpretationProfile: PROFILE, cacheRoot }))
    .rejects.toThrow(/explicit isolated Batch/u);
}, 60000);

it("keeps a selected packet sample inside the original hundred-question scope and spends once", async () => {
  const fixture = await setup(true), proposed = join(cacheRoot, "..", "preflight-keys.json"), out = join(cacheRoot, "sample-preflight.json");
  writeFileSync(proposed, JSON.stringify(fixture.selectedKeys));
  expect(await runCli([...fixture.args, "--limit", "100", "--batch-operation", "prepare", "--extraction-preflight-out", out,
    "--extraction-preflight-keys", proposed])).toBe(0);
  const preview = JSON.parse(readFileSync(out, "utf8"));
  expect(preview).toMatchObject({ total_requests: 2, selected_requests: 1, selected_keys: fixture.selectedKeys });
  expect(fixture.fetchMock).not.toHaveBeenCalled();
  expect(await fixture.run("prepare")).toBe(0);
  expect(fixture.plan().lines.map((line) => line.key)).toEqual(fixture.selectedKeys);
  expect(await fixture.run("submit")).toBe(0); expect(await fixture.run("resume")).toBe(0);
  expect(await fixture.run("import")).toBe(0); expect(fixture.creates()).toBe(1);
  expect(readExtractionCacheManifestIdentity(cacheRoot)!.manifest).toMatchObject({ fill_status: "in_progress", expected_turns: 2, cached_turns: 1 });
}, 60000);

async function consumeCachedPacket(key: string, source: string) {
  const filename = join(cacheRoot, "native.sqlite");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const eventLogRepo = new SqliteEventLogRepo(database), runtimeNotifier = { notifyEntry: async () => undefined };
  const evidenceService = new EvidenceService({ eventLogRepo, runtimeNotifier, evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK });
  await createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 }).admit({
    workspace_id: WS, source_id: "original-message", source_version: "1", content_bytes: source,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(source) }, { workspaceId: WS });
  await expect(publishCachedSourcePacket({ cacheRoot, cacheKey: key, config: { model: MODEL, requestProfile: REQUEST_PROFILE },
    owner: { stores, evidenceService, sha256: fieldContractSha256 }, workspaceId: WS, runId: RUN, sourceId: "wrong-source" })).rejects.toThrow(/not currently admitted/u);
  expect(database.connection.prepare("SELECT count(*) AS n FROM evidence_capsules").get()).toEqual({ n: 0 });
  const publication = await publishCachedSourcePacket({ cacheRoot, cacheKey: key, config: { model: MODEL, requestProfile: REQUEST_PROFILE },
    owner: { stores, evidenceService, sha256: fieldContractSha256 }, workspaceId: WS, runId: RUN, sourceId: "original-message" });
  if (publication.status !== "published") throw new Error("expected audited publication");
  expect(database.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
  expect(database.connection.prepare("SELECT count(*) AS n FROM relation_assertions").get()).toEqual({ n: 0 });
  database.close(); closeCachedDatabase(filename);
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  const rel = (kind: "asserted" | "role", symbol: string, from: string, to: string): QueryProgram => ({
    schema_version: 1, kind: "relation", relation_kind: sourceInterpretationRelationKey(kind, symbol), source_variable: from, target_variable: to,
    guard: { schema_version: 1, kind: "query_predicate", verdict: "unresolved", time_scope: "none" }, facet_mode: "same_path", threshold_milligrades: 0 });
  try { await client.ready(); const result = await client.sourceInterpretationPort!.reason({ workspace_id: WS, as_of: CLOCK,
    authorized_scopes: { mode: "named", scopes: ["project"] }, request: {
      contract: "source-interpretation-reasoning-v1", accepts_unreviewed_conditional_results: true,
      packet_id: publication.bound.packet_id, profile_id: publication.bound.packet.profile_id,
      original_query: "What was completed?", seed_nodes: ["p0"],
      program: { schema_version: 1, kind: "sequence", steps: [rel("asserted", "complete", "event", "event"), rel("role", "theme", "event", "theme")] },
      budget: { schema_version: 1, work_units: 200000, memory_bytes: 20000000, page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 },
      output_byte_limit: 1000000 } });
    expect(result.index?.entries.map((row) => row.interpretation_node?.node_id)).toEqual(["r0"]);
    expect(result.interpretation_packet?.mention_spans.find((row) => row.id === "m1")?.text).toBe("alpha");
    expect(result.premises.map((row) => [row.statement_id, row.from_node, row.to_node]).sort()).toEqual([["p0", "p0", "p0"], ["p0", "p0", "r0"]]);
    expect(result.interpretation).toMatchObject({ semantic_status: "unreviewed", world_claim: "unknown" });
    expect(canonicalJson(result.interpretation_packet)).toBe(canonicalJson(publication.bound));
  } finally { await client.close(); closeCachedDatabase(filename); }
}

it("completes typed empty sources without provider lines or attempts and preserves them on reopen", async () => {
  const fixture = await setup(false, true);
  expect(await fixture.run("prepare")).toBe(0);
  expect(fixture.plan().lines).toHaveLength(1);
  expect(await fixture.run("submit")).toBe(0);
  expect(await fixture.run("resume")).toBe(0);
  expect(await fixture.run("import")).toBe(0);
  expect(fixture.creates()).toBe(1);
  const emptyKey = fixture.keys.find((key) => !fixture.plan().lines.some((line) => line.key === key))!;
  expect(emptyKey).toBeDefined();
  const empty = inspectCachedRawExtraction(cacheRoot, emptyKey, MODEL, REQUEST_PROFILE);
  expect(empty).toMatchObject({ status: "hit", deterministicEmpty: true });
  if (empty.status === "hit") expect(empty.transportProvenance).toBeUndefined();
  expect(readExtractionCacheManifestIdentity(cacheRoot)!.manifest.fill_status).toBe("complete");
}, 60000);

it("rejects full source or selected-line metadata that cannot fit a typed shard before reservation", async () => {
  const fixture = await setup();
  const previewPath = join(cacheRoot, "bounded-preview.json");
  expect(await runCli([...fixture.args, "--batch-operation", "prepare", "--extraction-preflight-out", previewPath])).toBe(0);
  const line = JSON.parse(readFileSync(previewPath, "utf8")).planned_requests[0];
  expect(() => assertSourcePacketShardCapacity("s".repeat(20 * 1024 * 1024), line)).toThrow(/before reservation/u);
  expect(() => assertSourcePacketShardCapacity("source", { ...line, unitKeys: ["x".repeat(20 * 1024 * 1024)] })).toThrow(/before reservation/u);
  expect(fixture.fetchMock).not.toHaveBeenCalled();
});

it("allows a valid shared plan larger than a shard while retaining only a plan reference per result", async () => {
  const fixture = await setup();
  expect(await fixture.run("prepare")).toBe(0);
  const small = fixture.plan();
  const lines = Array.from({ length: 34 }, (_, i) => ({ ...small.lines[0]!, key: `large_${i}`,
    unitKeys: [`unit_${i}`], systemPrompt: "p".repeat(1024 * 1024) }));
  const plan = canonicalBatchPlan({ ...small, lines, limits: { ...small.limits,
    maxFileBytes: 64 * 1024 * 1024, maxInputTokensPerJob: 64 * 1024 * 1024,
    maxEnqueuedTokens: 64 * 1024 * 1024, maxUsd: 1000 } });
  expect(prepareBatchJobs(plan)).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(plan))).toBeGreaterThan(32 * 1024 * 1024);
  // Each independent line remains within the per-shard contract. The real import
  // test verifies the stored shape references its durable shared plan by identity.
  for (const line of plan.lines) expect(() => assertSourcePacketShardCapacity("source", line)).not.toThrow();
  expect(fixture.fetchMock).not.toHaveBeenCalled();
}, 60000);

it("reopens a native Batch cache configured with the equivalent Gemini OpenAI-compatible route", async () => {
  const fixture = await setup(false, false, "https://fixture-provider.invalid/v1beta/openai/");
  expect(await fixture.run("prepare")).toBe(0);
  expect(await fixture.run("submit")).toBe(0);
  expect(await fixture.run("resume")).toBe(0);
  expect(await fixture.run("import")).toBe(0);
  const authorityPath = join(cacheRoot, `batch-authority-${fixture.plan().identity}.json`);
  const retainedAuthority = readFileSync(authorityPath, "utf8");
  rmSync(authorityPath);
  expect(inspectCachedSourcePacket(cacheRoot, fixture.keys[0]!, MODEL, REQUEST_PROFILE).status).toBe("invalid");
  writeFileSync(authorityPath, retainedAuthority);
  for (const key of fixture.keys) {
    expect(inspectCachedSourcePacket(cacheRoot, key, MODEL, REQUEST_PROFILE)).toMatchObject({ status: "hit" });
    const path = cacheFilePath(cacheRoot, key), stored = JSON.parse(readFileSync(path, "utf8"));
    stored.transport_provenance = buildExtractionTransportProvenance({ model: MODEL,
      providerUrl: "https://fixture-provider.invalid/v1beta" });
    writeFileSync(path, JSON.stringify(stored));
    expect(inspectCachedSourcePacket(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("invalid");
  }
}, 60000);
