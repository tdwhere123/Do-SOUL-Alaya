import { resolve, join } from "node:path";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { censusCompleteSourceRecords } from "../snapshot/source-records/census.js";
import { readRetainedSourcePublicationOwners } from "../snapshot/source-records/prepare-associations.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { parseSourceSemanticInteractivePreflight } from "../extraction/fill/source-semantic-interactive-preflight.js";
import { sourceSemanticArtifactPreparations, prepareSourceSemanticRequestLine,
  parseExtractionOpenSemanticsGeneration } from "../extraction/request-artifact.js";
import { inspectTurnContentKeySpace } from "../extraction/turn-contents.js";
import { buildOfficialApiSourceCorpus, sourceSemanticTransportUnits } from "@do-soul/alaya-soul";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact, writeChainJson } from "../semantic-chain/contract.js";
import { verifySemanticChainQueries, readSemanticChainProposalResults,
  semanticChainProposalStates } from "../semantic-chain/inputs.js";
import { LazyQualificationConfigSchema } from "../semantic-chain/lazy-qualification.js";
import { readLongMemEvalSemanticFreeze, loadFrozenLongMemEvalDataset } from "./contract.js";
import { ExperimentPreparedSchema, verifyLongMemEvalQuestionPublication,
  verifyLongMemEvalQuestionChain } from "./execute.js";

export type LongMemEvalLazyConfigInput = Readonly<{
  root: string;
  preparedPath: string;
  sourcePreflightPath: string;
  sourceCacheRoot: string;
}>;

async function readInitialQuestion(input: LongMemEvalLazyConfigInput) {
  const frozen = readLongMemEvalSemanticFreeze(input.root);
  if (frozen.contract !== "longmemeval-native-semantic-v3" || frozen.selected.length !== 1 ||
      frozen.query_workset.items.length !== 1 || frozen.config.question_ids.length !== 1) {
    throw new AlayaError("VALIDATION", "lazy LongMemEval entry requires one native semantic question");
  }
  const selected = frozen.selected[0]!;
  const prepared = ExperimentPreparedSchema.parse(readChainArtifact(input.preparedPath));
  if (prepared.contract !== "longmemeval-native-semantic-prepared-v1" ||
      prepared.freeze_identity !== chainIdentity(frozen) || prepared.rows.length !== 1 ||
      prepared.rows[0]?.question_id !== selected.question_id ||
      resolve(input.preparedPath) !== resolve(input.root, `prepared-${chainIdentity(prepared)}.json`)) {
    throw new AlayaError("CONFLICT", "initial prepared question differs from the native freeze");
  }
  const row = prepared.rows[0]!;
  if (row.status !== "prepared") throw new AlayaError("UNAVAILABLE", "initial question publication is unavailable");
  const directory = resolve(input.root, "questions", String(selected.index).padStart(5, "0"));
  if (resolve(row.publication_path) !== join(directory, "publication.json")) {
    throw new AlayaError("CONFLICT", "initial question publication belongs to another root");
  }
  const publication = verifyLongMemEvalQuestionPublication(frozen, selected, directory,
    readChainArtifact(row.publication_path));
  if (chainIdentity(publication) !== row.publication_identity ||
      publication.admitted_count !== selected.source_manifest.length ||
      publication.sources.some(source => source.admission !== "admitted" || source.record_id === undefined)) {
    throw new AlayaError("CONFLICT", "initial publication does not admit the full original source census");
  }
  verifyLongMemEvalQuestionChain(frozen, selected, directory, publication, row.chain_root);
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(row.chain_root, "prepare.json")));
  verifySemanticChainQueries(plan);
  if (plan.queries.length !== 1 || plan.queries[0]?.query_key !== selected.query_key) {
    throw new AlayaError("CONFLICT", "initial prepared query differs from the frozen original question");
  }
  if (plan.queries[0].status === "raw_ready" &&
      ["pending", "unknown"].includes(plan.queries[0].reason)) {
    throw new AlayaError("UNAVAILABLE", "query producer outcome must settle before the source window");
  }
  const sidecar: unknown = JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: `${publication.snapshot_path}.publication.json`, maxBytes: 32 * 1024 * 1024,
    label: "initial question source publication" }));
  if (chainIdentity(sidecar) !== chainIdentity(publication)) {
    throw new AlayaError("CONFLICT", "initial source publication sidecar differs from its prepared question");
  }
  const dataset = await loadFrozenLongMemEvalDataset(frozen.config);
  if (dataset.questions[selected.index]?.question_id !== selected.question_id) {
    throw new AlayaError("CONFLICT", "frozen question index changed");
  }
  const population = { name: "longmemeval_s", dataDir: frozen.config.data_dir,
    pinnedMetaRoot: frozen.config.pinned_meta_root, questionWindow: { offset: selected.index, limit: 1 } };
  const census = await censusCompleteSourceRecords({ population: population.name,
    dataDir: population.dataDir, pinnedMetaRoot: population.pinnedMetaRoot,
    questionWindow: population.questionWindow });
  const projected = census.records.map(({ source_id, source_version, content_digest, corpus_digest,
    session_id, session_index, round_index, source_observed_at, roles }) => ({ source_id, source_version,
    content_digest, corpus_digest, session_id, session_index, round_index, source_observed_at, roles }));
  if (census.dataset_sha256 !== frozen.config.dataset_sha256 ||
      canonicalJson(projected) !== canonicalJson(selected.source_manifest)) {
    throw new AlayaError("CONFLICT", "source owner differs from the complete frozen question census");
  }
  return { frozen, selected, prepared, publication, plan, dataset, census, population };
}

function readFullSourceOwner(input: LongMemEvalLazyConfigInput,
  initial: Awaited<ReturnType<typeof readInitialQuestion>>) {
  const { frozen, selected, dataset, census, population } = initial;
  if (frozen.config.source_cache_roots.length !== 1 ||
      resolve(input.sourceCacheRoot) !== resolve(frozen.config.source_cache_roots[0]!)) {
    throw new AlayaError("CONFLICT", "source owner cache root differs from the frozen question root");
  }
  const raw: unknown = JSON.parse(readBoundedCanonicalUtf8Artifact({ path: input.sourcePreflightPath,
    maxBytes: 32 * 1024 * 1024, label: "full-source Step preflight" }));
  const preflight = parseSourceSemanticInteractivePreflight(raw);
  const generation = parseExtractionOpenSemanticsGeneration(preflight.config.openSemantics);
  const sourcePopulation = { ...population, model: preflight.config.model,
    requestProfile: preflight.config.requestProfile, openSemantics: generation };
  const cacheOwners = [{ cacheRoot: resolve(input.sourceCacheRoot),
    retainedPreparationPath: resolve(input.sourcePreflightPath) }];
  const owners = readRetainedSourcePublicationOwners(cacheOwners, sourcePopulation, generation, census.dataset_sha256);
  const expectedKeys = new Set<string>();
  const expectedUnits = new Map<string, Set<string>>();
  const unsupported: typeof preflight.unsupported_sources[number][] = [];
  const occurrences = inspectTurnContentKeySpace([dataset.questions[selected.index]!], "complete-source", true)
    .occurrenceExtractionTurns;
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
      throw new AlayaError("CONFLICT", "full-source Step preflight does not own a current ready source");
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
      throw new AlayaError("CONFLICT", "retained Step preflight changed source occurrence assignments");
    }
  }
  if (preflight.dataset_revision !== census.dataset_sha256 ||
      preflight.source_occurrences !== census.records.length ||
      preflight.unsupported_source_occurrences !== unsupported.length ||
      canonicalJson(preflight.unsupported_sources) !== canonicalJson(unsupported) ||
      preflight.total_requests !== expectedKeys.size ||
      preflight.ready_requests.length !== expectedKeys.size ||
      preflight.selected_requests + preflight.cached_requests + preflight.deterministic_requests !== expectedKeys.size ||
      canonicalJson(preflight.selected_keys) !== canonicalJson([...expectedKeys].sort()) ||
      owners.owned.size !== expectedKeys.size) {
    throw new AlayaError("CONFLICT", "retained Step preflight is not the complete original source owner");
  }
  return { sourcePopulation, cacheOwners, preflight };
}

/** Binds one original question and a complete retained source owner to the existing lazy stage. */
export async function admitLongMemEvalLazyConfig(input: LongMemEvalLazyConfigInput) {
  const initial = await readInitialQuestion(input);
  const { frozen, selected, prepared, publication, plan } = initial;
  const { sourcePopulation, cacheOwners, preflight } = readFullSourceOwner(input, initial);
  const config = LazyQualificationConfigSchema.parse({ chain: plan.config,
    source_population: sourcePopulation, cache_owners: cacheOwners,
    initial_query_state_identity: chainIdentity(semanticChainProposalStates(readSemanticChainProposalResults(
      plan.config.query_workset, plan.config.query_cache_root, plan.config.max_output_tokens))),
    source_preparation: { retained_preflight_identity: chainIdentity(preflight),
      output_token_cap: preflight.max_output_tokens },
    recorded_at: frozen.config.recorded_at, producer_commit: frozen.config.producer_commit });
  return { config, freeze_identity: chainIdentity(frozen), prepared_identity: chainIdentity(prepared),
    publication_identity: chainIdentity(publication), source_preflight_identity: chainIdentity(preflight),
    source_output_token_cap: preflight.max_output_tokens, question_id: selected.question_id,
    question_index: selected.index };
}

export async function writeLongMemEvalLazyConfig(input: LongMemEvalLazyConfigInput, outputPath: string) {
  const bound = await admitLongMemEvalLazyConfig(input);
  writeChainJson(outputPath, bound.config);
  return { ...bound, path: outputPath };
}
