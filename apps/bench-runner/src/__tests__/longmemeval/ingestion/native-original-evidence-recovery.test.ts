import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync,
  statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, SoulInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID,
  SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_VERSION } from "@do-soul/alaya-core";
import { parseSourceSemanticRequest, type SourceSemanticCorrespondenceProposalInput } from "@do-soul/alaya-soul";
import { interpretedQueryRaw } from "../query-producer-fixture.js";
import { correspondenceAssessmentJson } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-producer-fixture.js";
import { syntheticGeminiBody } from "../../runs/semantic-proposal/gemini-response-evidence.test-support.js";
import { prepareNativeSourceRecordsSnapshot, readVerifiedNativeSourceSnapshot } from
  "../../../runs/snapshot/source-records/native.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";
import { semanticProposalShardPath } from "../../../runs/semantic-proposal/artifact.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from
  "../../../runs/extraction/authority/inspection.js";
import { preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from
  "../../../runs/extraction/authority/receipt.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { setExtractionCredentialFixture } from "../extraction-fill/fixture.js";
import { runSemanticChainLauncher } from "../../../runs/semantic-chain/launch.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { deliverLivePreparedSemanticChain } from "../../../runs/semantic-chain/replay.js";
import { chainIdentity, readChainArtifact, withSemanticChainDaemon } from "../../../runs/semantic-chain/contract.js";
import { freezeRecoveryAllowance, reserveRecoveryAction, reserveRecoveryHostEffect,
  reserveRecoveryRead, recordRecoveryNativeWork } from "../../../runs/semantic-chain/recovery-allowance.js";
import { censusNativeSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { nativeSourceRequestInventory } from "../../../runs/extraction/fill/source-request-workset.js";
import { providerRawAttemptPath } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import type { ExtractionRequestProfile } from "../../../runs/extraction/request-profile.js";

const CLOCK = "2026-09-25T00:00:00.000Z";
const OBSERVED = "2026-09-20T12:00:00.000Z";
const INGESTED = ["2026-09-21T09:00:00.000Z", "2026-09-21T09:00:01.000Z"] as const;
const URL = "https://generativelanguage.googleapis.com";
const MODEL = "gemini-3.1-flash-lite";
const H_PROFILE = "gemini-3.1-low-v1";
const Q_PROFILE = "gemini-3.1-minimal-v1";
const BUDGET = { schema_version: 1, work_units: 10_000_000, memory_bytes: 200_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
const ALLOWANCE = { total_work_units: 4_000_000_000, total_memory_bytes: 30_000_000_000,
  read_work_units: 10_000_000, read_memory_bytes: 100_000_000,
  max_input_bytes_per_read: 100_000_000, max_read_admissions: 256, max_effects: 32 };
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
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function queryRaw(date: boolean, reviewed: boolean): string {
  const roles = date ? [
    { role: "actor", target: { kind: "named", key: "actor", excerpt: "Mira" }, excerpt: "Mira" },
    { role: "tool", target: { kind: "free", key: "answer", return: true }, excerpt: "Which tool" },
    { role: "purpose", target: { kind: "named", key: "purpose", excerpt: "indexing" }, excerpt: "indexing" },
    ...(reviewed ? [{ role: "event_date", target: { kind: "named", key: "eventDate",
      excerpt: "August 14, 2026" }, excerpt: "August 14, 2026" }] : [])
  ] : [
    { role: "actor", target: { kind: "named", key: "actor", excerpt: "Mira" }, excerpt: "Mira" },
    { role: "format", target: { kind: "free", key: "answer", return: true }, excerpt: "Which file format" },
    { role: "export", target: { kind: "named", key: "export", excerpt: "Atlas export" }, excerpt: "Atlas export" }
  ];
  return interpretedQueryRaw({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    alternatives: [{ conditions: [{ kind: "statement", key: "use", predicate: "use", arguments: roles }] }], gaps: [] });
}

function sourceRaw(prompt: string, completeInitial = false): string {
  const request = parseSourceSemanticRequest(JSON.parse(prompt));
  const assertions = request.source_request.source_assertions;
  const revision = request.source_request.revision !== undefined;
  const selected = revision || completeInitial ? assertions.find(row => row.text.includes(" used ")) ?? assertions.find(row => row.text.includes(" archived ")) ?? assertions[0]
    : assertions[0];
  if (selected === undefined) throw new Error("source response has no assertion");
  const text = selected.text;
  const indexing = /Mira used (\w+) for indexing on (\d{4}-\d{2}-\d{2})\./u.exec(text);
  const format = /Mira used (\w+) for the (\w+) export\./u.exec(text);
  const named = indexing ? { actor: "Mira", tool: indexing[1]!, purpose: "indexing", event_date: indexing[2]! }
    : format ? { actor: "Mira", format: format[1]!, export: format[2]! }
      : { export: "Atlas" };
  const quote = (value: string) => ({ assertion_id: selected.assertion_id, text: value });
  const entities = Object.entries(named).map(([key, value]) => ({ form: "selection", key,
    selection: quote(value) }));
  const use = indexing !== null || format !== null;
  const predicate = use ? "used" : text.includes("archived") ? "archived" : "completed";
  return JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" },
    content: { roots: [{ act: "assertion", expression: { kind: "content_ref", key: "event" } }],
      entities, nodes: [{ kind: "statement", key: "event", predicate: { kind: "explicit",
        reading: use ? "use" : predicate, support: quote(predicate) },
        arguments: Object.keys(named).map(role => ({ role, target: { kind: "entity_ref", key: role } })),
        qualifications: [] }], gaps: [] } });
}

function correspondenceRaw(prompt: string): string {
  const request = JSON.parse(prompt) as SourceSemanticCorrespondenceProposalInput;
  const interpretation = request.source_interpretation_descriptors[0]!.interpretation;
  const query = request.admitted_query_semantics;
  const frame = interpretation.frames[0]!;
  const queryFrame = query.alternatives[0]!.frames[0]!;
  const pairs: object[] = [];
  if (frame.predicate_support.kind === "explicit" && frame.predicate_support.reading === "use") pairs.push({
    relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: queryFrame.id },
    source_endpoint: { kind: "frame", frame: frame.id }, query_support: { kind: "query_text", excerpt: "use" },
    source_semantic_support: [{ kind: "lexical", mentions: frame.predicate_support.mentions }] });
  for (const requirement of queryFrame.role_requirements) {
    const slot = frame.slots.find(row => row.role_reading === requirement.role_reading);
    if (slot === undefined) continue;
    const target = frame.bindings.find(row => row.slot_id === slot.id)?.target;
    if (target?.kind !== "node") throw new Error("authored source role lacks referent");
    const referent = interpretation.referents.find(row => row.id === target.id)!;
    const support = [{ kind: "lexical", mentions: [referent.mentions[0]!] }];
    pairs.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "slot", alternative: 0, frame: queryFrame.id, slot: requirement.id },
      source_endpoint: { kind: "slot", frame: frame.id, slot: slot.id },
      query_support: requirement.support, source_semantic_support: support });
    const variable = query.variables.find(row => row.id === requirement.target_variable);
    const sourceText = referent.mentions.map(id => interpretation.mentions.find(row => row.id === id)?.text ?? "").join(" ");
    const reference = variable?.reference?.excerpt ?? "";
    const same = requirement.role_reading === "event_date"
      ? new Date(`${sourceText}T00:00:00.000Z`).getTime() === new Date(`${reference} UTC`).getTime()
      : reference.includes(sourceText);
    if (variable?.reference !== undefined && same) pairs.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "referent", variable: variable.id },
      source_endpoint: { kind: "referent", referent: referent.id },
      query_support: variable.reference, source_semantic_support: support });
  }
  return correspondenceAssessmentJson({ ...request,
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID,
    producer_version: SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_VERSION },
  { correspondences: pairs });
}

async function fillProposal(path: string, cacheRoot: string, raw: (prompt: string) => string,
  profile: ExtractionRequestProfile, onAttempt?: () => void) {
  const workset = parseSemanticProposalWorkset(JSON.parse(readFileSync(path, "utf8")));
  mkdirSync(cacheRoot, { recursive: true });
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, cacheRoot, 16_384, 1),
    inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 });
  return executeSemanticProposalFill({ workset, cacheRoot, authority,
    config: { providerUrl: URL, model: MODEL, requestProfile: profile, apiKey: "fixture" },
    extractor: { extract: async ({ userPrompt }) => {
      onAttempt?.();
      const rawJson = raw(userPrompt);
      return { rawJson, responseMetadata: { finishReason: "STOP" },
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        responseBody: syntheticGeminiBody(rawJson, "STOP", { inputTokens: 10, outputTokens: 20, totalTokens: 30 }) };
    } } });
}

async function fillSource(root: string, snapshotPath: string, cacheRoot: string,
  generation: typeof EXTRACTION_OPEN_SEMANTICS_GENERATION, keys: readonly string[], label: string,
  raw: (prompt: string) => string = sourceRaw, onAttempt?: () => void) {
  mkdirSync(cacheRoot, { recursive: true });
  const options = { variant: "native_source_snapshot" as const,
    nativeSourcePopulation: { name: "originals", snapshotPath }, cacheRoot,
    sourcePacking: "complete-source" as const, openSemantics: generation };
  const inspection = await inspectExtractionAuthority({ ...options, action: "sample",
    revision: readCurrentExtractionAuthorityRevision() });
  const preflight = await preflightSourceSemanticInteractive({ ...options, preflightKeys: keys,
    preflightOutputTokenCap: 16_384, geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
  const receipt = createExtractionAuthorityReceipt({ action: "sample",
    sampleScope: createExtractionSampleScope(keys, inspection), sourcePreflight: preflight,
    observation: inspection.observation, inspection, maxConcurrency: 1,
    outputTokenCap: { field: "maxOutputTokens", value: 16_384 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const receiptPath = join(root, `${label}-receipt.json`), preflightPath = join(root, `${label}-preflight.json`);
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  writeFileSync(preflightPath, JSON.stringify(preflight));
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    onAttempt?.();
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    const response = raw(prompt);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: response }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  }));
  const filled = await runExtractionFill({ ...options, authorityReceiptPath: receiptPath, concurrency: 1 });
  expect(filled.newlyExtracted).toBe(keys.length);
  return preflightPath;
}

for (const world of [...WORLDS, { ...WORLDS[2], name: "format C-only revision", cOnly: true }] as const)
  it(`delivers the frozen ${world.name} distinction through the connected native recovery`, async () => {
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
  await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "native-daemon"),
    workspaceId: worldId, runId: worldId,
    producerCommit,
    sources: world.bodies.map((body, index) => ({ source_id: sourceIds[index]!, source_version: "1",
      title: world.titles[index]!, content_bytes: body, source_observed_at: OBSERVED,
      recorded_at: INGESTED[index]! })) });
  const native = readVerifiedNativeSourceSnapshot(snapshotPath);
  expect(native.records.map(row => [row.title, row.content_bytes, row.source_observed_at, row.recorded_at]))
    .toEqual(world.bodies.map((body, index) => [world.titles[index], body, OBSERVED, INGESTED[index]]));
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
  expect(await runSemanticChainLauncher(["recover-declare-initial-q", "--config", freezePath,
    "--root", recoveryRoot])).toBe(0);
  await fillProposal(qWorksetPath, qCache, () => queryRaw(world.date, false), Q_PROFILE);
  expect(await runSemanticChainLauncher(["recover-freeze", "--config", freezePath, "--root", recoveryRoot])).toBe(0);
  const frozen = readChainArtifact(join(recoveryRoot, "recovery-window.json")) as {
    window: { source_id: string; read_bytes: number; complete: boolean }[]; selected_missing_keys: string[];
    initial_discovery_work: unknown };
  recordRecoveryNativeWork(staticRoot, "shared-raw-observation", frozen.initial_discovery_work);
  expect(frozen.window).toHaveLength(2);
  if (!world.date) expect(frozen.window.find(row => row.source_id === sourceIds[0])).toMatchObject({
    read_bytes: Buffer.byteLength("Mira completed the Atlas export.\n"), complete: false });
  if (world.name === "date positive") {
    const originalConfig = readFileSync(freezePath, "utf8");
    const changed = JSON.parse(originalConfig);
    changed.chain.source_preview_extents[0].byte_extent -= 1;
    writeFileSync(freezePath, JSON.stringify(changed));
    try { expect(await runSemanticChainLauncher(["recover-freeze", "--config", freezePath,
      "--root", recoveryRoot])).toBe(2); }
    finally { writeFileSync(freezePath, originalConfig); }
  }
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", H_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", URL);
  setExtractionCredentialFixture();
  reserveRecoveryRead(staticRoot, "shared selected H source and preflight");
  reserveRecoveryHostEffect(staticRoot, "shared-initial-H", staticIdentity, false);
  const hCache = join(root, "h-cache");
  const hPreflight = await fillSource(root, snapshotPath, hCache, EXTRACTION_OPEN_SEMANTICS_GENERATION,
    frozen.selected_missing_keys, "initial-h", prompt => sourceRaw(prompt, cOnly));
  expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
    "--source-preflight", hPreflight, "--source-cache-root", hCache])).toBe(0);
  expect(await runSemanticChainLauncher(["recover-prepare-initial-c", "--root", recoveryRoot])).toBe(0);
  reserveRecoveryRead(staticRoot, "shared initial C workset and physical owner");
  reserveRecoveryHostEffect(staticRoot, "shared-initial-C", staticIdentity, false);
  const cInitial = join(recoveryRoot, "initial-correspondence-workset.json");
  const initialCResult = await fillProposal(cInitial, join(root, "c-cache"), cOnly
    ? () => JSON.stringify({ contract: "source-semantic-correspondence-response-v4", outcome: { status: "abstained" } })
    : correspondenceRaw, H_PROFILE);
  if (cOnly) expect(initialCResult).toMatchObject({ requested: 2, abstained: 2 });
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
  const staticReplay = await withSemanticChainDaemon(staticConfig, staticRoot, async daemon => {
    let handles: ReadonlyMap<string, string | undefined> = new Map();
    const plan = await prepareSemanticChain(staticConfig, staticRoot, daemon, current => { handles = current; });
    const preparedQuery = plan.queries[0];
    if (preparedQuery?.status === "blocked" || preparedQuery?.discovery_trace[0] === undefined) {
      throw new Error("static S1 lacks a completed native discovery");
    }
    recordRecoveryNativeWork(staticRoot, "static-S1-prepare", preparedQuery.discovery_trace[0].work);
    return deliverLivePreparedSemanticChain(staticRoot, daemon, handles);
  });
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
  expect(await runSemanticChainLauncher(["recover-reason-initial", "--root", recoveryRoot])).toBe(0);
  expect(await runSemanticChainLauncher(["recover-prepare-q-review", "--root", recoveryRoot])).toBe(0);
  await fillProposal(join(recoveryRoot, "query-review-workset.json"), join(recoveryRoot, "query-review-cache"),
    () => queryRaw(world.date, true), Q_PROFILE);
  expect(await runSemanticChainLauncher(["recover-settle-q-review", "--root", recoveryRoot])).toBe(0);
  const review = readChainArtifact(join(recoveryRoot, "query-review.json")) as { changed: boolean };
  expect(review.changed).toBe(world.date);
  expect(await runSemanticChainLauncher(["recover-prepare-source", "--root", recoveryRoot])).toBe(0);
  const read = readChainArtifact(join(recoveryRoot, "recovery-source-read.json")) as {
    source_id: string; response: { catalog: { assertions: { segments: { text: string }[] }[] } } };
  if (!world.date) expect(read.response.catalog.assertions.map(row => row.segments.map(part => part.text).join("")))
    .toContain(world.bodies[0]!.split("\n")[1]);
  expect(await runSemanticChainLauncher(["recover-prepare-h-revision", "--root", recoveryRoot])).toBe(0);
  const revision = readChainArtifact(join(recoveryRoot, "source-revision.json")) as {
    child_key: string; generation_path: string };
  const childCache = join(root, "child-h-cache");
  const childGeneration = JSON.parse(readFileSync(revision.generation_path, "utf8"));
  const childPreflight = await fillSource(root, snapshotPath, childCache, childGeneration,
    [revision.child_key], "child-h", cOnly
      ? () => JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "abstained" } })
      : sourceRaw);
  if (world.name === "date positive") {
    const shard = cacheFilePath(childCache, revision.child_key);
    const missing = `${shard}.temporarily-absent`;
    renameSync(shard, missing);
    try {
      expect(await runSemanticChainLauncher(["recover-publish-final", "--root", recoveryRoot,
        "--source-preflight", childPreflight, "--source-cache-root", childCache])).toBe(2);
    } finally { renameSync(missing, shard); }
  }
  expect(await runSemanticChainLauncher(["recover-publish-final", "--root", recoveryRoot,
    "--source-preflight", childPreflight, "--source-cache-root", childCache])).toBe(0);
  expect(await runSemanticChainLauncher(["recover-prepare-final-c", "--root", recoveryRoot])).toBe(0);
  const newC = join(recoveryRoot, "final-correspondence-new-workset.json");
  if (cOnly) {
    expect(existsSync(newC)).toBe(true);
    expect(parseSemanticProposalWorkset(JSON.parse(readFileSync(newC, "utf8"))).items[0])
      .toHaveProperty("revision.previous_response_completion", "complete");
    expect(readChainArtifact(join(recoveryRoot, "final-qualified.json")))
      .toHaveProperty("source_outcome", "initial_reused_terminal_child");
  }
  if (existsSync(newC)) {
    await fillProposal(newC,
      join(recoveryRoot, "final-correspondence-cache"), correspondenceRaw, H_PROFILE);
  }
  expect(await runSemanticChainLauncher(["recover-final-deliver", "--root", recoveryRoot])).toBe(0);
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
}, 60_000);

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
