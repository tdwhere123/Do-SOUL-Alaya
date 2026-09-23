import { resolve } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson, FieldContractDigestSchema,
  SourceRecordIdentitySchema } from "@do-soul/alaya-protocol";
import { buildOfficialApiSourceCorpus, sourceSemanticTransportUnits } from "@do-soul/alaya-soul";
import { loadDatasetWindowWithIdentity } from "../../datasets/longmemeval/ingestion/fetch.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { parseSourceSemanticInteractivePreflight } from "../extraction/fill/source-semantic-interactive-preflight.js";
import { parseRetainedBatchPreflight } from "../extraction/fill/batch-preflight.js";
import { parseExtractionOpenSemanticsGeneration, prepareSourceSemanticRequestLine,
  sourceSemanticArtifactPreparations } from "../extraction/request-artifact.js";
import { inspectTurnContentKeySpace } from "../extraction/turn-contents.js";
import { censusCompleteSourceRecords, type SourceCensus } from "../snapshot/source-records/census.js";
import { readRetainedSourcePublicationOwners } from "../snapshot/source-records/prepare-associations.js";
import { hashRegularFileNoFollow } from "../snapshot/bound-file.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { SemanticChainConfigSchema, SemanticChainPlanSchema, assertChainSnapshot,
  chainIdentity, readChainArtifact, writeChainJson,
  type SemanticChainPlan, type SemanticChainConfig } from "./contract.js";
import { readSemanticChainProposalResults, semanticChainProposalStates, verifySemanticChainQueries } from "./inputs.js";

export const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const SourcePopulationSchema = z.object({
  name: z.string().min(1), dataDir: z.string().min(1), pinnedMetaRoot: z.string().min(1),
  questionWindow: z.object({ offset: z.number().int().nonnegative(), limit: z.literal(1) }).strict(),
  model: z.string().min(1), requestProfile: z.string().refine(isExtractionRequestProfile),
  openSemantics: z.unknown().optional()
}).strict();
const CacheOwnerSchema = z.object({ cacheRoot: z.string().min(1), retainedPreparationPath: z.string().min(1) }).strict();
export const LazyQualificationConfigSchema = z.object({
  chain: SemanticChainConfigSchema, initial_chain_root: z.string().min(1),
  source_population: SourcePopulationSchema, cache_owners: z.array(CacheOwnerSchema).min(1),
  initial_query_state_identity: Digest,
  source_preparation: z.object({ retained_preflight_identity: Digest,
    output_token_cap: z.number().int().positive(),
    contract: z.enum(["source-semantic-interactive-preflight-v3", "extraction-batch-preflight-v2"]) }).strict(),
  recorded_at: z.string().datetime(), producer_commit: z.string().regex(/^[a-f0-9]{40}$/u)
}).strict();
export type LazyQualificationConfig = z.infer<typeof LazyQualificationConfigSchema>;
export const SourceTuple = z.object({ source_id: z.string(), source_version: z.string(), content_digest: z.string(),
  corpus_digest: z.string(), record_id: FieldContractDigestSchema }).strict();
const PublicationSource = SourceTuple.extend({ admission: z.enum(["admitted", "rejected"]),
  population: z.string(), question_id: z.string(), session_id: z.string(),
  session_index: z.number().int().nonnegative(), round_index: z.number().int().nonnegative(),
  roles: z.array(z.enum(["user", "assistant"])), speaker: z.enum(["user", "assistant", "system"]).nullable(),
  source_record: SourceRecordIdentitySchema,
  source_interpretation_generation_key: Digest.optional(),
  source_interpretation_binding: z.object({ kind: z.literal("host_publication_association"),
    request_digest: Digest }).strict().optional() }).passthrough();
export const PublicationReport = z.object({ schema_version: z.literal(3), artifact_domain: z.literal("source_semantic_publication"),
  recorded_at: z.string().datetime(), workspace_id: z.string(), run_id: z.string(),
  snapshot_path: z.string(), db_sha256: Digest, census_count: z.number().int().nonnegative(),
  admitted_count: z.number().int().nonnegative(), rejected_count: z.number().int().nonnegative(),
  sources: z.array(PublicationSource) }).passthrough();

export function readInitialPublication(chain: SemanticChainConfig) {
  const path = `${chain.snapshot_path}.publication.json`;
  const report = PublicationReport.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: 32 * 1024 * 1024, label: "starting source publication" })));
  if (report.snapshot_path !== chain.snapshot_path || report.db_sha256 !== chain.snapshot_sha256 ||
      report.workspace_id !== chain.workspace_id || report.run_id !== chain.run_id ||
      hashRegularFileNoFollow(report.snapshot_path) !== report.db_sha256 ||
      report.sources.length !== report.census_count || report.admitted_count !== report.census_count ||
      report.rejected_count !== 0 || report.sources.some(row => row.admission !== "admitted" ||
        row.record_id === undefined || row.source_record.identity !== row.record_id ||
        row.source_record.source_version !== row.source_version ||
        row.source_record.content_digest !== row.content_digest)) {
    throw new AlayaError("CONFLICT", "starting source publication differs from the complete sealed census");
  }
  return report;
}

export function assertInitialPublicationCensus(report: z.infer<typeof PublicationReport>, census: SourceCensus): void {
  const inventory = (rows: readonly (SourceCensus["records"][number] | typeof report.sources[number])[]) =>
    rows.map(row => ({ population: row.population, question_id: row.question_id,
      source_id: row.source_id, source_version: row.source_version, content_digest: row.content_digest,
      corpus_digest: row.corpus_digest, session_id: row.session_id, session_index: row.session_index,
      round_index: row.round_index, roles: row.roles, speaker: row.speaker ?? null }));
  if (census.records.length !== report.census_count ||
      canonicalJson(inventory(report.sources)) !== canonicalJson(inventory(census.records))) {
    throw new AlayaError("CONFLICT", "initial publication differs from the complete source census");
  }
}

const PopulationSchema = z.object({
  name: z.string().min(1), dataDir: z.string().min(1), pinnedMetaRoot: z.string().min(1),
  questionWindow: z.object({ offset: z.number().int().nonnegative(), limit: z.literal(1) }).strict()
}).strict();
type Population = z.infer<typeof PopulationSchema>;

export type NativeLazyBindingInput = Readonly<{
  plan: SemanticChainPlan;
  initialChainRoot: string;
  population: Population;
  sourcePreflightPath: string;
  sourceCacheRoot: string;
  recordedAt: string;
  producerCommit: string;
}>;

function readPreparedQuery(input: NativeLazyBindingInput) {
  const plan = SemanticChainPlanSchema.parse(input.plan);
  const retained = SemanticChainPlanSchema.parse(readChainArtifact(resolve(input.initialChainRoot, "prepare.json")));
  if (chainIdentity(plan) !== chainIdentity(retained)) {
    throw new AlayaError("CONFLICT", "native lazy binding differs from the retained initial preparation");
  }
  assertChainSnapshot(plan.config);
  verifySemanticChainQueries(plan);
  const query = plan.queries[0];
  if (plan.config.query_workset.items.length !== 1 || plan.queries.length !== 1 ||
      query === undefined || query.status === "blocked") {
    throw new AlayaError("VALIDATION", "lazy binding requires one prepared executable query");
  }
  if (query.status === "raw_ready" && ["pending", "unknown"].includes(query.reason)) {
    throw new AlayaError("UNAVAILABLE", "query producer outcome must settle before the source window");
  }
  return { plan, queryStateIdentity: chainIdentity(semanticChainProposalStates(readSemanticChainProposalResults(
    plan.config.query_workset, plan.config.query_cache_root, plan.config.max_output_tokens))) };
}

/** Complete-source request and occurrence ownership, independent of the question text. */
async function readCompleteSourceOwner(input: NativeLazyBindingInput, population: Population, census: SourceCensus) {
  const loaded = await loadDatasetWindowWithIdentity("longmemeval_s", {
    dataDir: population.dataDir, pinnedMetaRoot: population.pinnedMetaRoot,
    offset: population.questionWindow.offset, limit: 1 });
  if (loaded.sha256 !== census.dataset_sha256 || loaded.questions.length !== 1) {
    throw new AlayaError("CONFLICT", "source container differs from the current census");
  }
  const raw: unknown = JSON.parse(readBoundedCanonicalUtf8Artifact({ path: input.sourcePreflightPath,
    maxBytes: 32 * 1024 * 1024, label: "full-source preflight" }));
  const contract = z.object({ contract: z.string() }).passthrough().parse(raw).contract;
  const preflight = contract === "source-semantic-interactive-preflight-v3"
    ? parseSourceSemanticInteractivePreflight(raw) : parseRetainedBatchPreflight(raw);
  const readyRequests = preflight.contract === "source-semantic-interactive-preflight-v3"
    ? preflight.ready_requests : preflight.planned_requests;
  const outputTokenCap = preflight.contract === "source-semantic-interactive-preflight-v3"
    ? preflight.max_output_tokens : preflight.limits.maxOutputTokens;
  const deterministicRequests = preflight.contract === "source-semantic-interactive-preflight-v3"
    ? preflight.deterministic_requests : 0;
  if (preflight.config.sourcePacking !== "complete-source" || preflight.config.openSemantics === undefined) {
    throw new AlayaError("CONFLICT", "lazy source owner requires complete-source semantic preparation");
  }
  const generation = parseExtractionOpenSemanticsGeneration(preflight.config.openSemantics);
  if (!isExtractionRequestProfile(preflight.config.requestProfile)) {
    throw new AlayaError("VALIDATION", "source preflight has an unsupported request profile");
  }
  const sourcePopulation = { ...population, model: preflight.config.model,
    requestProfile: preflight.config.requestProfile, openSemantics: generation };
  const cacheOwners = [{ cacheRoot: resolve(input.sourceCacheRoot),
    retainedPreparationPath: resolve(input.sourcePreflightPath) }];
  const owners = readRetainedSourcePublicationOwners(cacheOwners, sourcePopulation, generation, census.dataset_sha256);
  const expectedKeys = new Set<string>();
  const expectedUnits = new Map<string, Set<string>>();
  const unsupported: unknown[] = [];
  const occurrences = inspectTurnContentKeySpace(loaded.questions, "complete-source", true).occurrenceExtractionTurns;
  if (occurrences === undefined || occurrences.length !== census.records.length) {
    throw new AlayaError("CONFLICT", "source owner occurrence inventory differs from the frozen census");
  }
  for (const [index, source] of census.records.entries()) {
    const occurrence = occurrences[index]!;
    if (buildOfficialApiSourceCorpus(occurrence.turnContent, occurrence.turnMessages) !== source.content_bytes) {
      throw new AlayaError("CONFLICT", "source owner occurrence bytes differ from the frozen census");
    }
    const preparations = sourceSemanticArtifactPreparations(source.content_bytes, "complete-source", generation);
    if (preparations.length !== 1) throw new AlayaError("CONFLICT", "complete source lost its host disposition");
    const item = preparations[0]!;
    if (item.status === "unsupported_source") {
      unsupported.push({ message_ids: occurrence.turnMessages.map(message => message.message_id), dataset_revision: census.dataset_sha256,
        ...item.disposition, provider_attempts: 0 });
      continue;
    }
    const line = prepareSourceSemanticRequestLine(item.semantic, [], sourcePopulation);
    if (owners.owned.get(line.key)?.line.requestSha256 !== line.requestSha256) {
      throw new AlayaError("CONFLICT", "full-source preflight does not own a current ready source");
    }
    const units = sourceSemanticTransportUnits(source.content_bytes,
      occurrence.turnMessages.map(message => message.message_id), census.dataset_sha256);
    const byAssertion = new Map(units.map(unit => [unit.assertionId, unit]));
    const assigned = expectedUnits.get(line.key) ?? new Set<string>();
    for (const assertion of item.semantic.source_request.source_assertions) {
      const unit = byAssertion.get(assertion.assertion_id);
      if (unit === undefined || unit.text !== assertion.text) {
        throw new AlayaError("CONFLICT", "source owner lost an original assertion occurrence");
      }
      assigned.add(unit.binding.occurrenceIdentity);
    }
    expectedUnits.set(line.key, assigned);
    expectedKeys.add(line.key);
  }
  for (const [key, units] of expectedUnits) {
    if (canonicalJson(owners.owned.get(key)?.line.unitKeys) !== canonicalJson([...units].sort())) {
      throw new AlayaError("CONFLICT", "retained source preflight changed source occurrence assignments");
    }
  }
  if (preflight.dataset_revision !== census.dataset_sha256 ||
      preflight.source_occurrences !== census.records.length ||
      preflight.unsupported_source_occurrences !== unsupported.length ||
      canonicalJson(preflight.unsupported_sources) !== canonicalJson(unsupported) ||
      preflight.total_requests !== expectedKeys.size ||
      readyRequests.length !== expectedKeys.size ||
      preflight.selected_requests + preflight.cached_requests + deterministicRequests !== expectedKeys.size ||
      canonicalJson(preflight.selected_keys) !== canonicalJson([...expectedKeys].sort()) ||
      owners.owned.size !== expectedKeys.size) {
    throw new AlayaError("CONFLICT", "retained source preflight is not the complete original source owner");
  }
  return { sourcePopulation, cacheOwners, preflight, outputTokenCap, sourceOwners: owners.owned };
}

/** Admission shared by direct native chains and dataset-specific freeze adapters. */
export async function admitNativeLazyConfig(input: NativeLazyBindingInput) {
  const population = PopulationSchema.parse(input.population);
  const { plan, queryStateIdentity } = readPreparedQuery(input);
  const publication = readInitialPublication(plan.config);
  if (publication.recorded_at !== input.recordedAt) {
    throw new AlayaError("CONFLICT", "source publication timestamp differs from the declared binding");
  }
  const census = await censusCompleteSourceRecords({ population: population.name,
    dataDir: population.dataDir, pinnedMetaRoot: population.pinnedMetaRoot,
    questionWindow: population.questionWindow });
  assertInitialPublicationCensus(publication, census);
  const { sourcePopulation, cacheOwners, preflight, outputTokenCap, sourceOwners } =
    await readCompleteSourceOwner(input, population, census);
  const config = LazyQualificationConfigSchema.parse({ chain: plan.config,
    initial_chain_root: resolve(input.initialChainRoot),
    source_population: sourcePopulation, cache_owners: cacheOwners,
    initial_query_state_identity: queryStateIdentity,
    source_preparation: { retained_preflight_identity: chainIdentity(preflight),
      output_token_cap: outputTokenCap, contract: preflight.contract },
    recorded_at: input.recordedAt, producer_commit: input.producerCommit });
  return { config, query_state_identity: queryStateIdentity,
    source_preflight_identity: chainIdentity(preflight), source_output_token_cap: outputTokenCap,
    publication_identity: chainIdentity(publication), dataset_sha256: census.dataset_sha256,
    publication, census, sourceOwners };
}

export type DirectLazyBindingInput = Omit<NativeLazyBindingInput, "plan" | "population" | "initialChainRoot"> & Readonly<{
  root: string;
  chainConfig: unknown;
  population: unknown;
}>;

export async function writeDirectLazyConfig(input: DirectLazyBindingInput, outputPath: string) {
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(resolve(input.root, "prepare.json")));
  const chain = SemanticChainConfigSchema.parse(input.chainConfig);
  if (canonicalJson(plan.config) !== canonicalJson(chain)) {
    throw new AlayaError("CONFLICT", "direct chain config differs from its native preparation");
  }
  const bound = await admitNativeLazyConfig({ ...input, plan, initialChainRoot: input.root,
    population: PopulationSchema.parse(input.population) });
  if (bound.config.source_preparation.contract !== "source-semantic-interactive-preflight-v3") {
    throw new AlayaError("VALIDATION", "direct lazy binding requires a complete current source preflight v3");
  }
  writeChainJson(outputPath, bound.config);
  const { publication: _publication, census: _census, sourceOwners: _sourceOwners, ...result } = bound;
  return { ...result, path: outputPath };
}
