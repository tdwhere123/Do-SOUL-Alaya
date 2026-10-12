import { startBenchPhaseDiagnostics } from "../../bench-phase-diagnostics.test-support.js";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync,
  statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { SoulInterpretationResponseSchema, UNKNOWN_UTTERANCE_ATTRIBUTION } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest, type SourceSemanticCorrespondenceProposalInput } from "@do-soul/alaya-soul";
import { prepareNativeSourceRecordsSnapshot, readVerifiedNativeSourceSnapshot } from
  "../../../runs/snapshot/source-records/native.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from
  "../../../runs/semantic-proposal/workset.js";
import { semanticProposalShardPath } from "../../../runs/semantic-proposal/artifact.js";
import { readCurrentExtractionAuthorityRevision } from
  "../../../runs/extraction/authority/inspection.js";
import { parseSourceSemanticInteractivePreflight, preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { readCompletePhysicalSourceResponseForRequest } from
  "../../../runs/extraction/cache/source-interactive-binding.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { setExtractionCredentialFixture } from "../extraction-fill/fixture.js";
import { runSemanticChainLauncher } from "../../../runs/semantic-chain/launch.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { deliverLivePreparedSemanticChain } from "../../../runs/semantic-chain/replay.js";
import { chainIdentity, readChainArtifact, withSemanticChainDaemon } from "../../../runs/semantic-chain/contract.js";
import { freezeRecoveryAllowance, reserveRecoveryAction, reserveRecoveryHostEffect,
  reserveRecoveryRead, recordRecoveryNativeWork } from "../../../runs/semantic-chain/recovery-allowance.js";
import { admitInitialQualified } from "../../../runs/semantic-chain/recovery-publication.js";
import { admitFinalRecoveryQualified } from "../../../runs/semantic-chain/recovery-final-publication.js";
import { admitRecoveryWindow } from "../../../runs/semantic-chain/recovery-window.js";
import { censusNativeSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { nativeSourceRequestInventory } from "../../../runs/extraction/fill/source-request-workset.js";
import { providerRawAttemptPath } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { CLOCK, OBSERVED, INGESTED, URL, MODEL, H_PROFILE, Q_PROFILE, BUDGET, ALLOWANCE,
  queryRaw, sourceRaw, correspondenceRaw, fillProposal, fillSource, prepareRetainedRecoverySnapshot, readRetainedSourceMetadata } from
  "./native-recovery-provider.test-support.js";

const DATE_QUESTION = "Which tool did Mira use for indexing on August 14, 2026?";
const FORMAT_QUESTION = "Which file format did Mira use for the Atlas export?";
const DATE_CONTEXT = { context_id: "original-tool-date", notes:
  "Use the retained activity records. A date refers to the UTC calendar day of the tool-use event. Report the tool supported for that day; say if the records do not settle the requested detail." };
const FORMAT_CONTEXT = { context_id: "original-export-format", notes:
  "Use the retained export notes. Atlas and Beacon name different exports. If the Atlas format is not supported by the available notes, keep it unknown." };
const WORLDS = [
  { name: "date positive", date: true, titles: ["Activity note 1", "Activity note 2"],
    bodies: ["Mira used Cedar for indexing on 2026-08-14.\n", "Mira used Birch for indexing on 2026-09-14.\n"],
    answer: "Cedar", support: "Mira used Cedar for indexing on 2026-08-14." },
  { name: "date foil", date: true, titles: ["Activity note 1", "Activity note 2"],
    bodies: ["Mira used Cedar for indexing on 2026-09-14.\n", "Mira used Birch for indexing on 2026-08-14.\n"],
    answer: "Birch", support: "Mira used Birch for indexing on 2026-08-14." },
  { name: "format positive", date: false, titles: ["Export note 1", "Export note 2"],
    bodies: ["Mira completed the Atlas export.\nMira used Parquet for the Atlas export.\n",
      "Mira used CSV for the Beacon export.\n"], answer: "Parquet",
    support: "Mira used Parquet for the Atlas export." },
  { name: "format foil", date: false, titles: ["Export note 1", "Export note 2"],
    bodies: ["Mira completed the Atlas export.\nMira archived the Atlas export.\n",
      "Mira used CSV for the Beacon export.\n"], answer: null, support: null }
] as const;
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await settleActiveBenchDaemonTasks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// This correctness E2E spans multiple cold SQLite/daemon sessions on Windows.
for (const world of [...WORLDS, { ...WORLDS[2], name: "format C-only revision", cOnly: true },
  { ...WORLDS[2], name: "retained assistant known event time", retainedClock: OBSERVED },
  { ...WORLDS[2], name: "retained assistant unknown event time", retainedClock: null },
  { ...WORLDS[2], name: "retained assistant minute-precision event time", retainedClock: "2026-09-22T00:00Z" },
  { ...WORLDS[2], name: "retained assistant minute-precision recorded time with unknown event time", retainedClock: null,
    retainedRecordedAt: ["2026-09-22T00:00Z", "2026-09-22T00:01Z"] }
] as const)
  it(`delivers the frozen ${world.name} distinction through the connected native recovery`, async (testContext) => {
  const phases = startBenchPhaseDiagnostics(testContext.task.file.filepath, testContext.task.id,
    testContext.task.timeout, testContext.signal, undefined, process.platform === "win32" ? 45_000 : undefined);
  const benchPhase = phases.phase;
  testContext.onTestFinished(() => phases.finish(testContext.task.result?.state === "fail"));
  const cOnly = "cOnly" in world && world.cOnly;
  const evidenceRoot = mkdtempSync(join(tmpdir(), "native-original-recovery-")); roots.push(evidenceRoot);
  const externalStaticCaller = world.name === "format positive" ? process.env.STATIC_CALLER_PATH : undefined;
  const worldId = externalStaticCaller === undefined ? "originals" : "2e86d7ae-6153-43ea-8c52-bb8f38f4e415";
  const producerCommit = externalStaticCaller === undefined ? "0".repeat(40)
    : "36a838082fe1f6861370395823aa4b8e23f5510a";
  const root = join(evidenceRoot, "runs", worldId);
  mkdirSync(root, { recursive: true });
  const snapshotPath = join(root, "original.sqlite"), recoveryRoot = join(root, "recovery"),
    staticRoot = join(root, "static-initial-arm");
  const question = world.date ? DATE_QUESTION : FORMAT_QUESTION;
  const context = world.date ? DATE_CONTEXT : FORMAT_CONTEXT;
  const sourceIds = ["source-7df0", "source-b326"] as const;
  const sourceClock = "retainedClock" in world ? world.retainedClock : OBSERVED;
  const sourceRecordedAt = "retainedRecordedAt" in world ? world.retainedRecordedAt : INGESTED;
  const expectedSourceMetadata = sourceIds.map((source_id, index) => ({ source_id,
    event_time: sourceClock, speaker: "assistant", recorded_at: sourceRecordedAt[index] }));
  if ("retainedClock" in world) await benchPhase("snapshot.retained", () => prepareRetainedRecoverySnapshot(root, snapshotPath, worldId,
    world.bodies.map((body, index) => ({ source_id: sourceIds[index]!, content_bytes: body,
      event_time: sourceClock, recorded_at: sourceRecordedAt[index]!, speaker: "assistant",
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION }))));
  else await benchPhase("snapshot.native", () => prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "native-daemon"),
    workspaceId: worldId, runId: worldId,
    producerCommit,
    sources: world.bodies.map((body, index) => ({ source_id: sourceIds[index]!, source_version: "1",
      title: world.titles[index]!, content_bytes: body, source_observed_at: OBSERVED,
      recorded_at: INGESTED[index]! })) }));
  const native = readVerifiedNativeSourceSnapshot(snapshotPath);
  expect(native.records.map(row => [row.content_bytes, row.source_observed_at, row.recorded_at]))
    .toEqual(world.bodies.map((body, index) => [body, sourceClock, sourceRecordedAt[index]]));
  if ("retainedClock" in world) expect(native.records.every(row => row.source_role === "assistant")).toBe(true);
  else expect(native.records.map(row => row.title)).toEqual(world.titles);
  const qCache = join(root, "q-cache");
  const qWorksetPath = join(root, "initial-q.json");
  writeFileSync(qWorksetPath, JSON.stringify(parseSemanticProposalWorkset({
    contract: "source-semantic-proposal-workset-v3", kind: "query", model: MODEL,
    request_profile: Q_PROFILE, provider_url: URL,
    items: [{ original_query: question, approved_fixed_context: context }] })));
  const freezePath = join(root, "freeze.json");
  writeFileSync(freezePath, JSON.stringify({ native_snapshot_path: snapshotPath, population: "originals",
    source_model: MODEL, source_request_profile: H_PROFILE, source_cache_root: join(root, "h-cache"),
    recorded_at: CLOCK, producer_commit: producerCommit, allowance: ALLOWANCE, chain: {
      implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: CLOCK,
      workspace_id: worldId, run_id: worldId,
      query_workset: JSON.parse(readFileSync(qWorksetPath, "utf8")), query_cache_root: qCache,
      correspondence_cache_root: join(root, "c-cache"), max_output_tokens: 16_384,
      correspondence_generation: { model: MODEL, request_profile: H_PROFILE, provider_url: URL,
        max_output_tokens: 16_384 }, discovery_page_cap: 1,
      source_preview_extents: native.records.map((row, index) => ({ source_id: row.source_id,
        source_version: row.source_version, record_id: row.record.identity,
        byte_extent: !world.date && index === 0 ? Buffer.byteLength("Mira completed the Atlas export.\n")
          : Buffer.byteLength(row.content_bytes) })),
      correspondence_pair_cap: 2, access_policy: "query-conditioned-v1", budget: BUDGET,
      authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 1_000_000 } }));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const staticIdentity = chainIdentity({ arm: "static_initial", freeze: JSON.parse(readFileSync(freezePath, "utf8")) });
  freezeRecoveryAllowance(staticRoot, staticIdentity, ALLOWANCE, snapshotPath);
  reserveRecoveryRead(staticRoot, "shared original Q setup and source input");
  reserveRecoveryHostEffect(staticRoot, "original-Q-preparation", staticIdentity, false);
  reserveRecoveryHostEffect(staticRoot, "shared-raw-publication", staticIdentity, false);
  reserveRecoveryAction(staticRoot, "shared-raw-observation", staticIdentity,
    BUDGET.work_units, BUDGET.memory_bytes, false);
  expect(await benchPhase("recover-declare-initial-q", () => runSemanticChainLauncher(["recover-declare-initial-q", "--config", freezePath,
    "--root", recoveryRoot]))).toBe(0);
  await benchPhase("fill.proposal", () => fillProposal(qWorksetPath, qCache, () => queryRaw(world.date, false), Q_PROFILE));
  expect(await benchPhase("recover-freeze", () => runSemanticChainLauncher(["recover-freeze", "--config", freezePath, "--root", recoveryRoot]))).toBe(0);
  const frozen = readChainArtifact(join(recoveryRoot, "recovery-window.json")) as {
    window: { source_id: string; read_bytes: number; complete: boolean }[]; selected_missing_keys: string[];
    initial_discovery_work: unknown };
  recordRecoveryNativeWork(staticRoot, "shared-raw-observation", frozen.initial_discovery_work);
  expect(frozen.window).toHaveLength(2);
  if ("retainedClock" in world) {
    const windowBytes = readFileSync(join(recoveryRoot, "recovery-window.json"));
    expect(await benchPhase("recover-freeze", () => runSemanticChainLauncher(["recover-freeze", "--config", freezePath, "--root", recoveryRoot]))).toBe(0);
    expect(readFileSync(join(recoveryRoot, "recovery-window.json"))).toEqual(windowBytes);
    const reopened = admitRecoveryWindow(recoveryRoot);
    expect(reopened.window.map(row => [row.source_id, row.source_observed_at, row.recorded_at]).sort())
      .toEqual(expectedSourceMetadata.map(row => [row.source_id, row.event_time, row.recorded_at]).sort());
    expect(readRetainedSourceMetadata(reopened.raw_snapshot_path)).toEqual(expectedSourceMetadata);
  }
  if (!world.date) expect(frozen.window.find(row => row.source_id === sourceIds[0])).toMatchObject({
    read_bytes: Buffer.byteLength("Mira completed the Atlas export.\n"), complete: false });
  if (world.name === "date positive") {
    const originalConfig = readFileSync(freezePath, "utf8");
    const changed = JSON.parse(originalConfig);
    changed.chain.source_preview_extents[0].byte_extent -= 1;
    writeFileSync(freezePath, JSON.stringify(changed));
    try { expect(await benchPhase("recover-freeze", () => runSemanticChainLauncher(["recover-freeze", "--config", freezePath,
      "--root", recoveryRoot]))).toBe(2); }
    finally { writeFileSync(freezePath, originalConfig); }
  }
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", H_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", URL);
  setExtractionCredentialFixture();
  reserveRecoveryRead(staticRoot, "shared selected H source and preflight");
  reserveRecoveryHostEffect(staticRoot, "shared-initial-H", staticIdentity, false);
  const hCache = join(root, "h-cache");
  const hPreflight = await benchPhase("fill.source", () => fillSource(root, snapshotPath, hCache, EXTRACTION_OPEN_SEMANTICS_GENERATION,
    frozen.selected_missing_keys, "initial-h", prompt => sourceRaw(prompt, cOnly)));
  expect(await benchPhase("recover-publish-initial", () => runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
    "--source-preflight", hPreflight, "--source-cache-root", hCache]))).toBe(0);
  expect(await benchPhase("recover-prepare-initial-c", () => runSemanticChainLauncher(["recover-prepare-initial-c", "--root", recoveryRoot]))).toBe(0);
  reserveRecoveryRead(staticRoot, "shared initial C workset and physical owner");
  reserveRecoveryHostEffect(staticRoot, "shared-initial-C", staticIdentity, false);
  const cInitial = join(recoveryRoot, "initial-correspondence-workset.json");
  const initialCResult = await benchPhase("fill.proposal", () => fillProposal(cInitial, join(root, "c-cache"), cOnly
    ? () => JSON.stringify({ contract: "source-semantic-correspondence-response-v4", outcome: { status: "abstained" } })
    : correspondenceRaw, H_PROFILE));
  if (cOnly) expect(initialCResult).toMatchObject({ requested: 2, abstained: 2 });
  if (world.name === "date positive") {
    const originalAllowance = join(recoveryRoot, "recovery-allowance.sqlite");
    const retainedAllowance = `${originalAllowance}.temporarily-absent`;
    renameSync(originalAllowance, retainedAllowance);
    try {
      expect(() => admitInitialQualified(recoveryRoot, staticRoot)).toThrow("unavailable");
      expect(existsSync(originalAllowance)).toBe(false);
    } finally { renameSync(retainedAllowance, originalAllowance); }
    expect(admitInitialQualified(recoveryRoot, staticRoot).settled.published_selected_count).toBe(2);
  }
  if (externalStaticCaller !== undefined) {
    const staticCaller = await import(pathToFileURL(externalStaticCaller).href) as {
      runStaticInitialNative: (evidenceRoot: string, worldId: string) => Promise<{
        published_h_ids: string[]; observed_h_ids: string[]; unobserved_h_ids: string[];
        consumed_c_keys: string[]; first_exposure_digest: string | null;
        replay_identity: string }>
    };
    const connectedAllowance = join(recoveryRoot, "recovery-allowance.sqlite");
    const cycle = () => {
      const db = new DatabaseSync(connectedAllowance, { readOnly: true });
      try { return db.prepare("SELECT work_reserved, memory_reserved, read_count FROM cycle").get(); }
      finally { db.close(); }
    };
    const before = cycle();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    const first = await staticCaller.runStaticInitialNative(evidenceRoot, worldId);
    expect(cycle()).toEqual(before);
    expect(first.published_h_ids).toHaveLength(2);
    expect(first.observed_h_ids).toHaveLength(1);
    expect(first.unobserved_h_ids).toHaveLength(1);
    expect(first.consumed_c_keys).toHaveLength(1);
    const originalC = readChainArtifact(join(root, "static-initial-native", "static-inputs.json")) as {
      initial_c_keys: string[] };
    expect(originalC.initial_c_keys).toHaveLength(2);
    expect(originalC.initial_c_keys).toContain(first.consumed_c_keys[0]);
    expect(first.first_exposure_digest).not.toBeNull();
    const s1Root = join(root, "static-initial-native", "s1");
    const retainedPlan = readFileSync(join(s1Root, "prepare.json"));
    const retainedS1 = readChainArtifact(join(s1Root, "prepare.json")) as { config: unknown };
    await expect(prepareSemanticChain(retainedS1.config, s1Root, undefined, undefined, undefined,
      "observed_subset")).rejects.toThrow("explicit settled input");
    const second = await staticCaller.runStaticInitialNative(evidenceRoot, worldId);
    expect(cycle()).toEqual(before);
    expect(second.replay_identity).toBe(first.replay_identity);
    expect(readFileSync(join(s1Root, "prepare.json"))).toEqual(retainedPlan);
    vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", H_PROFILE);
    vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", URL);
    setExtractionCredentialFixture();
  }
  const initialQualified = readChainArtifact(join(recoveryRoot, "initial-qualified.json")) as {
    snapshot_path: string; snapshot_sha256: string };
  const staticConfig = { ...JSON.parse(readFileSync(freezePath, "utf8")).chain,
    snapshot_path: initialQualified.snapshot_path, snapshot_sha256: initialQualified.snapshot_sha256 };
  reserveRecoveryRead(staticRoot, "static S1 sealed source and current C");
  reserveRecoveryAction(staticRoot, "static-S1-prepare", chainIdentity(staticConfig),
    BUDGET.work_units, BUDGET.memory_bytes, false);
  reserveRecoveryAction(staticRoot, "static-S1-recall", chainIdentity(staticConfig),
    BUDGET.work_units, BUDGET.memory_bytes, false);
  const staticReplay = await benchPhase("static.replay", () => withSemanticChainDaemon(staticConfig, staticRoot, async daemon => {
    let handles: ReadonlyMap<string, string | undefined> = new Map();
    const plan = await prepareSemanticChain(staticConfig, staticRoot, daemon, current => { handles = current; });
    const preparedQuery = plan.queries[0];
    if (preparedQuery?.status === "blocked" || preparedQuery?.discovery_trace[0] === undefined) {
      throw new Error("static S1 lacks a completed native discovery");
    }
    recordRecoveryNativeWork(staticRoot, "static-S1-prepare", preparedQuery.discovery_trace[0].work);
    return deliverLivePreparedSemanticChain(staticRoot, daemon, handles);
  }));
  const staticResponse = staticReplay.result.rows[0]?.response;
  if (staticResponse === undefined) throw new Error("static S1 has no native recall response");
  recordRecoveryNativeWork(staticRoot, "static-S1-recall", staticResponse.work);
  const staticRows = staticReplay.result.rows as { response?: { operation: string;
    proofs?: { binding_results?: { kind: string }[] }[];
    slot_qualifiers?: { evidence_kind: string; selection_basis?: string }[] } }[];
  expect(staticRows).toHaveLength(1);
  expect(staticRows[0]?.response?.operation).toBe("recall");
  process.stderr.write(`STATIC_INITIAL_ARM ${world.name}: ${JSON.stringify({
    answer_bindings: (staticRows[0]?.response?.proofs ?? []).flatMap(row => row.binding_results ?? [])
      .filter(row => row.kind === "answer").length,
    direct_answer_qualifiers: (staticRows[0]?.response?.slot_qualifiers ?? [])
      .filter(row => row.evidence_kind === "semantic_proof" && row.selection_basis === "direct_answer").length
  })}\n`);
  expect(await benchPhase("recover-reason-initial", () => runSemanticChainLauncher(["recover-reason-initial", "--root", recoveryRoot]))).toBe(0);
  expect(await benchPhase("recover-prepare-q-review", () => runSemanticChainLauncher(["recover-prepare-q-review", "--root", recoveryRoot]))).toBe(0);
  await benchPhase("fill.proposal", () => fillProposal(join(recoveryRoot, "query-review-workset.json"), join(recoveryRoot, "query-review-cache"),
    () => queryRaw(world.date, true), Q_PROFILE));
  expect(await benchPhase("recover-settle-q-review", () => runSemanticChainLauncher(["recover-settle-q-review", "--root", recoveryRoot]))).toBe(0);
  const review = readChainArtifact(join(recoveryRoot, "query-review.json")) as { changed: boolean };
  expect(review.changed).toBe(world.date);
  expect(await benchPhase("recover-prepare-source", () => runSemanticChainLauncher(["recover-prepare-source", "--root", recoveryRoot]))).toBe(0);
  const read = readChainArtifact(join(recoveryRoot, "recovery-source-read.json")) as {
    source_id: string; response: { catalog: { assertions: { segments: { text: string }[] }[] } } };
  if (!world.date) expect(read.response.catalog.assertions.map(row => row.segments.map(part => part.text).join("")))
    .toContain(world.bodies[0]!.split("\n")[1]);
  expect(await benchPhase("recover-prepare-h-revision", () => runSemanticChainLauncher(["recover-prepare-h-revision", "--root", recoveryRoot]))).toBe(0);
  const revision = readChainArtifact(join(recoveryRoot, "source-revision.json")) as {
    child_key: string; generation_path: string };
  const childCache = join(root, "child-h-cache");
  const childGeneration = JSON.parse(readFileSync(revision.generation_path, "utf8"));
  const childPreflight = await benchPhase("fill.source", () => fillSource(root, snapshotPath, childCache, childGeneration,
    [revision.child_key], "child-h", cOnly
      ? () => JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "abstained" } })
      : sourceRaw));
  if ("retainedClock" in world) {
    const physical = parseSourceSemanticInteractivePreflight(JSON.parse(readFileSync(childPreflight, "utf8")));
    expect(physical.ready_requests).toHaveLength(1);
    const childLine = physical.ready_requests[0]!;
    const childRequest = parseSourceSemanticRequest(JSON.parse(childLine.userPrompt));
    expect(childRequest.source_request.source_role).toBe("assistant");
    expect(childRequest.source_request.source_assertions.length).toBeGreaterThan(0);
    expect(childRequest.source_request.source_assertions.every(row => row.source_role === "assistant")).toBe(true);
    const raw = readCompletePhysicalSourceResponseForRequest({ cacheRoot: childCache,
      currentPreflight: physical, physicalPreflight: physical, currentLine: childLine });
    expect(JSON.parse(raw)).toMatchObject({ outcome: { status: "interpreted" },
      content: { roots: [expect.any(Object)], nodes: [expect.any(Object)] } });
  }
  if (world.name === "date positive") {
    const shard = cacheFilePath(childCache, revision.child_key);
    const missing = `${shard}.temporarily-absent`;
    renameSync(shard, missing);
    try {
      expect(await benchPhase("recover-publish-final", () => runSemanticChainLauncher(["recover-publish-final", "--root", recoveryRoot,
        "--source-preflight", childPreflight, "--source-cache-root", childCache]))).toBe(2);
    } finally { renameSync(missing, shard); }
  }
  expect(await benchPhase("recover-publish-final", () => runSemanticChainLauncher(["recover-publish-final", "--root", recoveryRoot,
    "--source-preflight", childPreflight, "--source-cache-root", childCache]))).toBe(0);
  if ("retainedClock" in world) {
    const final = admitFinalRecoveryQualified(recoveryRoot);
    expect(final.final.source_outcome).toBe("child_published");
    expect(readRetainedSourceMetadata(final.final.snapshot_path)).toEqual(expectedSourceMetadata);
    const retainedFinal = readFileSync(join(recoveryRoot, "final-qualified.json"));
    expect(await benchPhase("recover-publish-final", () => runSemanticChainLauncher(["recover-publish-final", "--root", recoveryRoot,
      "--source-preflight", childPreflight, "--source-cache-root", childCache]))).toBe(0);
    expect(readFileSync(join(recoveryRoot, "final-qualified.json"))).toEqual(retainedFinal);
  }
  expect(await benchPhase("recover-prepare-final-c", () => runSemanticChainLauncher(["recover-prepare-final-c", "--root", recoveryRoot]))).toBe(0);
  const newC = join(recoveryRoot, "final-correspondence-new-workset.json");
  if (cOnly) {
    expect(existsSync(newC)).toBe(true);
    expect(parseSemanticProposalWorkset(JSON.parse(readFileSync(newC, "utf8"))).items[0])
      .toHaveProperty("revision.previous_response_completion", "complete");
    expect(readChainArtifact(join(recoveryRoot, "final-qualified.json")))
      .toHaveProperty("source_outcome", "initial_reused_terminal_child");
  }
  if (existsSync(newC)) {
    await benchPhase("fill.proposal", () => fillProposal(newC,
      join(recoveryRoot, "final-correspondence-cache"), correspondenceRaw, H_PROFILE));
  }
  expect(await benchPhase("recover-final-deliver", () => runSemanticChainLauncher(["recover-final-deliver", "--root", recoveryRoot]))).toBe(0);
  const exposure = readChainArtifact(join(recoveryRoot, "first-exposure.json")) as { replay_path: string };
  const replay = readChainArtifact(exposure.replay_path) as { rows: { response?: {
    operation: string; proofs?: { source_interpretation_id: string; binding_results?: {
      kind: string; returned: { answer?: { node_id: string } } }[] }[];
    results?: { content_preview?: string }[]; slot_qualifiers?: { evidence_kind: string;
      selection_basis?: string; payload_support?: string }[];
    unproved_computations?: { source_record: { source_id: string; source_version: string; content_digest: string };
      source_interpretation_id: string; query_semantics_id: string; semantic_correspondence_id: string;
      conditional_computation_id: string; completeness: { logical_index: string; observed_coverage: string };
      attention?: { kind: string; source_interpretation_id?: string; entries?: { state: string }[] } }[];
    coverage?: { conditional_computation: string } } }[] };
  const recall = replay.rows[0]?.response;
  if (recall?.operation !== "recall") throw new Error("final native replay row lacks its recall response");
  const final = readChainArtifact(join(recoveryRoot, "final-qualified.json")) as {
    descriptor_export: { descriptor: { source_interpretation_id: string; interpretation: {
      referents: { id: string; mentions: string[] }[]; mentions: { id: string; text: string }[] } } }[] };
  const answers = (recall?.proofs ?? []).flatMap(proof => (proof.binding_results ?? [])
    .filter(row => row.kind === "answer").map(row => ({ proof, node: row.returned.answer?.node_id })));
  if (world.answer === null) {
    expect(answers).toHaveLength(0);
    expect(recall?.unproved_computations).toHaveLength(2);
    expect(recall?.coverage?.conditional_computation).toBe("complete");
    expect(recall?.unproved_computations?.every(row => row.completeness.logical_index === "complete"
      && row.attention?.kind === "computed"
      && row.attention.source_interpretation_id === row.source_interpretation_id)).toBe(true);
    expect(recall?.unproved_computations?.some(row => row.attention?.entries?.some(entry => entry.state === "unobserved"))).toBe(true);
    expect(recall?.unproved_computations?.every(row => final.descriptor_export.some(exported =>
      exported.descriptor.source_interpretation_id === row.source_interpretation_id))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(recall))).toBeLessThanOrEqual(1_000_000);
    const firstControl = recall?.unproved_computations?.[0];
    if (firstControl === undefined) throw new Error("completed final computation control is absent");
    expect(SoulInterpretationResponseSchema.safeParse({ ...recall, unproved_computations: [{ ...firstControl,
      query_semantics_id: `sha256:${"f".repeat(64)}` }, ...recall.unproved_computations!.slice(1)] }).success).toBe(false);
    expect(SoulInterpretationResponseSchema.safeParse({ ...recall, unproved_computations: [{ ...firstControl,
      source_record: { ...firstControl.source_record, source_version: "foreign-version" } },
    ...recall.unproved_computations!.slice(1)] }).success).toBe(false);
    expect(SoulInterpretationResponseSchema.safeParse({ ...recall, unproved_computations: [{ ...firstControl,
      source_record: { ...firstControl.source_record, workspace_id: "foreign-workspace" } },
    ...recall.unproved_computations!.slice(1)] }).success).toBe(false);
    expect(SoulInterpretationResponseSchema.safeParse({ ...recall, query_semantics_status: {
      status: "unavailable", reason: "producer_failure" } }).success).toBe(false);
    const firstExposureIdentity = chainIdentity(exposure);
    expect(await runSemanticChainLauncher(["recover-final-deliver", "--root", recoveryRoot])).toBe(0);
    expect(chainIdentity(readChainArtifact(join(recoveryRoot, "first-exposure.json")))).toBe(firstExposureIdentity);
    const reopened = readChainArtifact(exposure.replay_path) as typeof replay;
    expect(reopened.rows[0]?.response?.unproved_computations).toEqual(recall?.unproved_computations);
  } else {
    expect(answers).toHaveLength(1);
    expect(answers.some(({ proof, node }) => {
      const H = final.descriptor_export.find(row => row.descriptor.source_interpretation_id === proof.source_interpretation_id)?.descriptor.interpretation;
      return H?.referents.some(ref => ref.id === node && ref.mentions.some(id =>
        H.mentions.find(mention => mention.id === id)?.text === world.answer));
    })).toBe(true);
    expect(recall?.results?.slice(0, 5).some(row => row.content_preview?.includes(world.support!))).toBe(true);
    expect(recall?.slot_qualifiers?.some(row => row.evidence_kind === "semantic_proof" &&
      row.selection_basis === "direct_answer" && row.payload_support === "available")).toBe(true);
  }
  if (world.name === "date positive") {
    const firstExposureIdentity = chainIdentity(exposure);
    expect(await runSemanticChainLauncher(["recover-final-deliver", "--root", recoveryRoot])).toBe(0);
    expect(chainIdentity(readChainArtifact(join(recoveryRoot, "first-exposure.json")))).toBe(firstExposureIdentity);
    const binding = readChainArtifact(join(recoveryRoot, "final-correspondence-binding.json")) as {
      cache_owners: { key: string; cache_root: string }[] };
    const owner = binding.cache_owners[0]!;
    const shard = semanticProposalShardPath(owner.cache_root, owner.key);
    const missing = `${shard}.temporarily-absent`;
    renameSync(shard, missing);
    try { expect(await runSemanticChainLauncher(["recover-final-deliver", "--root", recoveryRoot])).toBe(2); }
    finally { renameSync(missing, shard); }
    const originalSize = statSync(snapshotPath).size;
    appendFileSync(snapshotPath, "mutated sealed source");
    try { expect(await runSemanticChainLauncher(["recover-final-deliver", "--root", recoveryRoot])).toBe(2); }
    finally { truncateSync(snapshotPath, originalSize); }
    expect(await runSemanticChainLauncher(["recover-final-deliver", "--root", recoveryRoot])).toBe(0);
    expect(chainIdentity(readChainArtifact(join(recoveryRoot, "first-exposure.json")))).toBe(firstExposureIdentity);
  }
}, process.platform === "win32" ? 120_000 : 60_000);

it("reuses exact Q and H physical owners across isolated native source worlds", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-shared-physical-owner-")); roots.push(root);
  const sharedQ = join(root, "original-q-cache"), sharedQChild = join(root, "review-q-cache"),
    sharedH = join(root, "original-h-cache"), sharedHChild = join(root, "revised-h-cache");
  const worlds = [WORLDS[2], WORLDS[3]] as const;
  const sources = ["source-a", "source-b"] as const;
  let originalQFilled = false, childQFilled = false, physicalChild: { key: string; preflight: string } | undefined;
  let physicalB: { key: string; preflight: string } | undefined;
  const exposures: string[] = [], physicalSnapshots: string[] = [], publishedB: string[] = [], qChildKeys: string[] = [];
  const attempts = { originalQ: 0, reviewQ: 0, newA: 0, sharedB: 0, revisedB: 0 };
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", H_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", URL);
  setExtractionCredentialFixture();
  for (const [index, world] of worlds.entries()) {
    const worldRoot = join(root, `world-${index}`), snapshotPath = join(worldRoot, "original.sqlite"),
      recoveryRoot = join(worldRoot, "recovery"), hCache = join(worldRoot, "new-h-cache");
    await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(worldRoot, "native-daemon"),
      workspaceId: `world-${index}`, runId: `world-${index}`, producerCommit: "0".repeat(40),
      sources: world.bodies.map((body, sourceIndex) => ({ source_id: `${sources[sourceIndex]}-${index}`,
        source_version: "1", title: world.titles[sourceIndex]!, content_bytes: body,
        source_observed_at: OBSERVED, recorded_at: INGESTED[sourceIndex]! })) });
    const native = readVerifiedNativeSourceSnapshot(snapshotPath);
    expect(native.records.map(row => row.content_bytes)).toEqual(world.bodies);
    physicalSnapshots.push(snapshotPath);
    const census = censusNativeSourceRecords({ population: "originals", snapshotPath });
    const inventory = nativeSourceRequestInventory(census.records, census.dataset_sha256, {
      model: MODEL, requestProfile: H_PROFILE, sourcePacking: "complete-source",
      openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION });
    const bKey = inventory.requests.find(row => row.sourceCorpus === world.bodies[1])?.line.key;
    expect(bKey).toMatch(/^[a-f0-9]{64}$/u);
    const qWorkset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3",
      kind: "query", model: MODEL, request_profile: Q_PROFILE, provider_url: URL,
      items: [{ original_query: FORMAT_QUESTION, approved_fixed_context: FORMAT_CONTEXT }] });
    const qPath = join(worldRoot, "initial-q.json");
    writeFileSync(qPath, JSON.stringify(qWorkset));
    const freeze = { native_snapshot_path: snapshotPath, population: "originals",
      source_model: MODEL, source_request_profile: H_PROFILE, source_cache_root: hCache,
      query_review_cache_root: sharedQChild,
      ...(physicalB === undefined ? {} : { initial_h_physical_owners: [{ key: physicalB.key,
        cache_root: sharedH, physical_preflight_path: physicalB.preflight }] }),
      recorded_at: CLOCK, producer_commit: "0".repeat(40), allowance: ALLOWANCE,
      chain: { implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: CLOCK,
        workspace_id: `world-${index}`, run_id: `world-${index}`, query_workset: qWorkset,
        query_cache_root: sharedQ, correspondence_cache_root: join(worldRoot, "c-cache"),
        max_output_tokens: 16_384,
        correspondence_generation: { model: MODEL, request_profile: H_PROFILE, provider_url: URL,
          max_output_tokens: 16_384 }, discovery_page_cap: 1,
        source_preview_extents: native.records.map((row, sourceIndex) => ({ source_id: row.source_id,
          source_version: row.source_version, record_id: row.record.identity,
          byte_extent: sourceIndex === 0 ? Buffer.byteLength("Mira completed the Atlas export.\n")
            : Buffer.byteLength(row.content_bytes) })),
        correspondence_pair_cap: 2, access_policy: "query-conditioned-v1", budget: BUDGET,
        authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 1_000_000 } };
    const freezePath = join(worldRoot, "freeze.json"); writeFileSync(freezePath, JSON.stringify(freeze));
    expect(await runSemanticChainLauncher(["recover-declare-initial-q", "--config", freezePath,
      "--root", recoveryRoot])).toBe(0);
    if (!originalQFilled) {
      await fillProposal(qPath, sharedQ, () => queryRaw(false, false), Q_PROFILE,
        () => { attempts.originalQ++; });
      originalQFilled = true;
    }
    if (index === 1) {
      const raw = providerRawAttemptPath(sharedH, physicalB!.key, 1), absent = `${raw}.temporarily-absent`;
      renameSync(raw, absent);
      try { expect(await runSemanticChainLauncher(["recover-freeze", "--config", freezePath,
        "--root", recoveryRoot])).toBe(2); }
      finally { renameSync(absent, raw); }
    }
    expect(await runSemanticChainLauncher(["recover-freeze", "--config", freezePath,
      "--root", recoveryRoot])).toBe(0);
    const window = readChainArtifact(join(recoveryRoot, "recovery-window.json")) as {
      window: { source_id: string; initial_key: string }[]; selected_missing_keys: string[] };
    expect(window.window.find(row => row.source_id === `source-b-${index}`)?.initial_key).toBe(bKey);
    const hPreflight = await fillSource(worldRoot, snapshotPath, hCache, EXTRACTION_OPEN_SEMANTICS_GENERATION,
      window.selected_missing_keys.filter(key => key !== bKey), "initial-h", sourceRaw,
      () => { attempts.newA++; });
    if (physicalB === undefined) {
      expect(window.selected_missing_keys).toContain(bKey);
      physicalB = { key: bKey!, preflight: await fillSource(worldRoot, snapshotPath, sharedH,
        EXTRACTION_OPEN_SEMANTICS_GENERATION, [bKey!], "shared-h", sourceRaw,
        () => { attempts.sharedB++; }) };
    } else expect(window.selected_missing_keys).not.toContain(bKey);
    const currentShared = index === 0 ? JSON.parse(readFileSync(physicalB.preflight, "utf8")) as
      Awaited<ReturnType<typeof preflightSourceSemanticInteractive>> : await preflightSourceSemanticInteractive({
      variant: "native_source_snapshot", nativeSourcePopulation: { name: "originals", snapshotPath },
      cacheRoot: sharedH, sourcePacking: "complete-source",
      openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, preflightKeys: [bKey!],
      preflightOutputTokenCap: 16_384,
      geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
    const sharedCurrentPath = index === 0 ? physicalB.preflight : join(worldRoot, "current-shared-preflight.json");
    expect(currentShared).toMatchObject({ selected_requests: index === 0 ? 1 : 0,
      cached_requests: index === 0 ? 0 : 1,
      ready_requests: [{ key: bKey }] });
    if (index !== 0) writeFileSync(sharedCurrentPath, JSON.stringify(currentShared));
    const ownersPath = join(worldRoot, "source-owners.json");
    if (index === 1) {
      writeFileSync(ownersPath, JSON.stringify([{ key: bKey, cache_root: sharedH,
        current_preflight_path: hPreflight, physical_preflight_path: physicalB!.preflight }]));
      expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
        "--source-preflight", hPreflight, "--source-cache-root", hCache,
        "--source-owners", ownersPath])).toBe(2);
      writeFileSync(ownersPath, JSON.stringify([{ key: bKey, cache_root: hCache,
        current_preflight_path: sharedCurrentPath, physical_preflight_path: physicalB!.preflight }]));
      expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
        "--source-preflight", hPreflight, "--source-cache-root", hCache,
        "--source-owners", ownersPath])).toBe(2);
      writeFileSync(ownersPath, JSON.stringify([{ key: bKey, cache_root: sharedH,
        current_preflight_path: physicalB!.preflight, physical_preflight_path: physicalB!.preflight }]));
      expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
        "--source-preflight", hPreflight, "--source-cache-root", hCache,
        "--source-owners", ownersPath])).toBe(2);
      writeFileSync(ownersPath, JSON.stringify([{ key: bKey, cache_root: sharedH,
        current_preflight_path: sharedCurrentPath, physical_preflight_path: physicalB!.preflight }]));
    }
    if (index === 0) writeFileSync(ownersPath, JSON.stringify([{ key: bKey, cache_root: sharedH,
      current_preflight_path: sharedCurrentPath }]));
    const publishArgs = ["recover-publish-initial", "--root", recoveryRoot,
      "--source-preflight", hPreflight, "--source-cache-root", hCache,
      "--source-owners", ownersPath];
    expect(await runSemanticChainLauncher(publishArgs)).toBe(0);
    const qualified = readChainArtifact(join(recoveryRoot, "initial-qualified.json")) as {
      source_owners: { key: string; cache_root: string; physical_preflight_path?: string }[];
      descriptor_export: { source_id: string; descriptor: { source_interpretation_id: string } }[] };
    expect(qualified.source_owners.find(row => row.key === bKey)).toMatchObject({
      cache_root: sharedH, ...(index === 0 ? {} : { physical_preflight_path: physicalB!.preflight }) });
    expect(qualified.descriptor_export.some(row => row.source_id === `source-b-${index}`)).toBe(true);
    publishedB.push(qualified.descriptor_export.find(row => row.source_id === `source-b-${index}`)!
      .descriptor.source_interpretation_id);
    expect(await runSemanticChainLauncher(["recover-prepare-initial-c", "--root", recoveryRoot])).toBe(0);
    await fillProposal(join(recoveryRoot, "initial-correspondence-workset.json"),
      join(worldRoot, "c-cache"), prompt => {
        const request = JSON.parse(prompt) as SourceSemanticCorrespondenceProposalInput;
        const predicate = request.source_interpretation_descriptors[0]!.interpretation.frames[0]?.predicate_support;
        return predicate?.kind === "explicit" && predicate.reading === "use" ? correspondenceRaw(prompt)
          : JSON.stringify({ contract: "source-semantic-correspondence-response-v4",
            outcome: { status: "abstained" } });
      }, H_PROFILE);
    expect(await runSemanticChainLauncher(["recover-reason-initial", "--root", recoveryRoot])).toBe(0);
    expect(await runSemanticChainLauncher(["recover-prepare-q-review", "--root", recoveryRoot])).toBe(0);
    if (!childQFilled) {
      await fillProposal(join(recoveryRoot, "query-review-workset.json"), sharedQChild,
        () => queryRaw(false, true), Q_PROFILE, () => { attempts.reviewQ++; });
      childQFilled = true;
    }
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Q physical review was reposted"); }));
    expect(await runSemanticChainLauncher(["recover-settle-q-review", "--root", recoveryRoot])).toBe(0);
    qChildKeys.push((readChainArtifact(join(recoveryRoot, "query-review.json")) as { child_key: string }).child_key);
    expect(await runSemanticChainLauncher(["recover-prepare-source", "--root", recoveryRoot])).toBe(0);
    expect(await runSemanticChainLauncher(["recover-prepare-h-revision", "--root", recoveryRoot])).toBe(0);
    const revision = readChainArtifact(join(recoveryRoot, "source-revision.json")) as {
      source_id: string; parent_key: string; parent_cache_root: string; parent_preflight_path: string;
      child_key: string; generation_path: string };
    expect(revision).toMatchObject({ source_id: `source-b-${index}`, parent_key: bKey,
      parent_cache_root: sharedH, parent_preflight_path: physicalB!.preflight });
    const childCache = sharedHChild;
    const childGeneration = JSON.parse(readFileSync(revision.generation_path, "utf8"));
    const childPreflight = physicalChild === undefined ? await fillSource(worldRoot, snapshotPath,
      childCache, childGeneration, [revision.child_key], "child-h", sourceRaw,
      () => { attempts.revisedB++; }) : join(worldRoot, "current-child-h.json");
    if (physicalChild === undefined) {
      physicalChild = { key: revision.child_key, preflight: childPreflight };
    } else {
      expect(revision.child_key).toBe(physicalChild.key);
      const current = await preflightSourceSemanticInteractive({ variant: "native_source_snapshot",
        nativeSourcePopulation: { name: "originals", snapshotPath }, cacheRoot: childCache,
        sourcePacking: "complete-source", openSemantics: childGeneration,
        preflightKeys: [revision.child_key], preflightOutputTokenCap: 16_384,
        geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
      expect(current).toMatchObject({ selected_requests: 0, cached_requests: 1 });
      writeFileSync(childPreflight, JSON.stringify(current));
      const raw = providerRawAttemptPath(childCache, revision.child_key, 1), absent = `${raw}.temporarily-absent`;
      renameSync(raw, absent);
      try { expect(await runSemanticChainLauncher(["recover-publish-final", "--root", recoveryRoot,
        "--source-preflight", childPreflight, "--source-cache-root", childCache,
        "--source-physical-preflight", physicalChild.preflight])).toBe(2); }
      finally { renameSync(absent, raw); }
    }
    expect(await runSemanticChainLauncher(["recover-publish-final", "--root", recoveryRoot,
      "--source-preflight", childPreflight, "--source-cache-root", childCache,
      ...(index === 0 ? [] : ["--source-physical-preflight", physicalChild.preflight])])).toBe(0);
    expect(await runSemanticChainLauncher(["recover-prepare-final-c", "--root", recoveryRoot])).toBe(0);
    const newC = join(recoveryRoot, "final-correspondence-new-workset.json");
    if (existsSync(newC)) {
      await fillProposal(newC, join(recoveryRoot, "final-correspondence-cache"), correspondenceRaw, H_PROFILE);
    }
    expect(await runSemanticChainLauncher(["recover-final-deliver", "--root", recoveryRoot])).toBe(0);
    const exposure = readChainArtifact(join(recoveryRoot, "first-exposure.json"));
    exposures.push(chainIdentity(exposure));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("settled physical request was reposted"); }));
    expect(await runSemanticChainLauncher(["recover-final-deliver", "--root", recoveryRoot])).toBe(0);
    expect(chainIdentity(readChainArtifact(join(recoveryRoot, "first-exposure.json")))).toBe(exposures[index]);
  }
  expect(exposures).toHaveLength(2);
  expect(physicalSnapshots[0]).not.toBe(physicalSnapshots[1]);
  expect(publishedB[0]).not.toBe(publishedB[1]);
  expect(qChildKeys[0]).toBe(qChildKeys[1]);
  expect(attempts).toEqual({ originalQ: 1, reviewQ: 1, newA: 2, sharedB: 1, revisedB: 1 });
}, 120_000);

it("publishes two current H occurrences from one retained physical preflight", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-grouped-h-owner-")); roots.push(root);
  const world = WORLDS[1], snapshotPath = join(root, "original.sqlite");
  const physicalRoot = join(root, "physical-h"), qCache = join(root, "original-q");
  const sourceIds = ["source-a", "source-b"] as const;
  await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "native-daemon"),
    workspaceId: "grouped-h", runId: "grouped-h", producerCommit: "0".repeat(40),
    sources: world.bodies.map((body, index) => ({ source_id: sourceIds[index]!, source_version: "1",
      title: world.titles[index]!, content_bytes: body, source_observed_at: OBSERVED,
      recorded_at: INGESTED[index]! })) });
  const native = readVerifiedNativeSourceSnapshot(snapshotPath);
  const census = censusNativeSourceRecords({ population: "originals", snapshotPath });
  const inventory = nativeSourceRequestInventory(census.records, census.dataset_sha256, {
    model: MODEL, requestProfile: H_PROFILE, sourcePacking: "complete-source",
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION });
  const expectedDescriptors = native.records.map(row => [row.source_id, row.record.identity,
    inventory.requests.find(item => item.sourceCorpus === row.content_bytes)?.line.key]);
  const qWorkset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3",
    kind: "query", model: MODEL, request_profile: Q_PROFILE, provider_url: URL,
    items: [{ original_query: DATE_QUESTION, approved_fixed_context: DATE_CONTEXT }] });
  const qPath = join(root, "initial-q.json");
  writeFileSync(qPath, JSON.stringify(qWorkset));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", H_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", URL);
  setExtractionCredentialFixture();
  let hAttempts = 0;
  const keys: string[] = [];
  let physicalPreflight = "";
  let originalCKeys: string[] = [];
  for (const current of [false, true]) {
    const cycleRoot = join(root, current ? "current-cycle" : "physical-cycle");
    const recoveryRoot = join(cycleRoot, "recovery"), freezePath = join(cycleRoot, "freeze.json");
    const freeze = { native_snapshot_path: snapshotPath, population: "originals",
      source_model: MODEL, source_request_profile: H_PROFILE, source_cache_root: physicalRoot,
      ...(current ? { initial_h_physical_owners: keys.map(key => ({ key, cache_root: physicalRoot,
        physical_preflight_path: physicalPreflight })) } : {}),
      recorded_at: CLOCK, producer_commit: "0".repeat(40), allowance: ALLOWANCE,
      chain: { implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: CLOCK,
        workspace_id: "grouped-h", run_id: "grouped-h", query_workset: qWorkset,
        query_cache_root: qCache, correspondence_cache_root: join(cycleRoot, "c-cache"),
        max_output_tokens: 16_384,
        correspondence_generation: { model: MODEL, request_profile: H_PROFILE, provider_url: URL,
          max_output_tokens: 16_384 }, discovery_page_cap: 1,
        source_preview_extents: native.records.map(row => ({ source_id: row.source_id,
          source_version: row.source_version, record_id: row.record.identity,
          byte_extent: Buffer.byteLength(row.content_bytes) })),
        correspondence_pair_cap: 2, access_policy: "query-conditioned-v1", budget: BUDGET,
        authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 1_000_000 } };
    mkdirSync(cycleRoot);
    writeFileSync(freezePath, JSON.stringify(freeze));
    expect(await runSemanticChainLauncher(["recover-declare-initial-q", "--config", freezePath,
      "--root", recoveryRoot])).toBe(0);
    if (!current) await fillProposal(qPath, qCache, () => queryRaw(true, false), Q_PROFILE);
    expect(await runSemanticChainLauncher(["recover-freeze", "--config", freezePath,
      "--root", recoveryRoot])).toBe(0);
    const window = readChainArtifact(join(recoveryRoot, "recovery-window.json")) as {
      selected_missing_keys: string[]; initial_h_physical_owners: { key: string }[] };
    if (!current) {
      keys.push(...window.selected_missing_keys);
      expect(keys).toHaveLength(2);
      physicalPreflight = await fillSource(cycleRoot, snapshotPath, physicalRoot,
        EXTRACTION_OPEN_SEMANTICS_GENERATION, keys, "physical-h", sourceRaw,
        () => { hAttempts++; });
    } else {
      expect(window.selected_missing_keys).toEqual([]);
      expect(window.initial_h_physical_owners.map(row => row.key).sort()).toEqual([...keys].sort());
    }
    const currentPreflight = current ? join(cycleRoot, "current-h-preflight.json") : physicalPreflight;
    if (current) {
      const options = { variant: "native_source_snapshot" as const,
        nativeSourcePopulation: { name: "originals", snapshotPath }, cacheRoot: physicalRoot,
        sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
        preflightKeys: keys, preflightOutputTokenCap: 16_384,
        geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } };
      const preflight = await preflightSourceSemanticInteractive(options);
      expect(preflight).toMatchObject({ selected_requests: 0, cached_requests: 2 });
      expect(preflight.ready_requests.map(row => row.key).sort()).toEqual([...keys].sort());
      writeFileSync(currentPreflight, JSON.stringify(preflight));
      const incomplete = join(cycleRoot, "incomplete-h-preflight.json");
      writeFileSync(incomplete, JSON.stringify(await preflightSourceSemanticInteractive({
        ...options, preflightKeys: [keys[0]!] })));
      expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
        "--source-preflight", incomplete, "--source-cache-root", physicalRoot])).toBe(2);
      expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
        "--source-preflight", physicalPreflight, "--source-cache-root", physicalRoot])).toBe(2);
      expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
        "--source-preflight", currentPreflight, "--source-cache-root", join(root, "wrong-h-root")])).toBe(2);
      const ownersPath = join(cycleRoot, "invalid-source-owners.json");
      const owner = { key: keys[0], cache_root: physicalRoot,
        current_preflight_path: currentPreflight, physical_preflight_path: physicalPreflight };
      writeFileSync(ownersPath, JSON.stringify([owner, owner]));
      expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
        "--source-preflight", currentPreflight, "--source-cache-root", physicalRoot,
        "--source-owners", ownersPath])).toBe(2);
      writeFileSync(ownersPath, JSON.stringify([{ ...owner, key: "f".repeat(64) }]));
      expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
        "--source-preflight", currentPreflight, "--source-cache-root", physicalRoot,
        "--source-owners", ownersPath])).toBe(2);
      const changedWire = await preflightSourceSemanticInteractive({ ...options,
        preflightOutputTokenCap: 8192 });
      expect(() => readCompletePhysicalSourceResponseForRequest({ cacheRoot: physicalRoot,
        physicalPreflight: JSON.parse(readFileSync(physicalPreflight, "utf8")),
        currentPreflight: changedWire, currentLine: changedWire.ready_requests[0]! }))
        .toThrow("wire differs");
    }
    expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
      "--source-preflight", currentPreflight, "--source-cache-root", physicalRoot])).toBe(0);
    const qualified = readChainArtifact(join(recoveryRoot, "initial-qualified.json")) as {
      source_owners: { key: string; cache_root: string; current_preflight_path: string;
        physical_preflight_path?: string }[];
      descriptor_export: { source_id: string; record_id: string; generation_key: string }[] };
    expect(qualified.descriptor_export.map(row => [row.source_id, row.record_id, row.generation_key]).sort())
      .toEqual(expectedDescriptors.sort());
    if (current) expect(qualified.source_owners).toEqual(keys.map(key => ({ key,
      cache_root: physicalRoot, current_preflight_path: currentPreflight,
      physical_preflight_path: physicalPreflight })));
    expect(await runSemanticChainLauncher(["recover-prepare-initial-c", "--root", recoveryRoot])).toBe(0);
    const workset = parseSemanticProposalWorkset(JSON.parse(readFileSync(
      join(recoveryRoot, "initial-correspondence-workset.json"), "utf8")));
    const cKeys = materializeSemanticProposalLines(workset, 16_384).map(row => row.key).sort();
    if (current) expect(cKeys).toEqual(originalCKeys);
    else originalCKeys = cKeys;
    if (current) {
      const failedRoot = join(root, "failed-cycle"), failedRecovery = join(failedRoot, "recovery");
      const failedCache = join(root, "failed-h"), failedFreezePath = join(failedRoot, "freeze.json");
      mkdirSync(failedRoot);
      mkdirSync(failedCache);
      writeFileSync(failedFreezePath, JSON.stringify({ ...freeze, source_cache_root: failedCache,
        initial_h_physical_owners: [], chain: { ...freeze.chain,
          correspondence_cache_root: join(failedRoot, "c-cache") } }));
      expect(await runSemanticChainLauncher(["recover-declare-initial-q", "--config", failedFreezePath,
        "--root", failedRecovery])).toBe(0);
      expect(await runSemanticChainLauncher(["recover-freeze", "--config", failedFreezePath,
        "--root", failedRecovery])).toBe(0);
      const failedWindow = readChainArtifact(join(failedRecovery, "recovery-window.json")) as {
        selected_missing_keys: string[] };
      expect(failedWindow.selected_missing_keys).toEqual([...keys].sort());
      const failedOptions = { variant: "native_source_snapshot" as const,
        nativeSourcePopulation: { name: "originals", snapshotPath }, cacheRoot: failedCache,
        sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
        preflightKeys: keys, preflightOutputTokenCap: 16_384,
        geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } };
      const failedPreflight = join(failedRoot, "initial-h-preflight.json");
      writeFileSync(failedPreflight, JSON.stringify(await preflightSourceSemanticInteractive(failedOptions)));
      let failedAttempts = 0;
      await expect(fillSource(failedRoot, snapshotPath, failedCache, EXTRACTION_OPEN_SEMANTICS_GENERATION,
        [keys[0]!], "failed-h", () => JSON.stringify({ contract: "source-semantic-proposal-v8",
          outcome: { status: "interpreted" } }), () => { failedAttempts++; })).rejects.toThrow("quarantined");
      expect(failedAttempts).toBe(1);
      expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", failedRecovery,
        "--source-preflight", failedPreflight, "--source-cache-root", failedCache])).toBe(0);
      expect(readChainArtifact(join(failedRecovery, "initial-qualified.json"))).toMatchObject({
        published_selected_count: 0, descriptor_export: [],
        source_owners: keys.map(key => ({ key, cache_root: failedCache,
          current_preflight_path: failedPreflight })) });
      expect(await runSemanticChainLauncher(["recover-prepare-initial-c", "--root", failedRecovery])).toBe(0);
      expect(readChainArtifact(join(failedRecovery, "initial-correspondence-binding.json")))
        .toMatchObject({ workset_identity: null, source_interpretation_ids: [] });
    }
  }
  expect(hAttempts).toBe(2);
}, 120_000);
