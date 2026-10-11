import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson, SourceRecordIdentitySchema, SourceSemanticAccessReceiptSchema,
  SourceSemanticCorrespondencePreparationOptionsSchema } from "@do-soul/alaya-protocol";
import { censusNativeSourceRecords } from "../snapshot/source-records/census.js";
import { readVerifiedNativeSourceSnapshot } from "../snapshot/source-records/native.js";
import { publishSourceSemanticSnapshot, readNativeSourcePublicationReport } from "../snapshot/source-records/publish.js";
import { hashRegularFileNoFollow } from "../snapshot/bound-file.js";
import { nativeSourceOccurrenceId, nativeSourceRequestInventory } from "../extraction/fill/source-request-workset.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, parseExtractionOpenSemanticsGeneration } from
  "../extraction/request-artifact.js";
import type { SourceRequestLine } from "../extraction/request-artifact.js";
import { inspectCachedSourceSemantic } from "../extraction/cache/source-semantic-artifact.js";
import { readCompletePhysicalSourceResponseForRequest } from "../extraction/cache/source-interactive-binding.js";
import { parseSourceSemanticInteractivePreflight } from "../extraction/fill/source-semantic-interactive-preflight.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { EXTRACTION_REQUEST_PROFILES } from "../extraction/request-profile.js";
import { SemanticChainConfigSchema, SemanticChainPlanSchema, chainIdentity, readChainArtifact,
  writeChainArtifact } from "./contract.js";
import { prepareSemanticChain } from "./prepare.js";
import { verifySemanticChainQueries } from "./inputs.js";
import { RecoveryAllowanceSchema, freezeRecoveryAllowance, recoveryAllowanceIdentity,
  reserveRecoveryRead, reserveRecoveryAction, reserveRecoveryHostEffect } from "./recovery-allowance.js";
import { recordRecoveryNativeWork } from "./recovery-allowance.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const PhysicalSourceOwnerSchema = z.object({ key: Digest, cache_root: z.string().min(1),
  physical_preflight_path: z.string().min(1) }).strict();
// Refined chain objects reject .omit; drop snapshot fields and reuse protocol pairing.
const { snapshot_path: _snapshotPath, snapshot_sha256: _snapshotSha256, ...recoveryChainFields } =
  SemanticChainConfigSchema.shape;
const RecoveryChainConfigSchema = z.object(recoveryChainFields).strict().superRefine((config, context) => {
  const preparation = SourceSemanticCorrespondencePreparationOptionsSchema.safeParse({
    correspondence_demand: config.correspondence_demand, correspondence_cap: config.correspondence_cap
  });
  if (!preparation.success) for (const issue of preparation.error.issues) {
    context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});
const RecoveryFreezeInputSchema = z.object({
  native_snapshot_path: z.string().min(1), population: z.string().min(1),
  source_model: z.string().min(1), source_request_profile: z.enum(EXTRACTION_REQUEST_PROFILES),
  source_cache_root: z.string().min(1), recorded_at: z.string().datetime(),
  query_review_cache_root: z.string().min(1).optional(),
  initial_h_physical_owners: z.array(PhysicalSourceOwnerSchema).max(10).optional(),
  producer_commit: z.string().regex(/^[a-f0-9]{40}$/u),
  allowance: RecoveryAllowanceSchema,
  open_semantics: z.unknown().transform(parseExtractionOpenSemanticsGeneration).optional(),
  chain: RecoveryChainConfigSchema
}).strict();
const SourceRecordFields = SourceRecordIdentitySchema.unwrap().shape;
const WindowSourceSchema = z.object({ rank: z.number().int().min(1).max(10),
  source_id: z.string(), source_version: z.string(), record_id: z.string().min(1),
  content_digest: z.string().min(1), corpus_digest: z.string().min(1), source_observed_at: SourceRecordFields.event_time,
  recorded_at: SourceRecordFields.recorded_at, body_bytes: z.number().int().nonnegative().nullable(),
  read_bytes: z.number().int().nonnegative(), complete: z.boolean(),
  initial_key: Digest.nullable(), initial_cache_status: z.enum(["hit", "missing", "invalid", "unsupported"])
}).strict();
const RecoveryWindowSchema = z.object({ contract: z.literal("source-semantic-recovery-window-v1"),
  input_identity: Digest, native_snapshot_path: z.string(), native_manifest_identity: Digest,
  source_census_identity: Digest, raw_publication_identity: Digest,
  raw_snapshot_path: z.string(), raw_snapshot_sha256: Digest,
  initial_chain_root: z.string(), initial_plan_identity: Digest,
  query_key: Digest, query_state_identity: Digest, initial_access: SourceSemanticAccessReceiptSchema,
  initial_discovery_work: z.unknown(), initial_host_elapsed_ms: z.number().nonnegative(),
  source_cache_root: z.string(), population: z.string(), source_model: z.string(),
  query_review_cache_root: z.string(),
  initial_h_physical_owners: z.array(PhysicalSourceOwnerSchema).max(10),
  source_request_profile: z.enum(EXTRACTION_REQUEST_PROFILES), open_semantics: z.unknown(), recorded_at: z.string().datetime(),
  producer_commit: z.string().regex(/^[a-f0-9]{40}$/u),
  allowance_identity: Digest,
  window: z.array(WindowSourceSchema).max(10), selected_missing_keys: z.array(Digest).max(10),
  window_open: z.boolean()
}).strict();
export type RecoveryWindow = z.infer<typeof RecoveryWindowSchema>;

/** Reserve the original Q host preparation before its physical provider stage is allocated. */
export function declareRecoveryInitialQueryPreparation(value: unknown, rootInput: string): void {
  const input = RecoveryFreezeInputSchema.parse(value);
  if (input.chain.discovery_page_cap !== 1 || input.chain.query_workset.items.length !== 1) {
    throw new AlayaError("VALIDATION", "recovery requires one original query and one native discovery page");
  }
  const root = resolve(rootInput), identity = chainIdentity(input);
  freezeRecoveryAllowance(root, identity, input.allowance, input.native_snapshot_path);
  reserveRecoveryRead(root, "declare original Q host preparation");
  const path = join(root, "initial-Q-preparation.json");
  reserveRecoveryHostEffect(root, "initial-Q-preparation", identity, readChainArtifact(path) !== undefined);
  writeChainArtifact(path, { identity });
}

export function reserveRecoveryEffect(path: string, identity: string, completed: boolean): void {
  const prior = readChainArtifact(path);
  if (prior !== undefined) {
    if (canonicalJson(prior) !== canonicalJson({ identity })) {
      throw new AlayaError("CONFLICT", "recovery action reservation changed");
    }
    if (!completed) throw new AlayaError("CONFLICT", "reserved recovery action has no settled output");
    return;
  }
  if (completed) throw new AlayaError("CONFLICT", "recovery output lacks its prior reservation");
  writeChainArtifact(path, { identity });
}

type FreezeInput = z.infer<typeof RecoveryFreezeInputSchema>;

function admitPhysicalSourceOwner(owner: z.infer<typeof PhysicalSourceOwnerSchema>,
  line: SourceRequestLine, model: string, requestProfile: string): void {
  const preflight = parseSourceSemanticInteractivePreflight(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: owner.physical_preflight_path, maxBytes: 32 * 1024 * 1024, label: "original H physical preflight" })));
  if (preflight.config.model !== model || preflight.config.requestProfile !== requestProfile ||
      !preflight.ready_requests.some(row => row.key === owner.key)) {
    throw new AlayaError("CONFLICT", "shared H physical owner differs from the frozen exact request");
  }
  readCompletePhysicalSourceResponseForRequest({ cacheRoot: owner.cache_root,
    physicalPreflight: preflight, currentLine: line });
}

function admitPreviouslyFrozenWindow(root: string, input: FreezeInput, inputIdentity: string,
  nativeSnapshot: ReturnType<typeof readVerifiedNativeSourceSnapshot>,
  census: ReturnType<typeof censusNativeSourceRecords>, rawPath: string): RecoveryWindow | undefined {
  const prior = readChainArtifact(join(root, "recovery-window.json"));
  if (prior === undefined) return undefined;
  const window = RecoveryWindowSchema.parse(prior);
  const retainedPlan = SemanticChainPlanSchema.parse(readChainArtifact(join(window.initial_chain_root, "prepare.json")));
  const rawConfig = SemanticChainConfigSchema.parse({ ...input.chain, snapshot_path: rawPath,
    snapshot_sha256: hashRegularFileNoFollow(rawPath) });
  const report = readNativeSourcePublicationReport(rawPath, input.native_snapshot_path);
  verifySemanticChainQueries(retainedPlan);
  if (window.input_identity !== inputIdentity || window.native_manifest_identity !== nativeSnapshot.manifest.identity ||
      window.source_census_identity !== census.dataset_sha256 || window.raw_snapshot_path !== rawPath ||
      window.raw_snapshot_sha256 !== report.db_sha256 || window.raw_publication_identity !== chainIdentity(report) ||
      window.initial_plan_identity !== chainIdentity(retainedPlan) ||
      canonicalJson(retainedPlan.config) !== canonicalJson(rawConfig)) {
    throw new AlayaError("CONFLICT", "frozen recovery window differs from original source or query authority");
  }
  return window;
}

function projectInitialWindow(input: FreezeInput, census: ReturnType<typeof censusNativeSourceRecords>,
  report: ReturnType<typeof readNativeSourcePublicationReport>,
  access: z.infer<typeof SourceSemanticAccessReceiptSchema>) {
  const sourceById = new Map(census.records.map(row => [row.source_id, row]));
  const publishedById = new Map(report.sources.map(row => [row.source_id, row]));
  const generation = input.open_semantics ?? EXTRACTION_OPEN_SEMANTICS_GENERATION;
  const inventory = nativeSourceRequestInventory(census.records, census.dataset_sha256, {
    model: input.source_model, requestProfile: input.source_request_profile,
    sourcePacking: "complete-source", openSemantics: generation });
  const requestByKey = new Map(inventory.requests.map(row => [row.line.key, row.line]));
  const physicalOwners = (input.initial_h_physical_owners ?? []).map(row => ({ ...row,
    cache_root: resolve(row.cache_root), physical_preflight_path: resolve(row.physical_preflight_path) }));
  const physicalByKey = new Map(physicalOwners.map(row => [row.key, row]));
  if (physicalByKey.size !== physicalOwners.length) throw new AlayaError("CONFLICT", "frozen H physical owners repeat a key");
  const physicalChecked = new Set<string>();
  const seen = new Set<string>();
  const window = access.source_candidates.slice(0, 10).map((candidate, index) => {
    const source = sourceById.get(candidate.source_id);
    const published = publishedById.get(candidate.source_id);
    if (source === undefined || published === undefined || seen.has(candidate.record_id) ||
        source.native_record_id !== candidate.record_id || published.record_id !== candidate.record_id ||
        published.source_version !== source.source_version || published.content_digest !== source.content_digest ||
        published.corpus_digest !== source.corpus_digest || source.recorded_at === undefined) {
      throw new AlayaError("CONFLICT", "initial recovery window contains stale or foreign source");
    }
    seen.add(candidate.record_id);
    const requestKey = inventory.requestKeysByOccurrence.get(nativeSourceOccurrenceId(source));
    const line = requestKey === undefined ? undefined : requestByKey.get(requestKey);
    if (requestKey !== undefined && line === undefined) {
      throw new AlayaError("CONFLICT", "native source occurrence request is absent from its inventory");
    }
    const key = line?.key ?? null;
    const owner = key === null ? undefined : physicalByKey.get(key);
    const cache = key === null ? "unsupported" : inspectCachedSourceSemantic(owner?.cache_root ?? input.source_cache_root,
      key, input.source_model, input.source_request_profile).status;
    if (owner !== undefined && !physicalChecked.has(key!)) {
      if (cache !== "hit" || line === undefined) {
        throw new AlayaError("CONFLICT", "shared H physical owner is not a complete current cache hit");
      }
      admitPhysicalSourceOwner(owner, line, input.source_model, input.source_request_profile);
      physicalChecked.add(key!);
    }
    return WindowSourceSchema.parse({ rank: index + 1, source_id: source.source_id,
      source_version: source.source_version, record_id: candidate.record_id,
      content_digest: source.content_digest, corpus_digest: source.corpus_digest,
      source_observed_at: source.source_observed_at, recorded_at: source.recorded_at,
      body_bytes: candidate.body_bytes, read_bytes: candidate.read_bytes, complete: candidate.complete,
      initial_key: key, initial_cache_status: cache === "hit" ? "hit" : cache === "missing" ? "missing"
        : key === null ? "unsupported" : "invalid" });
  });
  const selected = [...new Set(window.filter(row => row.initial_cache_status === "missing" && row.initial_key !== null)
    .map(row => row.initial_key!))].sort();
  if (physicalChecked.size !== physicalOwners.length) {
    throw new AlayaError("CONFLICT", "frozen H physical owner is outside the first native source window");
  }
  return { window, selected, generation, physicalOwners };
}

/** The raw publication and one native page are separate, durable actions before H funding. */
export async function freezeNativeRecoveryWindow(value: unknown, rootInput: string): Promise<RecoveryWindow> {
  const input = RecoveryFreezeInputSchema.parse(value);
  if (input.chain.discovery_page_cap !== 1 || input.chain.query_workset.items.length !== 1) {
    throw new AlayaError("VALIDATION", "recovery requires one original query and one native discovery page");
  }
  const root = resolve(rootInput);
  const inputIdentity = chainIdentity(input);
  freezeRecoveryAllowance(root, inputIdentity, input.allowance, input.native_snapshot_path);
  const initialQ = readChainArtifact(join(root, "initial-Q-preparation.json"));
  if (canonicalJson(initialQ) !== canonicalJson({ identity: inputIdentity })) {
    throw new AlayaError("CONFLICT", "original Q preparation lacks its frozen prior admission");
  }
  reserveRecoveryHostEffect(root, "initial-Q-preparation", inputIdentity, true);
  reserveRecoveryRead(root, "freeze native source/census", [input.native_snapshot_path]);
  const nativeSnapshot = readVerifiedNativeSourceSnapshot(input.native_snapshot_path);
  const census = censusNativeSourceRecords({ population: input.population, snapshotPath: input.native_snapshot_path });
  if (nativeSnapshot.manifest.workspace_id !== input.chain.workspace_id ||
      nativeSnapshot.manifest.run_id !== input.chain.run_id || census.records.length > 10_000) {
    throw new AlayaError("CONFLICT", "native recovery population differs from its original workspace or run");
  }
  const rawPath = join(root, "raw-library.sqlite");
  const prior = admitPreviouslyFrozenWindow(root, input, inputIdentity, nativeSnapshot, census, rawPath);
  if (prior !== undefined) return prior;
  reserveRecoveryHostEffect(root, "raw-publication", inputIdentity, existsSync(rawPath));
  reserveRecoveryEffect(join(root, "raw-publication.reserved.json"), inputIdentity, existsSync(rawPath));
  if (!existsSync(rawPath)) await publishSourceSemanticSnapshot({ snapshotPath: rawPath,
    dataDirRoot: join(root, "raw-publication-runtime"), recordedAt: input.recorded_at,
    producerCommit: input.producer_commit, workspaceId: input.chain.workspace_id,
    runId: input.chain.run_id, populations: [{ name: input.population,
      nativeSnapshotPath: input.native_snapshot_path, model: input.source_model,
      requestProfile: input.source_request_profile }] });
  const rawConfig = SemanticChainConfigSchema.parse({ ...input.chain, snapshot_path: rawPath,
    snapshot_sha256: hashRegularFileNoFollow(rawPath) });
  const report = readNativeSourcePublicationReport(rawPath, input.native_snapshot_path);
  if (rawConfig.discovery_page_cap !== 1 || report.census_count !== census.records.length ||
      report.sources.some(row => row.source_interpretation_generation_key !== undefined ||
        !["absent", "copied_uninspected"].includes(row.source_interpretation))) {
    throw new AlayaError("CONFLICT", "raw recovery observation requires one page and no newly published H");
  }
  const planRoot = join(root, "initial-chain");
  const planPath = join(planRoot, "prepare.json");
  reserveRecoveryAction(root, "initial-native-prepare", chainIdentity(rawConfig),
    rawConfig.budget.work_units, rawConfig.budget.memory_bytes, readChainArtifact(planPath) !== undefined);
  reserveRecoveryEffect(join(root, "initial-prepare.reserved.json"), chainIdentity(rawConfig),
    readChainArtifact(planPath) !== undefined);
  const plan = SemanticChainPlanSchema.parse(await prepareSemanticChain(rawConfig, planRoot));
  const query = plan.queries[0];
  if (plan.queries.length !== 1 || rawConfig.query_workset.items.length !== 1 ||
      query === undefined || query.status === "blocked" || query.discovery_pages !== 1 ||
      query.initial_discovery_elapsed_ms === undefined || query.discovery_trace.length !== 1) {
    throw new AlayaError("CONFLICT", "recovery requires exactly one original query and first native page");
  }
  const first = query.discovery_trace[0]!;
  recordRecoveryNativeWork(root, "initial-native-prepare", first.work);
  if (first.access.trace.kind !== "preparation_page" || first.access.trace.source_offset !== 0) {
    throw new AlayaError("CONFLICT", "recovery native page differs from the bounded initial window");
  }
  const { window, selected, generation, physicalOwners } = projectInitialWindow(input, census, report, first.access);
  const initialHStage = { contract: "source-semantic-recovery-initial-H-stage-v1",
    input_identity: inputIdentity, source_census_identity: census.dataset_sha256,
    selected_keys: selected, model: input.source_model, request_profile: input.source_request_profile };
  const initialHStagePath = join(root, "initial-H-stage.json");
  reserveRecoveryHostEffect(root, "initial-H-preparation", chainIdentity(initialHStage),
    readChainArtifact(initialHStagePath) !== undefined);
  writeChainArtifact(initialHStagePath, initialHStage);
  const result = RecoveryWindowSchema.parse({ contract: "source-semantic-recovery-window-v1",
    input_identity: inputIdentity, native_snapshot_path: resolve(input.native_snapshot_path),
    native_manifest_identity: nativeSnapshot.manifest.identity, source_census_identity: census.dataset_sha256,
    raw_publication_identity: chainIdentity(report), raw_snapshot_path: rawPath,
    raw_snapshot_sha256: report.db_sha256, initial_chain_root: planRoot,
    initial_plan_identity: chainIdentity(plan), query_key: query.query_key,
    query_state_identity: plan.input_identity, initial_access: first.access,
    initial_discovery_work: first.work, initial_host_elapsed_ms: query.initial_discovery_elapsed_ms,
    source_cache_root: resolve(input.source_cache_root), population: input.population,
    query_review_cache_root: resolve(input.query_review_cache_root ?? join(root, "query-review-cache")),
    initial_h_physical_owners: physicalOwners,
    source_model: input.source_model, source_request_profile: input.source_request_profile,
    open_semantics: generation, recorded_at: input.recorded_at, producer_commit: input.producer_commit,
    allowance_identity: recoveryAllowanceIdentity(root),
    window, selected_missing_keys: selected,
    window_open: first.access.unvisited_sources || first.access.source_candidates.length > 10 ||
      first.access.source_candidates.length < Math.min(10, first.access.observed_source_count) });
  writeChainArtifact(join(root, "recovery-window.json"), result);
  return result;
}

/** Stages consume the immutable raw observation and re-admit its physical source and Q owners. */
export function admitRecoveryWindow(rootInput: string, readAllowanceRootInput = rootInput): RecoveryWindow {
  const root = resolve(rootInput);
  reserveRecoveryRead(resolve(readAllowanceRootInput), "admit frozen window");
  const window = RecoveryWindowSchema.parse(readChainArtifact(join(root, "recovery-window.json")));
  const native = readVerifiedNativeSourceSnapshot(window.native_snapshot_path);
  const census = censusNativeSourceRecords({ population: window.population,
    snapshotPath: window.native_snapshot_path });
  const report = readNativeSourcePublicationReport(window.raw_snapshot_path, window.native_snapshot_path);
  const initialHStage = readChainArtifact(join(root, "initial-H-stage.json")) as {
    input_identity?: string; source_census_identity?: string; selected_keys?: string[];
    model?: string; request_profile?: string } | undefined;
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(window.initial_chain_root, "prepare.json")));
  verifySemanticChainQueries(plan);
  if (window.initial_h_physical_owners.length > 0) {
    const inventory = nativeSourceRequestInventory(census.records, census.dataset_sha256, {
      model: window.source_model, requestProfile: window.source_request_profile,
      sourcePacking: "complete-source", openSemantics: parseExtractionOpenSemanticsGeneration(window.open_semantics) });
    for (const owner of window.initial_h_physical_owners) {
      const line = inventory.requests.find(row => row.line.key === owner.key)?.line;
      if (line === undefined || !window.window.some(row => row.initial_key === owner.key &&
          row.initial_cache_status === "hit")) {
        throw new AlayaError("CONFLICT", "shared H physical owner no longer belongs to the frozen source window");
      }
      admitPhysicalSourceOwner(owner, line, window.source_model, window.source_request_profile);
    }
  }
  const first = plan.queries[0]?.status === "blocked" ? undefined : plan.queries[0]?.discovery_trace[0];
  if (initialHStage?.input_identity !== window.input_identity ||
      initialHStage.source_census_identity !== window.source_census_identity ||
      canonicalJson(initialHStage.selected_keys) !== canonicalJson(window.selected_missing_keys) ||
      initialHStage.model !== window.source_model ||
      initialHStage.request_profile !== window.source_request_profile ||
      window.allowance_identity !== recoveryAllowanceIdentity(root) ||
      window.native_manifest_identity !== native.manifest.identity ||
      window.source_census_identity !== census.dataset_sha256 || window.raw_publication_identity !== chainIdentity(report) ||
      window.raw_snapshot_sha256 !== report.db_sha256 || window.initial_plan_identity !== chainIdentity(plan) ||
      plan.config.snapshot_path !== window.raw_snapshot_path || plan.config.snapshot_sha256 !== report.db_sha256 ||
      plan.config.discovery_page_cap !== 1 || plan.queries.length !== 1 ||
      first === undefined || canonicalJson(first.access) !== canonicalJson(window.initial_access) ||
      window.query_key !== plan.queries[0]?.query_key || window.query_state_identity !== plan.input_identity ||
      canonicalJson(window.window.map(row => [row.source_id, row.record_id])) !==
        canonicalJson(first.access.source_candidates.slice(0, 10).map(row => [row.source_id, row.record_id]))) {
    throw new AlayaError("CONFLICT", "recovery window no longer binds original native observation");
  }
  return window;
}
