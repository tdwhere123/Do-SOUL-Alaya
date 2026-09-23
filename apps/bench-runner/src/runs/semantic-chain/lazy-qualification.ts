import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson, FieldContractDigestSchema, SourceRecordIdentitySchema,
  SourceSemanticAccessReceiptSchema } from "@do-soul/alaya-protocol";
import { hashRegularFileNoFollow } from "../snapshot/bound-file.js";
import { censusCompleteSourceRecords } from "../snapshot/source-records/census.js";
import { prepareSourcePublicationAssociations, readRetainedSourcePublicationOwners,
  type SourceAssociationCacheOwner } from "../snapshot/source-records/prepare-associations.js";
import { publishSourceSemanticSnapshot, SourcePublicationAssociationRowSchema, type SourcePublicationAssociation,
  type SourcePublicationPopulation } from "../snapshot/source-records/publish.js";
import { inspectCachedSourceSemantic } from "../extraction/cache/source-semantic-artifact.js";
import { listProviderRawAttempts } from "../extraction/fill/provider-raw-attempt.js";
import { listExtractionAttemptLedgerRecords } from "../extraction/authority/attempt-ledger.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, parseExtractionOpenSemanticsGeneration,
  prepareSourceSemanticRequestLine, sourceSemanticArtifactPreparations } from "../extraction/request-artifact.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { withSnapshotPublishLock } from "../snapshot/freeze/publish-lock.js";
import { readSemanticChainProposalResults, semanticChainProposalStates, semanticChainQueryAvailability } from "./inputs.js";
import { discoverSemanticChainQuery } from "./prepare.js";
import { prepareSemanticChain } from "./prepare.js";
import { admitSemanticChainReplay, replaySemanticChain } from "./replay.js";
import { SemanticChainConfigSchema, assertChainSnapshot, chainIdentity, readChainArtifact,
  withSemanticChainDaemon, writeChainArtifact, writeChainJson } from "./contract.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const SourcePopulationSchema = z.object({
  name: z.string().min(1), dataDir: z.string().min(1), pinnedMetaRoot: z.string().min(1),
  questionWindow: z.object({ offset: z.number().int().nonnegative(), limit: z.literal(1) }).strict(),
  model: z.string().min(1), requestProfile: z.string().refine(isExtractionRequestProfile),
  openSemantics: z.unknown().optional()
}).strict();
const CacheOwnerSchema = z.object({ cacheRoot: z.string().min(1), retainedPreparationPath: z.string().min(1) }).strict();
export const LazyQualificationConfigSchema = z.object({
  chain: SemanticChainConfigSchema,
  source_population: SourcePopulationSchema,
  cache_owners: z.array(CacheOwnerSchema).min(1),
  recorded_at: z.string().datetime(), producer_commit: z.string().regex(/^[a-f0-9]{40}$/u)
}).strict();
type Config = z.infer<typeof LazyQualificationConfigSchema>;
const SourceTuple = z.object({ source_id: z.string(), source_version: z.string(), content_digest: z.string(),
  corpus_digest: z.string(), record_id: FieldContractDigestSchema }).strict();
const WindowRow = SourceTuple.extend({
  rank: z.number().int().min(1).max(10), key: Digest.nullable(), cache_root: z.string().nullable(),
  question_id: z.string(), session_id: z.string(), session_index: z.number().int().nonnegative(),
  round_index: z.number().int().nonnegative(), source_observed_at: z.string().datetime(),
  roles: z.array(z.enum(["user", "assistant"])), speaker: z.enum(["user", "assistant", "system"]).nullable(),
  source_record: SourceRecordIdentitySchema,
  state: z.enum(["unsupported_source", "unowned", "foreign_cache", "cache_hit_interpreted", "cache_hit_abstained",
    "cache_hit_empty", "cache_invalid", "cache_miss", "attempt_pending", "attempt_failed", "attempt_unknown"]),
  cache_identity: z.string().nullable(), attempt_identity: z.string().nullable(),
  starting_raw_attempts: z.number().int().nonnegative()
}).strict();
const PublicationSource = SourceTuple.extend({ admission: z.enum(["admitted", "rejected"]),
  source_record: SourceRecordIdentitySchema,
  source_interpretation_generation_key: Digest.optional(),
  source_interpretation_binding: z.object({ kind: z.literal("host_publication_association"),
    request_digest: Digest }).strict().optional() }).passthrough();
const PublicationReport = z.object({ snapshot_path: z.string(), db_sha256: Digest,
  census_count: z.number().int().nonnegative(), sources: z.array(PublicationSource) }).passthrough();
const WindowSchema = z.object({
  contract: z.literal("source-semantic-lazy-qualification-window-v1"), provider_calls: z.literal(0),
  config: LazyQualificationConfigSchema, query_key: Digest, query_state_identity: Digest,
  starting_snapshot_sha256: Digest, starting_publication_identity: Digest,
  source_inventory_identity: Digest, dataset_sha256: Digest,
  starting_access: SourceSemanticAccessReceiptSchema,
  starting_discovery_work: z.unknown(), starting_host_elapsed_ms: z.number().nonnegative(),
  starting_associations: z.array(SourcePublicationAssociationRowSchema),
  window: z.array(WindowRow).max(10), selected_missing_keys: z.array(Digest).max(10)
}).strict();
export type LazyQualificationWindow = z.infer<typeof WindowSchema>;

function sourceInventory(rows: readonly z.infer<typeof SourceTuple>[]): string {
  return chainIdentity(rows.map(({ source_id, source_version, content_digest, corpus_digest, record_id }) =>
    ({ source_id, source_version, content_digest, corpus_digest, record_id })));
}

function readInitialPublication(config: Config) {
  const path = `${config.chain.snapshot_path}.publication.json`;
  const report = PublicationReport.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: 32 * 1024 * 1024, label: "starting source publication" })));
  if (report.snapshot_path !== config.chain.snapshot_path || report.db_sha256 !== config.chain.snapshot_sha256 ||
      hashRegularFileNoFollow(report.snapshot_path) !== report.db_sha256 ||
      report.sources.length !== report.census_count || report.sources.some(row => row.admission !== "admitted")) {
    throw new AlayaError("CONFLICT", "starting source publication differs from the complete sealed census");
  }
  return report;
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
      first.source_candidates.length < Math.min(10, first.observed_source_count) ||
      new Set(window.window.map(row => row.record_id)).size !== window.window.length) {
    throw new AlayaError("CONFLICT", "frozen lazy window differs from its native source observation or publication");
  }
  for (const [index, row] of window.window.entries()) {
    const native = first.source_candidates[index];
    const source = publication.sources.find(candidate => candidate.source_id === row.source_id);
    if (native?.source_id !== row.source_id || native.record_id !== row.record_id || row.rank !== index + 1 ||
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

function selectedSourceState(source: Awaited<ReturnType<typeof censusCompleteSourceRecords>>["records"][number],
  config: Config, planned: ReturnType<typeof readRetainedSourcePublicationOwners>["planned"],
  artifacts: readonly { key: string; cache_root: string; status: string; reason?: string }[]) {
  const generation = parseExtractionOpenSemanticsGeneration(config.source_population.openSemantics ?? EXTRACTION_OPEN_SEMANTICS_GENERATION);
  const preparations = sourceSemanticArtifactPreparations(source.content_bytes, "complete-source", generation);
  if (preparations.length !== 1) throw new AlayaError("CONFLICT", "selected source has no single host preparation");
  const prepared = preparations[0]!;
  if (prepared.status === "unsupported_source") return { key: null, cache_root: null,
    state: "unsupported_source" as const, cache_identity: null, attempt_identity: null, starting_raw_attempts: 0 };
  const line = prepareSourceSemanticRequestLine(prepared.semantic, [], config.source_population);
  const owner = planned.get(line.key);
  const artifact = artifacts.find(row => row.key === line.key);
  if (owner === undefined) return { key: line.key, cache_root: null,
    state: "unowned" as const, cache_identity: null, attempt_identity: null, starting_raw_attempts: 0 };
  const cacheRoot = owner.cacheRoot;
  const cache = inspectCachedSourceSemantic(cacheRoot, line.key,
    config.source_population.model, config.source_population.requestProfile);
  const raw = listProviderRawAttempts(cacheRoot, line.key);
  const ledgers = listExtractionAttemptLedgerRecords(cacheRoot).filter(record =>
    record.pending_keys.includes(line.key) || record.unresolved_attempts.some(row => row.cache_key === line.key) ||
    record.settled_attempts?.some(row => row.cache_key === line.key) ||
    record.transport_failures.some(row => row.cache_key === line.key));
  const cacheIdentity = cache.status === "hit" ? chainIdentity(cache.admitted) : cache.status === "invalid"
    ? chainIdentity({ invalid: cache.reason }) : null;
  const attemptIdentity = raw.length + ledgers.length === 0 ? null : chainIdentity({
    raw: raw.map(row => ({ ordinal: row.attempt_ordinal, digest: row.decoded_text_digest,
      failure: row.failure_classification ?? null, finish: row.finish_reason, complete: row.full_replay_possible })),
    ledgers: ledgers.map(row => ({ lineage: row.lineage_digest, pending: row.pending_keys,
      unresolved: row.unresolved_attempts, settled: row.settled_attempts ?? [], failures: row.transport_failures }))
  });
  const state = artifact?.reason === "foreign_root" || artifact?.cache_root !== undefined && artifact.cache_root !== cacheRoot
    ? "foreign_cache"
    : artifact?.status === "invalid" || artifact?.status === "unbound" ? "cache_invalid"
    : cache.status === "hit" ? cache.admitted.outcome.status === "interpreted" ? "cache_hit_interpreted"
    : cache.admitted.outcome.status === "abstained" ? "cache_hit_abstained" : "cache_hit_empty"
    : cache.status === "invalid" ? "cache_invalid"
    : ledgers.some(row => row.pending_keys.includes(line.key) || row.unresolved_attempts.some(attempt => attempt.cache_key === line.key))
      ? "attempt_pending"
    : raw.some(row => row.transport_failure !== undefined) || ledgers.some(row => row.transport_failures.some(attempt => attempt.cache_key === line.key))
      ? "attempt_failed" : attemptIdentity !== null ? "attempt_unknown" : "cache_miss";
  return { key: line.key, cache_root: cacheRoot, state, cache_identity: cacheIdentity,
    attempt_identity: attemptIdentity, starting_raw_attempts: raw.length };
}

function selectedProducerAttempts(window: LazyQualificationWindow) {
  const selected = new Map<string, { root: string; starting: number }>();
  for (const row of window.window) {
    if (row.key === null || row.cache_root === null) continue;
    const existing = selected.get(row.key);
    if (existing !== undefined && (existing.root !== row.cache_root || existing.starting !== row.starting_raw_attempts)) {
      throw new AlayaError("CONFLICT", "duplicate selected source request has conflicting cache ownership");
    }
    selected.set(row.key, { root: row.cache_root, starting: row.starting_raw_attempts });
  }
  const added = [...selected].flatMap(([key, owner]) => {
    const all = listProviderRawAttempts(owner.root, key);
    if (all.length < owner.starting) throw new AlayaError("CONFLICT", "selected source raw attempt history shrank");
    return all.slice(owner.starting);
  });
  return { new_selected_attempts: added.length,
    reported_input_tokens: added.reduce((sum, row) => sum + (row.usage?.inputTokens ?? 0), 0),
    reported_output_tokens: added.reduce((sum, row) => sum + (row.usage?.outputTokens ?? 0), 0),
    unknown_usage_attempts: added.filter(row => !row.usage_known).length };
}

/** The first native preparation page orders raw records; it is not a hidden public recall. */
export async function prepareLazyQualificationWindow(value: unknown, root: string): Promise<LazyQualificationWindow> {
  const config = LazyQualificationConfigSchema.parse(value);
  assertChainSnapshot(config.chain);
  const prior = readChainArtifact(join(root, "window.json"));
  if (prior !== undefined) {
    const window = WindowSchema.parse(prior);
    if (canonicalJson(window.config) !== canonicalJson(config)) throw new AlayaError("CONFLICT", "lazy window config changed");
    return window;
  }
  const publication = readInitialPublication(config);
  const population = config.source_population;
  const census = await censusCompleteSourceRecords({ population: population.name, dataDir: population.dataDir,
    pinnedMetaRoot: population.pinnedMetaRoot, questionWindow: population.questionWindow });
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
  const owners = readRetainedSourcePublicationOwners(config.cache_owners as readonly SourceAssociationCacheOwner[],
    population as SourcePublicationPopulation, generation, census.dataset_sha256);
  const starting = await prepareSourcePublicationAssociations({ ...population, openSemantics: generation },
    config.cache_owners, join(root, "starting-associations.json"));
  const query = currentQuery(config);
  const availability = semanticChainQueryAvailability(query.row);
  const started = performance.now();
  const observed = await withSemanticChainDaemon(config.chain, root, async daemon => discoverSemanticChainQuery(daemon,
    { ...config.chain, discovery_page_cap: 1 }, query.row.line.original_query,
    availability.status === "admitted" ? availability.query : undefined,
    availability.status === "unavailable" && availability.unavailable !== "absent" ? availability.unavailable : undefined));
  const first = observed.discovery.discovery_trace[0];
  if (first === undefined || first.access.trace.kind !== "preparation_page" || first.access.trace.source_offset !== 0 ||
      first.access.source_candidates.length < Math.min(10, first.access.observed_source_count)) {
    throw new AlayaError("CONFLICT", "native access did not expose the first bounded raw source window");
  }
  const seen = new Set<string>();
  const window = first.access.source_candidates.slice(0, 10).map((row, index) => {
    const source = catalog.get(row.source_id), priorSource = published.get(row.source_id);
    if (source === undefined || priorSource === undefined || seen.has(row.record_id) ||
        priorSource.record_id !== row.record_id || priorSource.source_record.identity !== row.record_id ||
        priorSource.source_record.source_version !== source.source_version ||
        priorSource.source_record.content_digest !== source.content_digest || !row.complete) {
      throw new AlayaError("CONFLICT", "native source window is stale, repeated, or incomplete");
    }
    seen.add(row.record_id);
    return { rank: index + 1, source_id: source.source_id, source_version: source.source_version,
      content_digest: source.content_digest, corpus_digest: source.corpus_digest, record_id: row.record_id,
      question_id: source.question_id, session_id: source.session_id, session_index: source.session_index,
      round_index: source.round_index, source_observed_at: source.source_observed_at,
      roles: source.roles, speaker: source.speaker ?? null, source_record: priorSource.source_record,
      ...selectedSourceState(source, config, owners.planned, starting.artifacts) };
  });
  const selectedMissingKeys = [...new Set(window.filter(row => row.state === "cache_miss" && row.key !== null)
    .map(row => row.key!))].sort();
  const result = WindowSchema.parse({ contract: "source-semantic-lazy-qualification-window-v1", provider_calls: 0,
    config, query_key: query.row.line.key, query_state_identity: query.identity,
    starting_snapshot_sha256: publication.db_sha256,
    starting_publication_identity: chainIdentity(publication),
    source_inventory_identity: sourceInventory(publication.sources), dataset_sha256: census.dataset_sha256,
    starting_access: first.access, starting_discovery_work: first.work,
    starting_host_elapsed_ms: performance.now() - started,
    starting_associations: starting.publicationAssociations, window, selected_missing_keys: selectedMissingKeys });
  writeChainArtifact(join(root, "window.json"), result);
  writeChainJson(join(root, "selected-source-keys.json"), selectedMissingKeys);
  return result;
}

/** A final publication may add associations only for the frozen source/version window. */
export async function sealLazyQualificationFinal(root: string) {
  const window = WindowSchema.parse(readChainArtifact(join(root, "window.json")));
  const config = window.config;
  assertChainSnapshot(config.chain);
  const initial = readInitialPublication(config);
  assertWindowOwner(root, window, initial);
  if (currentQuery(config).identity !== window.query_state_identity ||
      initial.db_sha256 !== window.starting_snapshot_sha256) {
    throw new AlayaError("CONFLICT", "lazy qualification starting query or snapshot changed");
  }
  const population = config.source_population;
  const census = await censusCompleteSourceRecords({ population: population.name, dataDir: population.dataDir,
    pinnedMetaRoot: population.pinnedMetaRoot, questionWindow: population.questionWindow });
  const records = new Map(initial.sources.map(row => [row.source_id, row]));
  if (census.dataset_sha256 !== window.dataset_sha256 || sourceInventory(census.records.map(row => ({
    ...row, record_id: records.get(row.source_id)?.record_id ?? ""
  }))) !== window.source_inventory_identity) {
    throw new AlayaError("CONFLICT", "lazy qualification source census changed; no replacement work is authorized");
  }
  const generation = parseExtractionOpenSemanticsGeneration(population.openSemantics ?? EXTRACTION_OPEN_SEMANTICS_GENERATION);
  const current = await prepareSourcePublicationAssociations({ ...population, openSemantics: generation },
    config.cache_owners, join(root, `final-associations-${chainIdentity(config.cache_owners)}.json`));
  const selected = new Map(window.window.map(row => [row.source_id, row]));
  const warm = new Map(window.starting_associations.map(row => [row.source_id, row]));
  const associations = current.publicationAssociations.filter(row => {
    const selectedRow = selected.get(row.source_id);
    if (selectedRow !== undefined) return selectedRow.source_version === row.source_version;
    const original = warm.get(row.source_id);
    return original !== undefined && canonicalJson(original) === canonicalJson(row);
  });
  const snapshotPath = join(root, "final-library.sqlite");
  const reportPath = `${snapshotPath}.publication.json`;
  const existing = readChainArtifact(join(root, "final.json"));
  if (existing !== undefined) return existing;
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
  const result = { contract: "source-semantic-lazy-qualification-final-v1", window_identity: chainIdentity(window),
    final_snapshot_path: snapshotPath, final_snapshot_sha256: report.db_sha256, publication_report_path: reportPath,
    final_chain_root: chainRoot, final_chain_identity: chainIdentity(plan), provider_calls: 0,
    selected_source_count: window.window.length, selected_new_associations: associations.filter(row =>
      selected.has(row.source_id) && !warm.has(row.source_id)).length,
    warm_outside_associations: associations.filter(row => !selected.has(row.source_id)).length,
    source_producer: selectedProducerAttempts(window),
    host: { starting_discovery_work: window.starting_discovery_work,
      starting_elapsed_ms: window.starting_host_elapsed_ms, publication_elapsed_ms: publicationHostElapsedMs,
      reprepare_elapsed_ms: reprepareHostElapsedMs,
      final_discovery_work: plan.queries[0]?.status === "blocked" ? null :
        plan.queries[0]?.discovery_trace.map(page => page.work) ?? null },
    final_access: plan.queries[0]?.status === "blocked" ? null : plan.queries[0]?.discovery_trace[0]?.access ?? null };
  writeChainArtifact(join(root, "final.json"), result);
  return result;
}

/** Existing replay owns the immutable first-exposure reservation and native delivery. */
export async function replayLazyQualifiedFirstExposure(root: string) {
  const final = z.object({ contract: z.literal("source-semantic-lazy-qualification-final-v1"),
    final_chain_root: z.string() }).passthrough().parse(readChainArtifact(join(root, "final.json")));
  const path = join(root, "first-exposure.json");
  const reservation = join(root, "first-exposure.reserved.json");
  return withSnapshotPublishLock(path, async () => {
    const prior = readChainArtifact(path);
    if (prior !== undefined) {
      const admitted = z.object({ contract: z.literal("source-semantic-lazy-first-exposure-v1"),
        final_identity: Digest, replay_path: z.string(), replay_identity: Digest,
        selected_delivered: z.number().int().nonnegative(), selected_undelivered: z.number().int().nonnegative(),
        outside_delivered: z.number().int().nonnegative() }).strict().parse(prior);
      if (admitted.final_identity !== chainIdentity(final)) throw new AlayaError("CONFLICT", "first exposure belongs to another final library");
      const result = readChainArtifact(admitted.replay_path);
      if (result === undefined || chainIdentity(result) !== admitted.replay_identity) {
        throw new AlayaError("CONFLICT", "frozen first exposure replay changed");
      }
      return { path: admitted.replay_path, result, delivery: {
        selected_delivered: admitted.selected_delivered, selected_undelivered: admitted.selected_undelivered,
        outside_delivered: admitted.outside_delivered } };
    }
    if (readChainArtifact(reservation) !== undefined) {
      throw new AlayaError("CONFLICT", "lazy first exposure is unresolved; a second public recall is forbidden");
    }
    writeChainArtifact(reservation, { final_identity: chainIdentity(final) });
    const replay = await replaySemanticChain(final.final_chain_root, "retained");
    const admitted = admitSemanticChainReplay(final.final_chain_root, replay.path);
    const window = WindowSchema.parse(readChainArtifact(join(root, "window.json")));
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
    const delivery = { selected_delivered: selectedDelivered,
      selected_undelivered: selected.size - selectedDelivered,
      outside_delivered: delivered.length - selectedDelivered };
    writeChainArtifact(path, { contract: "source-semantic-lazy-first-exposure-v1", final_identity: chainIdentity(final),
      replay_path: replay.path, replay_identity: chainIdentity(replay.result), ...delivery });
    return { ...replay, delivery };
  });
}
