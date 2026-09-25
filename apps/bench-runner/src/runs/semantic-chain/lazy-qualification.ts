import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson, SourceRecordIdentitySchema,
  SourceSemanticAccessReceiptSchema, SourceSemanticWorkerWorkSchema } from "@do-soul/alaya-protocol";
import { hashRegularFileNoFollow } from "../snapshot/bound-file.js";
import { censusCompleteSourceRecords } from "../snapshot/source-records/census.js";
import { prepareSourcePublicationAssociations } from "../snapshot/source-records/prepare-associations.js";
import { publishSourceSemanticSnapshot, SourcePublicationAssociationRowSchema,
  type SourcePublicationAssociation } from "../snapshot/source-records/publish.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, parseExtractionOpenSemanticsGeneration } from "../extraction/request-artifact.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { withSnapshotPublishLock } from "../snapshot/freeze/publish-lock.js";
import { readSemanticChainProposalResults, semanticChainProposalStates,
  verifySemanticChainQueries } from "./inputs.js";
import { prepareSemanticChain } from "./prepare.js";
import { admitSemanticChainReplay, inspectSemanticChainReplayTarget, ReplaySchema,
  replaySemanticChain, semanticChainReplayPath } from "./replay.js";
import { SemanticChainPlanSchema, assertChainSnapshot, chainIdentity, readChainArtifact,
  writeChainArtifact, writeChainJson } from "./contract.js";
import { Digest, SourceTuple, PublicationReport, LazyQualificationConfigSchema,
  admitNativeLazyConfig, type LazyQualificationConfig } from "./bind-lazy.js";
import { selectedProducerAttempts, selectedSourceState } from "./lazy-qualification-source-state.js";

type Config = LazyQualificationConfig;

const WindowRow = SourceTuple.extend({
  rank: z.number().int().min(1).max(10), key: Digest.nullable(), cache_root: z.string().nullable(),
  question_id: z.string(), session_id: z.string(), session_index: z.number().int().nonnegative(),
  round_index: z.number().int().nonnegative(), source_observed_at: z.string().datetime(),
  roles: z.array(z.enum(["user", "assistant"])), speaker: z.enum(["user", "assistant", "system"]).nullable(),
  source_record: SourceRecordIdentitySchema,
  state: z.enum(["observation_incomplete", "unsupported_source", "unowned", "foreign_cache", "cache_hit_interpreted", "cache_hit_abstained",
    "cache_hit_empty", "cache_invalid", "cache_miss", "attempt_pending", "attempt_failed", "attempt_unknown"]),
  cache_identity: z.string().nullable(), attempt_identity: z.string().nullable(),
  starting_attempt_refs: z.array(z.string()), starting_raw_refs: z.array(z.string()),
  attempt_history_complete: z.boolean()
}).strict();
const WindowSchema = z.object({
  contract: z.literal("source-semantic-lazy-qualification-window-v2"), provider_calls: z.literal(0),
  config: LazyQualificationConfigSchema, query_key: Digest, query_state_identity: Digest,
  starting_snapshot_sha256: Digest, starting_publication_identity: Digest,
  source_inventory_identity: Digest, dataset_sha256: Digest,
  starting_access: SourceSemanticAccessReceiptSchema, window_open: z.boolean(),
  starting_discovery_work: SourceSemanticWorkerWorkSchema, starting_host_elapsed_ms: z.number().nonnegative(),
  starting_associations: z.array(SourcePublicationAssociationRowSchema),
  window: z.array(WindowRow).max(10), selected_missing_keys: z.array(Digest).max(10)
}).strict();
export type LazyQualificationWindow = z.infer<typeof WindowSchema>;
const FinalSchema = z.object({
  contract: z.literal("source-semantic-lazy-qualification-final-v2"), window_identity: Digest,
  final_snapshot_path: z.string(), final_snapshot_sha256: Digest, publication_report_path: z.string(),
  publication_report_identity: Digest,
  final_chain_root: z.string(), final_chain_identity: Digest, provider_calls: z.literal(0),
  selected_source_count: z.number().int().nonnegative(), selected_new_associations: z.number().int().nonnegative(),
  warm_outside_associations: z.number().int().nonnegative(),
  source_producer: z.object({ new_authorized_attempts: z.number().int().nonnegative().nullable(),
    new_raw_receipts: z.number().int().nonnegative(), preexisting_attempt_raw_receipts: z.number().int().nonnegative(),
    reported_input_tokens: z.number().int().nonnegative().nullable(), reported_output_tokens: z.number().int().nonnegative().nullable(),
    unknown_usage_attempts: z.number().int().nonnegative().nullable(), unresolved_new_attempts: z.number().int().nonnegative().nullable(),
    attempt_history_complete: z.boolean() }).strict(),
  host: z.object({ starting_discovery_work: SourceSemanticWorkerWorkSchema,
    starting_elapsed_ms: z.number().nonnegative(), publication_elapsed_ms: z.number().nonnegative(),
    reprepare_elapsed_ms: z.number().nonnegative(), final_discovery_work: z.array(SourceSemanticWorkerWorkSchema).nullable() }).strict(),
  final_access: SourceSemanticAccessReceiptSchema.nullable()
}).strict();
const ExposureReservationSchema = z.object({ final_identity: Digest, replay_identity: Digest,
  replay_path: z.string() }).strict();
const ExposureSchema = ExposureReservationSchema.extend({ contract: z.literal("source-semantic-lazy-first-exposure-v2"),
  replay_digest: Digest, selected_delivered: z.number().int().nonnegative(),
  selected_undelivered: z.number().int().nonnegative(), outside_delivered: z.number().int().nonnegative() }).strict();

function sourceInventory(rows: readonly z.infer<typeof SourceTuple>[]): string {
  return chainIdentity(rows.map(({ source_id, source_version, content_digest, corpus_digest, record_id }) =>
    ({ source_id, source_version, content_digest, corpus_digest, record_id })));
}

function finalAssociationPolicy(window: LazyQualificationWindow, row: SourcePublicationAssociation):
  "host_disposition" | "selected_new" | "selected_warm" | "outside_warm" | "forbidden" {
  if ("status" in row && row.status === "unsupported_source") return "host_disposition";
  if (!("generation_key" in row)) return "forbidden";
  const selected = window.window.find(source => source.source_id === row.source_id);
  const warm = window.starting_associations.find(source => source.source_id === row.source_id &&
    "generation_key" in source && canonicalJson(source) === canonicalJson(row));
  if (selected === undefined) return warm === undefined ? "forbidden" : "outside_warm";
  if (selected.source_version !== row.source_version) return "forbidden";
  if (warm !== undefined) return "selected_warm";
  return selected.state === "observation_incomplete" || selected.state === "unsupported_source"
    ? "forbidden" : "selected_new";
}

async function assertNativeBinding(config: Config) {
  // Native stages re-admit the retained preparation and complete source owner.
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(config.initial_chain_root, "prepare.json")));
  const population = config.source_population;
  const owner = config.cache_owners[0];
  if (owner === undefined) throw new AlayaError("CONFLICT", "bound source preparation requires an owner");
  const bound = await admitNativeLazyConfig({ plan, initialChainRoot: config.initial_chain_root,
    population: { name: population.name, dataDir: population.dataDir,
      pinnedMetaRoot: population.pinnedMetaRoot, questionWindow: population.questionWindow },
    sourcePreflightPath: owner.retainedPreparationPath, sourceCacheRoot: owner.cacheRoot,
    recordedAt: config.recorded_at, producerCommit: config.producer_commit });
  if (canonicalJson(bound.config) !== canonicalJson(config)) {
    throw new AlayaError("CONFLICT", "lazy qualification config differs from its native binding");
  }
  return bound;
}

function currentQuery(config: Config) {
  if (config.chain.query_workset.items.length !== 1) {
    throw new AlayaError("VALIDATION", "lazy qualification requires exactly one original query");
  }
  const results = readSemanticChainProposalResults(config.chain.query_workset,
    config.chain.query_cache_root, config.chain.max_output_tokens);
  return { row: results[0]!, identity: chainIdentity(semanticChainProposalStates(results)) };
}

function assertWindowOwner(root: string, window: LazyQualificationWindow,
  publication: z.infer<typeof PublicationReport>): void {
  const first = window.starting_access;
  if (chainIdentity(publication) !== window.starting_publication_identity ||
      sourceInventory(publication.sources) !== window.source_inventory_identity ||
      first.trace.kind !== "preparation_page" || first.trace.source_offset !== 0 ||
      window.window.length !== Math.min(10, first.source_candidates.length) ||
      window.window_open !== (first.unvisited_sources || first.source_candidates.length < Math.min(10, first.observed_source_count)) ||
      new Set(window.window.map(row => row.record_id)).size !== window.window.length) {
    throw new AlayaError("CONFLICT", "frozen lazy window differs from its native source observation or publication");
  }
  for (const [index, row] of window.window.entries()) {
    const native = first.source_candidates[index];
    const source = publication.sources.find(candidate => candidate.source_id === row.source_id);
    if (native?.source_id !== row.source_id || native.record_id !== row.record_id || row.rank !== index + 1 ||
        (native.complete === false) !== (row.state === "observation_incomplete") ||
        source === undefined || row.source_version !== source.source_version ||
        row.content_digest !== source.content_digest || row.corpus_digest !== source.corpus_digest ||
        canonicalJson(row.source_record) !== canonicalJson(source.source_record)) {
      throw new AlayaError("CONFLICT", "frozen lazy source/version tuple changed");
    }
  }
  const missing = [...new Set(window.window.filter(row => row.state === "cache_miss" && row.key !== null)
    .map(row => row.key!))].sort();
  if (canonicalJson(missing) !== canonicalJson(window.selected_missing_keys)) {
    throw new AlayaError("CONFLICT", "selected source request keys differ from the frozen cache-miss window");
  }
  const starting = z.object({ publicationAssociations: z.array(SourcePublicationAssociationRowSchema) })
    .passthrough().parse(readChainArtifact(join(root, "starting-associations.json")));
  if (canonicalJson(starting.publicationAssociations) !== canonicalJson(window.starting_associations)) {
    throw new AlayaError("CONFLICT", "starting source associations changed");
  }
}

export async function admitLazyWindow(root: string, expectedConfig?: Config) {
  const window = WindowSchema.parse(readChainArtifact(join(root, "window.json")));
  if (expectedConfig !== undefined && canonicalJson(window.config) !== canonicalJson(expectedConfig)) {
    throw new AlayaError("CONFLICT", "lazy window config changed");
  }
  const bound = await assertNativeBinding(window.config);
  const { publication, census } = bound;
  assertWindowOwner(root, window, publication);
  if (currentQuery(window.config).identity !== window.query_state_identity ||
      window.query_state_identity !== window.config.initial_query_state_identity ||
      publication.db_sha256 !== window.starting_snapshot_sha256) {
    throw new AlayaError("CONFLICT", "lazy qualification starting query or snapshot changed");
  }
  const records = new Map(publication.sources.map(row => [row.source_id, row]));
  if (census.dataset_sha256 !== window.dataset_sha256 || sourceInventory(census.records.map(row => ({
    ...row, record_id: records.get(row.source_id)?.record_id ?? ""
  }))) !== window.source_inventory_identity) {
    throw new AlayaError("CONFLICT", "lazy qualification source census changed; no replacement work is authorized");
  }
  const current = new Map(census.records.map(source => [source.source_id, source]));
  for (const row of window.window) {
    const source = current.get(row.source_id);
    if (source === undefined || row.question_id !== source.question_id || row.session_id !== source.session_id ||
        row.session_index !== source.session_index || row.round_index !== source.round_index ||
        row.source_observed_at !== source.source_observed_at ||
        canonicalJson(row.roles) !== canonicalJson(source.roles) || row.speaker !== (source.speaker ?? null)) {
      throw new AlayaError("CONFLICT", "frozen source occurrence metadata changed");
    }
  }
  return { window, publication, census };
}

export async function admitLazyFinal(root: string) {
  const { window, publication: initial, census } = await admitLazyWindow(root);
  const final = FinalSchema.parse(readChainArtifact(join(root, "final.json")));
  const snapshotPath = join(root, "final-library.sqlite");
  const reportPath = `${snapshotPath}.publication.json`;
  if (final.window_identity !== chainIdentity(window) || final.final_snapshot_path !== snapshotPath ||
      final.publication_report_path !== reportPath || final.selected_source_count !== window.window.length) {
    throw new AlayaError("CONFLICT", "final stage does not bind its frozen source window");
  }
  const report = PublicationReport.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: reportPath, maxBytes: 32 * 1024 * 1024, label: "final source publication" })));
  if (report.snapshot_path !== snapshotPath || report.db_sha256 !== final.final_snapshot_sha256 ||
      hashRegularFileNoFollow(snapshotPath) !== report.db_sha256 ||
      chainIdentity(report) !== final.publication_report_identity || report.census_count !== census.records.length ||
      sourceInventory(report.sources) !== window.source_inventory_identity) {
    throw new AlayaError("CONFLICT", "final publication does not bind the complete frozen source census");
  }
  const original = new Map(initial.sources.map(source => [source.source_id, source]));
  if (report.sources.some(source => source.admission !== "admitted" ||
      canonicalJson(source.source_record) !== canonicalJson(original.get(source.source_id)?.source_record))) {
    throw new AlayaError("CONFLICT", "final source identity or scope changed from the frozen census");
  }
  let newlyBound = 0, outsideWarm = 0;
  for (const source of report.sources) {
    const key = source.source_interpretation_generation_key;
    const digest = source.source_interpretation_binding?.request_digest;
    if (key === undefined && digest === undefined) continue;
    if (key === undefined || digest === undefined) throw new AlayaError("CONFLICT", "final source binding is incomplete");
    const policy = finalAssociationPolicy(window, { source_id: source.source_id,
      source_version: source.source_version, generation_key: key, request_digest: digest });
    if (policy === "forbidden" || policy === "host_disposition") {
      throw new AlayaError("CONFLICT", "final source gained an unqualified interpretation");
    }
    if (policy === "selected_new") newlyBound++;
    if (policy === "outside_warm") outsideWarm++;
  }
  if (newlyBound !== final.selected_new_associations || outsideWarm !== final.warm_outside_associations) {
    throw new AlayaError("CONFLICT", "final source association counts changed");
  }
  const expectedConfig = { ...window.config.chain, snapshot_path: snapshotPath, snapshot_sha256: report.db_sha256 };
  const chainRoot = join(root, `final-chain-${chainIdentity(expectedConfig)}`);
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(chainRoot, "prepare.json")));
  if (final.final_chain_root !== chainRoot || final.final_chain_identity !== chainIdentity(plan) ||
      canonicalJson(plan.config) !== canonicalJson(expectedConfig) || plan.queries.length !== 1 ||
      plan.queries[0]?.query_key !== window.query_key) {
    throw new AlayaError("CONFLICT", "final query plan does not bind the sealed source publication");
  }
  assertChainSnapshot(plan.config);
  verifySemanticChainQueries(plan);
  const discovery = plan.queries[0]?.status === "blocked" ? null : plan.queries[0]?.discovery_trace;
  if (canonicalJson(final.final_access) !== canonicalJson(discovery?.[0]?.access ?? null) ||
      canonicalJson(final.host.final_discovery_work) !== canonicalJson(discovery?.map(page => page.work) ?? null) ||
      canonicalJson(final.host.starting_discovery_work) !== canonicalJson(window.starting_discovery_work)) {
    throw new AlayaError("CONFLICT", "final pool receipt or host work differs from its native preparation");
  }
  return { window, final, plan };
}

/** The first native preparation page orders raw records; it is not a hidden public recall. */
export async function prepareLazyQualificationWindow(value: unknown, root: string): Promise<LazyQualificationWindow> {
  const config = LazyQualificationConfigSchema.parse(value);
  const prior = readChainArtifact(join(root, "window.json"));
  if (prior !== undefined) {
    return (await admitLazyWindow(root, config)).window;
  }
  const bound = await assertNativeBinding(config);
  const { publication, census } = bound;
  const population = config.source_population;
  const catalog = new Map(census.records.map(row => [row.source_id, row]));
  const published = new Map(publication.sources.map(row => [row.source_id, row]));
  if (catalog.size !== census.records.length || published.size !== publication.sources.length ||
      canonicalJson(census.records.map(row => ({ source_id: row.source_id, source_version: row.source_version,
        content_digest: row.content_digest, corpus_digest: row.corpus_digest }))) !==
      canonicalJson(publication.sources.map(row => ({ source_id: row.source_id, source_version: row.source_version,
        content_digest: row.content_digest, corpus_digest: row.corpus_digest })))) {
    throw new AlayaError("CONFLICT", "starting snapshot no longer matches the complete source census");
  }
  const generation = parseExtractionOpenSemanticsGeneration(population.openSemantics ?? EXTRACTION_OPEN_SEMANTICS_GENERATION);
  const starting = await prepareSourcePublicationAssociations({ ...population, openSemantics: generation },
    config.cache_owners, join(root, "starting-associations.json"));
  const query = currentQuery(config);
  if (query.identity !== config.initial_query_state_identity) {
    throw new AlayaError("CONFLICT", "query state changed after the bound initial preparation");
  }
  const initialPlan = SemanticChainPlanSchema.parse(readChainArtifact(join(config.initial_chain_root, "prepare.json")));
  const initialQuery = initialPlan.queries[0];
  if (initialPlan.queries.length !== 1 || initialQuery === undefined ||
      initialQuery.status === "blocked" || initialQuery.discovery_pages < 1 ||
      initialQuery.query_key !== query.row.line.key || initialQuery.initial_discovery_elapsed_ms === undefined) {
    throw new AlayaError("CONFLICT", "frozen lazy window requires one retained initial native preparation page");
  }
  const first = initialQuery.discovery_trace[0];
  if (first === undefined || first.access.trace.kind !== "preparation_page" || first.access.trace.source_offset !== 0) {
    throw new AlayaError("CONFLICT", "native access did not expose the first bounded raw source window");
  }
  const seen = new Set<string>();
  const window = first.access.source_candidates.slice(0, 10).map((row, index) => {
    const source = catalog.get(row.source_id), priorSource = published.get(row.source_id);
    if (source === undefined || priorSource === undefined || seen.has(row.record_id) ||
        priorSource.record_id !== row.record_id || priorSource.source_record.identity !== row.record_id ||
        priorSource.source_record.source_version !== source.source_version ||
        priorSource.source_record.content_digest !== source.content_digest) {
      throw new AlayaError("CONFLICT", "native source window is stale, repeated, or incomplete");
    }
    seen.add(row.record_id);
    return { rank: index + 1, source_id: source.source_id, source_version: source.source_version,
      content_digest: source.content_digest, corpus_digest: source.corpus_digest, record_id: row.record_id,
      question_id: source.question_id, session_id: source.session_id, session_index: source.session_index,
      round_index: source.round_index, source_observed_at: source.source_observed_at,
      roles: source.roles, speaker: source.speaker ?? null, source_record: priorSource.source_record,
      ...(row.complete ? selectedSourceState(source, config, bound.sourceOwners, starting.artifacts) : {
        key: null, cache_root: null, state: "observation_incomplete" as const,
        cache_identity: null, attempt_identity: null,
        starting_attempt_refs: [], starting_raw_refs: [], attempt_history_complete: true }) };
  });
  const selectedMissingKeys = [...new Set(window.filter(row => row.state === "cache_miss" && row.key !== null)
    .map(row => row.key!))].sort();
  const result = WindowSchema.parse({ contract: "source-semantic-lazy-qualification-window-v2", provider_calls: 0,
    config, query_key: query.row.line.key, query_state_identity: query.identity,
    starting_snapshot_sha256: publication.db_sha256,
    starting_publication_identity: chainIdentity(publication),
    source_inventory_identity: sourceInventory(publication.sources), dataset_sha256: census.dataset_sha256,
    starting_access: first.access,
    window_open: first.access.unvisited_sources || first.access.source_candidates.length < Math.min(10, first.access.observed_source_count),
    starting_discovery_work: first.work,
    starting_host_elapsed_ms: initialQuery.initial_discovery_elapsed_ms,
    starting_associations: starting.publicationAssociations, window, selected_missing_keys: selectedMissingKeys });
  writeChainArtifact(join(root, "window.json"), result);
  writeChainJson(join(root, "selected-source-keys.json"), selectedMissingKeys);
  return result;
}

/** A final publication may add associations only for the frozen source/version window. */
export async function sealLazyQualificationFinal(root: string) {
  const { window, publication: initial, census } = await admitLazyWindow(root);
  if (readChainArtifact(join(root, "final.json")) !== undefined) return (await admitLazyFinal(root)).final;
  const config = window.config;
  const population = config.source_population;
  const generation = parseExtractionOpenSemanticsGeneration(population.openSemantics ?? EXTRACTION_OPEN_SEMANTICS_GENERATION);
  const current = await prepareSourcePublicationAssociations({ ...population, openSemantics: generation },
    config.cache_owners, join(root, `final-associations-${chainIdentity(config.cache_owners)}.json`));
  const associations = current.publicationAssociations.filter(row => finalAssociationPolicy(window, row) !== "forbidden");
  const snapshotPath = join(root, "final-library.sqlite");
  const reportPath = `${snapshotPath}.publication.json`;
  const publicationStarted = performance.now();
  const report = existsSync(reportPath) ? PublicationReport.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: reportPath, maxBytes: 32 * 1024 * 1024, label: "final source publication" })))
    : await publishSourceSemanticSnapshot({ snapshotPath, dataDirRoot: join(root, "final-publication-runtime"),
      recordedAt: config.recorded_at, producerCommit: config.producer_commit,
      workspaceId: config.chain.workspace_id, runId: config.chain.run_id,
      populations: [{ ...population, cacheRoots: config.cache_owners.map(owner => owner.cacheRoot),
        publicationAssociations: associations as readonly SourcePublicationAssociation[] }] });
  if (report.snapshot_path !== snapshotPath || report.census_count !== census.records.length ||
      hashRegularFileNoFollow(snapshotPath) !== report.db_sha256 ||
      sourceInventory(report.sources.map(row => ({ ...row, record_id: row.record_id ?? "" }))) !== window.source_inventory_identity) {
    throw new AlayaError("CONFLICT", "final publication changed the complete raw source census");
  }
  const bound = new Map(associations.filter((row): row is Extract<SourcePublicationAssociation, { generation_key: string }> =>
    "generation_key" in row).map(row => [row.source_id, row]));
  for (const source of report.sources) {
    const expected = bound.get(source.source_id);
    if (source.source_interpretation_generation_key !== expected?.generation_key ||
        source.source_interpretation_binding?.request_digest !== expected?.request_digest) {
      throw new AlayaError("CONFLICT", "final publication differs from the frozen selected and warm source bindings");
    }
  }
  const publicationHostElapsedMs = performance.now() - publicationStarted;
  const finalChain = { ...config.chain, snapshot_path: snapshotPath, snapshot_sha256: report.db_sha256 };
  const chainRoot = join(root, `final-chain-${chainIdentity(finalChain)}`);
  const reprepareStarted = performance.now();
  const plan = await prepareSemanticChain(finalChain, chainRoot);
  const reprepareHostElapsedMs = performance.now() - reprepareStarted;
  const result = FinalSchema.parse({ contract: "source-semantic-lazy-qualification-final-v2", window_identity: chainIdentity(window),
    final_snapshot_path: snapshotPath, final_snapshot_sha256: report.db_sha256, publication_report_path: reportPath,
    publication_report_identity: chainIdentity(report),
    final_chain_root: chainRoot, final_chain_identity: chainIdentity(plan), provider_calls: 0,
    selected_source_count: window.window.length, selected_new_associations: associations.filter(row =>
      finalAssociationPolicy(window, row) === "selected_new").length,
    warm_outside_associations: associations.filter(row => finalAssociationPolicy(window, row) === "outside_warm").length,
    source_producer: selectedProducerAttempts(window),
    host: { starting_discovery_work: window.starting_discovery_work,
      starting_elapsed_ms: window.starting_host_elapsed_ms, publication_elapsed_ms: publicationHostElapsedMs,
      reprepare_elapsed_ms: reprepareHostElapsedMs,
      final_discovery_work: plan.queries[0]?.status === "blocked" ? null :
        plan.queries[0]?.discovery_trace.map(page => page.work) ?? null },
    final_access: plan.queries[0]?.status === "blocked" ? null : plan.queries[0]?.discovery_trace[0]?.access ?? null });
  writeChainArtifact(join(root, "final.json"), result);
  return (await admitLazyFinal(root)).final;
}

function admitFrozenExposure(window: LazyQualificationWindow, final: z.infer<typeof FinalSchema>,
  frozen: z.infer<typeof ExposureReservationSchema>) {
  if (frozen.final_identity !== chainIdentity(final) ||
      frozen.replay_path !== semanticChainReplayPath(final.final_chain_root, frozen.replay_identity)) {
    throw new AlayaError("CONFLICT", "first exposure does not bind the frozen final query");
  }
  const retained = readChainArtifact(frozen.replay_path);
  if (retained === undefined) throw new AlayaError("CONFLICT", "frozen first exposure replay is not yet durable");
  const result = ReplaySchema.parse(retained);
  if (result.identity !== frozen.replay_identity || result.arm !== "retained" ||
      result.plan_identity !== final.final_chain_identity) {
    throw new AlayaError("CONFLICT", "frozen first exposure belongs to another replay plan");
  }
  const admitted = admitSemanticChainReplay(final.final_chain_root, frozen.replay_path);
  if (admitted.replay.rows.some((row, index) => row.status !== result.rows[index]?.status)) {
    throw new AlayaError("CONFLICT", "native first exposure failed archive readmission");
  }
  const selected = new Set(window.window.map(row => row.record_id));
  const delivered = admitted.replay.rows.flatMap(row => row.status === "replayed" && row.response?.operation === "recall"
    ? row.response.index?.entries.map(entry => {
      if (entry.target.kind !== "source_evidence") throw new AlayaError("CONFLICT", "native first exposure contains a foreign entry");
      return entry.target.root_id;
    }) ?? [] : []);
  if (delivered.length > 5 || new Set(delivered).size !== delivered.length) {
    throw new AlayaError("CONFLICT", "native first exposure exceeds its five distinct source entries");
  }
  const selectedDelivered = delivered.filter(id => selected.has(id)).length;
  return { path: frozen.replay_path, result, delivery: {
    selected_delivered: selectedDelivered, selected_undelivered: selected.size - selectedDelivered,
    outside_delivered: delivered.length - selectedDelivered } };
}

/** The stage freezes a replay identity; existing replay owns native delivery and its per-row reservation. */
export async function replayLazyQualifiedFirstExposure(root: string) {
  const { window, final } = await admitLazyFinal(root);
  const path = join(root, "first-exposure.json"), reservation = join(root, "first-exposure.reserved.json");
  return withSnapshotPublishLock(path, async () => {
    const prior = readChainArtifact(path);
    if (prior !== undefined) {
      return admitRetainedLazyExposure(window, final, prior);
    }
    const frozenArtifact = readChainArtifact(reservation);
    let frozen: z.infer<typeof ExposureReservationSchema>;
    if (frozenArtifact === undefined) {
      const target = inspectSemanticChainReplayTarget(final.final_chain_root, "retained");
      frozen = ExposureReservationSchema.parse({ final_identity: chainIdentity(final),
        replay_identity: target.identity, replay_path: target.output });
      writeChainArtifact(reservation, frozen);
    } else frozen = ExposureReservationSchema.parse(frozenArtifact);
    if (frozen.final_identity !== chainIdentity(final) ||
        frozen.replay_path !== semanticChainReplayPath(final.final_chain_root, frozen.replay_identity)) {
      throw new AlayaError("CONFLICT", "first exposure reservation changed");
    }
    if (readChainArtifact(frozen.replay_path) === undefined) {
      const target = inspectSemanticChainReplayTarget(final.final_chain_root, "retained");
      if (target.identity !== frozen.replay_identity) throw new AlayaError("CONFLICT", "frozen correspondence changed before exposure recovery");
      const rowPath = target.rowPaths.get(window.query_key)!;
      if (readChainArtifact(`${rowPath}.reserved`) !== undefined && readChainArtifact(rowPath) === undefined) {
        throw new AlayaError("CONFLICT", "native first exposure may have been sent without a durable row");
      }
      await replaySemanticChain(final.final_chain_root, "retained", frozen.replay_identity);
    }
    const replay = admitFrozenExposure(window, final, frozen);
    writeChainArtifact(path, ExposureSchema.parse({ ...frozen, contract: "source-semantic-lazy-first-exposure-v2",
      replay_digest: chainIdentity(replay.result), ...replay.delivery }));
    return replay;
  });
}

function admitRetainedLazyExposure(window: LazyQualificationWindow, final: z.infer<typeof FinalSchema>, value: unknown) {
  const recorded = ExposureSchema.parse(value);
  const replay = admitFrozenExposure(window, final, recorded);
  if (recorded.replay_digest !== chainIdentity(replay.result) ||
      recorded.selected_delivered !== replay.delivery.selected_delivered ||
      recorded.selected_undelivered !== replay.delivery.selected_undelivered ||
      recorded.outside_delivered !== replay.delivery.outside_delivered) {
    throw new AlayaError("CONFLICT", "first exposure commitment differs from native replay");
  }
  return replay;
}

/** Evaluators distinguish an unreserved stage from unresolved reservations without dispatching recall. */
export async function readLazyQualifiedExposureState(root: string) {
  const { window, final } = await admitLazyFinal(root);
  const retained = readChainArtifact(join(root, "first-exposure.json"));
  if (retained === undefined) {
    const target = inspectSemanticChainReplayTarget(final.final_chain_root, "retained");
    const reservation = readChainArtifact(join(root, "first-exposure.reserved.json"));
    if (reservation !== undefined) {
      const frozen = ExposureReservationSchema.parse(reservation);
      if (frozen.final_identity !== chainIdentity(final) || frozen.replay_identity !== target.identity ||
          frozen.replay_path !== target.output) {
        throw new AlayaError("CONFLICT", "reserved first exposure differs from the sealed final stage");
      }
    }
    const rowPath = target.rowPaths.get(window.query_key)!;
    const row = readChainArtifact(rowPath), rowReservation = readChainArtifact(`${rowPath}.reserved`);
    if (rowReservation !== undefined && canonicalJson(rowReservation) !== canonicalJson({
      replay_identity: target.identity, query_key: window.query_key })) {
      throw new AlayaError("CONFLICT", "native first-exposure row reservation changed");
    }
    if (row !== undefined && rowReservation === undefined) {
      throw new AlayaError("CONFLICT", "native first-exposure row has no owning reservation");
    }
    const nativeReplay = readChainArtifact(target.output);
    return { status: reservation !== undefined || rowReservation !== undefined || nativeReplay !== undefined
      ? "reserved_unknown" as const : "unattempted" as const, path: target.output, window, final };
  }
  return { ...admitRetainedLazyExposure(window, final, retained), window, final,
    exposure: ExposureSchema.parse(retained), status: "durable" as const };
}
