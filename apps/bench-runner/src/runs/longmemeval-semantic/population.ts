import { join, resolve } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { longMemEvalDatasetInputPaths } from "../../datasets/longmemeval/ingestion/fetch.js";
import { canonicalPath, canonicalPathsOverlap } from "../fs/opened-contained-path.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "../semantic-chain/contract.js";
import { admitLazyFinal, admitLazyWindow, prepareLazyQualificationWindow, replayLazyQualifiedFirstExposure,
  readLazyQualifiedExposureState, sealLazyQualificationFinal } from "../semantic-chain/lazy-qualification.js";
import { createLongMemEvalSelectionContractFromAssignments } from "../selection/contract.js";
import { LongMemEvalNativeSemanticConfigSchema, readLongMemEvalSemanticFreeze } from "./contract.js";
import { prepareLongMemEvalSemanticRun } from "./execute.js";
import { freezeLongMemEvalSemanticRun } from "./freeze.js";
import { admitLongMemEvalLazyConfig, writeLongMemEvalLazyConfig } from "./lazy-config.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const MemberSchema = z.object({
  question_id: z.string().min(1), index: z.number().int().min(0).max(499),
  dataset_cohort: z.enum(["answerable", "abstention"]),
  native_root: z.string().min(1), lazy_root: z.string().min(1), evaluator_root: z.string().min(1),
  native_config_path: z.string().min(1), source_preflight_path: z.string().min(1),
  source_cache_root: z.string().min(1), lazy_config_path: z.string().min(1),
  resource_reference: z.string().min(1), dispatch_reference: z.string().min(1).nullable(),
  execution_policy: z.enum(["eligible", "held"]),
  prior_development_exposure: z.boolean()
}).strict();
const PopulationInputSchema = z.object({
  population: z.enum(["development20", "reused_readiness50"]),
  dataset_sha256: Digest, dataset_question_count: z.literal(500),
  membership_index_path: z.string().min(1),
  experiment_policy_reference: z.string().min(1),
  exposure_reference: z.string().min(1),
  members: z.array(MemberSchema)
}).strict();
export const PopulationSchema = PopulationInputSchema.extend({
  contract: z.literal("longmemeval-lazy-population-v1"),
  population_root: z.string().min(1),
  membership_index_identity: Digest, selection: z.unknown(),
  members: z.array(MemberSchema.extend({ native_config_identity: Digest }).strict()),
  metric: z.literal("source-bearing-union-first-exposure-any-at-k-v1"),
  formal_arm: z.literal(false)
}).strict();
const IndexMapSchema = z.object({
  development20: z.array(z.object({ question_id: z.string().min(1), index: z.number().int().nonnegative() }).passthrough()),
  reused50: z.array(z.object({ question_id: z.string().min(1), index: z.number().int().nonnegative(),
    cohort: z.enum(["answerable", "abstention"]) }).passthrough()),
  provenance: z.object({ dataset: z.object({ variant: z.literal("longmemeval_s"), sha256: Digest,
    inventory_count: z.literal(500), answerable_count: z.number().int().nonnegative(),
    abstention_count: z.number().int().nonnegative() }).passthrough() }).passthrough(),
  flags: z.object({ preparation_only: z.literal(true), executable_freeze: z.literal(false),
    provider_calls: z.literal(0), benchmark_runs: z.literal(0) }).passthrough()
}).passthrough();
export type Member = z.infer<typeof MemberSchema>;
export type Population = z.infer<typeof PopulationSchema>;
export const STAGES = ["freeze", "prepare", "bind", "window", "final", "exposure"] as const;
type Stage = typeof STAGES[number];
export const StageRecordSchema = z.object({ contract: z.literal("longmemeval-lazy-population-stage-v1"),
  population_identity: Digest, question_id: z.string(), stage: z.enum(STAGES),
  state: z.enum(["requested", "completed", "failed"]),
  result_path: z.string().nullable(), result_identity: Digest.nullable(), reason: z.string().nullable()
}).strict();

function indexMap(path: string) {
  return IndexMapSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({ path,
    maxBytes: 1024 * 1024, label: "LongMemEval membership index metadata" })));
}

function assertRootIsolation(population: Population, root: string,
  configs: readonly z.infer<typeof LongMemEvalNativeSemanticConfigSchema>[]) {
  const exclusiveProducers = population.members.flatMap(member => [member.native_root, member.lazy_root]);
  const producerPaths = population.members.flatMap(member => [member.native_root, member.lazy_root,
    member.source_cache_root, member.native_config_path, member.source_preflight_path,
    member.lazy_config_path]);
  producerPaths.push(...configs.flatMap(config => {
    const dataset = longMemEvalDatasetInputPaths("longmemeval_s", {
      dataDir: config.data_dir, pinnedMetaRoot: config.pinned_meta_root });
    return [config.query_cache_root, config.correspondence_cache_root,
      config.data_dir, config.pinned_meta_root, dataset.sourcePath, dataset.checksumSource,
      ...config.source_cache_roots];
  }));
  producerPaths.push(population.membership_index_path);
  const paths = new Map([...exclusiveProducers, ...producerPaths, ...population.members.map(member => member.evaluator_root), root]
    .map(value => [value, canonicalPath(value)]));
  const overlaps = (left: string, right: string) => canonicalPathsOverlap(paths.get(left)!, paths.get(right)!);
  for (const [index, left] of exclusiveProducers.entries()) {
    if (exclusiveProducers.slice(index + 1).some(right => overlaps(left, right))) {
      throw new AlayaError("CONFLICT", "fixed population native roots overlap");
    }
  }
  if (producerPaths.some(path => overlaps(root, path))) {
    throw new AlayaError("CONFLICT", "population output root overlaps a producer or metadata path");
  }
  for (const [index, member] of population.members.entries()) {
    if (overlaps(root, member.evaluator_root) ||
        producerPaths.some(path => overlaps(path, member.evaluator_root)) ||
        population.members.slice(index + 1).some(other => overlaps(other.evaluator_root, member.evaluator_root))) {
      throw new AlayaError("CONFLICT", "population evaluator root overlaps a producer, output, or another evaluator");
    }
  }
  return producerPaths;
}

function readNativeConfig(member: Member, datasetSha256: string, datasetQuestionCount: number) {
  const config = LongMemEvalNativeSemanticConfigSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: member.native_config_path, maxBytes: 32 * 1024 * 1024, label: "single-question native config" })));
  if (config.stage !== "development" || config.dataset_sha256 !== datasetSha256 ||
      config.dataset_question_count !== datasetQuestionCount ||
      canonicalJson(config.question_ids) !== canonicalJson([member.question_id]) ||
      canonicalJson(config.previously_exposed_question_ids ?? []) !== canonicalJson(
        member.prior_development_exposure ? [member.question_id] : []) ||
      !config.source_cache_roots.some(root => resolve(root) === resolve(member.source_cache_root))) {
    throw new AlayaError("CONFLICT", "single-question native config differs from fixed population member");
  }
  return config;
}

function admitPopulation(value: unknown, root: string) {
  const population = PopulationSchema.parse(value);
  if (population.population_root !== resolve(root)) throw new AlayaError("CONFLICT", "fixed population output root changed");
  const metadata = indexMap(population.membership_index_path);
  const expected = population.population === "development20" ? metadata.development20 : metadata.reused50;
  const count = population.population === "development20" ? 20 : 50;
  const all = [...metadata.development20, ...metadata.reused50];
  if (metadata.development20.length !== 20 || metadata.reused50.length !== 50 ||
      new Set(all.map(row => row.question_id)).size !== 70 ||
      new Set(all.map(row => row.index)).size !== 70 ||
      all.some(row => row.index >= 500) ||
      metadata.provenance.dataset.sha256 !== population.dataset_sha256 ||
      metadata.provenance.dataset.answerable_count + metadata.provenance.dataset.abstention_count !== 500 ||
      population.members.length !== count ||
      population.members.some((member, i) => member.question_id !== expected[i]?.question_id ||
        member.index !== expected[i]?.index ||
        member.dataset_cohort !== "answerable" ||
        (population.population === "reused_readiness50" && member.dataset_cohort !== metadata.reused50[i]?.cohort) ||
        !member.prior_development_exposure) ||
      new Set(population.members.map(member => resolve(member.native_root))).size !== count ||
      new Set(population.members.map(member => resolve(member.lazy_root))).size !== count ||
      new Set(population.members.map(member => resolve(member.evaluator_root))).size !== count ||
      chainIdentity(metadata) !== population.membership_index_identity) {
    throw new AlayaError("CONFLICT", "fixed LongMemEval population membership or native roots changed");
  }
  const selection = createLongMemEvalSelectionContractFromAssignments({ datasetSha256: population.dataset_sha256,
    assignments: population.members.map(row => ({ question_id: row.question_id,
      dataset_cohort: row.dataset_cohort })) });
  if (canonicalJson(selection) !== canonicalJson(population.selection)) {
    throw new AlayaError("CONFLICT", "fixed LongMemEval selection contract changed");
  }
  const configs = population.members.map(member => readNativeConfig(member, population.dataset_sha256,
    population.dataset_question_count));
  const admittedInputPaths = assertRootIsolation(population, root, configs);
  for (const [index, member] of population.members.entries()) {
    if (chainIdentity(configs[index]) !== member.native_config_identity) {
      throw new AlayaError("CONFLICT", "frozen native resource or profile config changed");
    }
  }
  return { population: { ...population, selection }, admittedInputPaths };
}

/** This operation reads membership metadata only: no corpus, source, gold, or provider access. */
export function freezeLongMemEvalLazyPopulation(value: unknown, root: string) {
  const input = PopulationInputSchema.parse(value);
  const metadata = indexMap(input.membership_index_path);
  const members = input.members.map(member => ({ ...member,
    native_config_identity: chainIdentity(readNativeConfig(member, input.dataset_sha256,
      input.dataset_question_count)) }));
  const { population } = admitPopulation({ ...input, members, contract: "longmemeval-lazy-population-v1",
    population_root: resolve(root),
    membership_index_identity: chainIdentity(metadata), metric: "source-bearing-union-first-exposure-any-at-k-v1",
    formal_arm: false, selection: createLongMemEvalSelectionContractFromAssignments({
      datasetSha256: input.dataset_sha256,
      assignments: input.members.map(row => ({ question_id: row.question_id, dataset_cohort: row.dataset_cohort })) }) }, root);
  writeChainArtifact(join(root, "population.json"), population);
  return population;
}

export function readLongMemEvalLazyPopulation(root: string) {
  return readLongMemEvalLazyPopulationForObservation(root).population;
}

/** Native population admission exposes the exact member inputs used before aggregate measurement. */
export function readLongMemEvalLazyPopulationForObservation(root: string) {
  return admitPopulation(readChainArtifact(join(root, "population.json")), root);
}

function stagePath(root: string, member: Member, stage: Stage, state: "requested" | "completed" | "failed") {
  return join(root, "stages", String(member.index).padStart(5, "0"), `${stage}.${state}.json`);
}

export function stageRecord(root: string, member: Member, stage: Stage, state: "requested" | "completed" | "failed",
  populationIdentity: string) {
  const raw = readChainArtifact(stagePath(root, member, stage, state));
  if (raw === undefined) return undefined;
  const record = StageRecordSchema.parse(raw);
  if (record.population_identity !== populationIdentity || record.question_id !== member.question_id ||
      record.stage !== stage || record.state !== state) {
    throw new AlayaError("CONFLICT", "population stage belongs to another frozen member");
  }
  return record;
}

function writeStage(root: string, member: Member, stage: Stage, state: "requested" | "completed" | "failed",
  populationIdentity: string, resultPath: string | null, resultIdentity: string | null, reason: string | null) {
  const record = StageRecordSchema.parse({ contract: "longmemeval-lazy-population-stage-v1",
    population_identity: populationIdentity, question_id: member.question_id, stage, state,
    result_path: resultPath, result_identity: resultIdentity, reason });
  writeChainArtifact(stagePath(root, member, stage, state), record);
  return record;
}

function nativeConfig(member: Member, population: Population) {
  const config = readNativeConfig(member, population.dataset_sha256, population.dataset_question_count);
  if (chainIdentity(config) !== (member as Member & { native_config_identity: string }).native_config_identity) {
    throw new AlayaError("CONFLICT", "frozen native resource or profile config changed");
  }
  return config;
}

export function admitNativeFreeze(member: Member, population: Population) {
  const frozen = readLongMemEvalSemanticFreeze(member.native_root);
  if (frozen.contract !== "longmemeval-native-semantic-v3" || frozen.selected.length !== 1 ||
      frozen.selected[0]?.index !== member.index || frozen.selected[0]?.question_id !== member.question_id ||
      frozen.selected[0]?.cohort !== member.dataset_cohort ||
      frozen.config.dataset_sha256 !== population.dataset_sha256 ||
      chainIdentity(frozen.config) !== chainIdentity(nativeConfig(member, population))) {
    throw new AlayaError("CONFLICT", "native question index, cohort, or config differs from population freeze");
  }
  return frozen;
}

/** Advances exactly one named member and phase; the native owner keeps each effect and replay reservation. */
export async function runLongMemEvalLazyPopulationStage(root: string, questionId: string, stage: Stage) {
  const population = readLongMemEvalLazyPopulation(root);
  const member = population.members.find(row => row.question_id === questionId);
  if (member === undefined || !STAGES.includes(stage)) throw new AlayaError("VALIDATION", "unknown fixed population member or stage");
  if (member.execution_policy !== "eligible") throw new AlayaError("UNAVAILABLE", "member is held from execution");
  const identity = chainIdentity(population);
  const prior = stageRecord(root, member, stage, "completed", identity);
  if (prior !== undefined) {
    if (prior.result_path === null || prior.result_identity === null) throw new AlayaError("CONFLICT", "completed population stage lost native reference");
    const value = stage === "bind" ? JSON.parse(readBoundedCanonicalUtf8Artifact({ path: prior.result_path,
      maxBytes: 1024 * 1024, label: "bound lazy question config" })) : readChainArtifact(prior.result_path);
    if (value === undefined || chainIdentity(value) !== prior.result_identity) {
      throw new AlayaError("CONFLICT", "completed native stage changed before population reentry");
    }
    if (stage === "freeze") admitNativeFreeze(member, population);
    if (stage === "bind") {
      const prepared = stageRecord(root, member, "prepare", "completed", identity);
      if (prepared?.result_path === null || prepared?.result_path === undefined ||
          chainIdentity((await admitLongMemEvalLazyConfig({ root: member.native_root,
            preparedPath: prepared.result_path, sourcePreflightPath: member.source_preflight_path,
            sourceCacheRoot: member.source_cache_root })).config) !== prior.result_identity) {
        throw new AlayaError("CONFLICT", "bound lazy question changed before population reentry");
      }
    }
    if (stage === "window") await admitLazyWindow(member.lazy_root);
    if (stage === "final") await admitLazyFinal(member.lazy_root);
    if (stage === "exposure" && (await readLazyQualifiedExposureState(member.lazy_root)).status !== "durable") {
      throw new AlayaError("CONFLICT", "completed population first exposure is no longer durable");
    }
    return prior;
  }
  const previous = STAGES.indexOf(stage) - 1;
  if (previous >= 0 && stageRecord(root, member, STAGES[previous]!, "completed", identity) === undefined) {
    throw new AlayaError("UNAVAILABLE", "previous native population stage is not complete");
  }
  writeStage(root, member, stage, "requested", identity, null, null, null);
  try {
    let resultPath: string, result: unknown;
    if (stage === "freeze") {
      result = await freezeLongMemEvalSemanticRun(nativeConfig(member, population), member.native_root);
      admitNativeFreeze(member, population);
      resultPath = join(member.native_root, "freeze.json");
    } else if (stage === "prepare") {
      admitNativeFreeze(member, population);
      const prepared = await prepareLongMemEvalSemanticRun(member.native_root);
      resultPath = prepared.path; result = prepared.result;
      if (prepared.result.rows[0]?.status !== "prepared") throw new AlayaError("UNAVAILABLE", "native question preparation unavailable");
    } else if (stage === "bind") {
      const prepared = stageRecord(root, member, "prepare", "completed", identity);
      if (prepared?.result_path === null || prepared?.result_path === undefined) throw new AlayaError("CONFLICT", "prepared member path missing");
      const bound = await writeLongMemEvalLazyConfig({ root: member.native_root,
        preparedPath: prepared.result_path, sourcePreflightPath: member.source_preflight_path,
        sourceCacheRoot: member.source_cache_root }, member.lazy_config_path);
      resultPath = bound.path; result = bound.config;
    } else if (stage === "window") {
      const prepared = stageRecord(root, member, "prepare", "completed", identity)!;
      const bound = await admitLongMemEvalLazyConfig({ root: member.native_root,
        preparedPath: prepared.result_path!, sourcePreflightPath: member.source_preflight_path,
        sourceCacheRoot: member.source_cache_root });
      const window = await prepareLazyQualificationWindow(bound.config, member.lazy_root);
      resultPath = join(member.lazy_root, "window.json"); result = window;
    } else if (stage === "final") {
      result = await sealLazyQualificationFinal(member.lazy_root);
      resultPath = join(member.lazy_root, "final.json");
    } else {
      const replay = await replayLazyQualifiedFirstExposure(member.lazy_root);
      resultPath = join(member.lazy_root, "first-exposure.json");
      result = readChainArtifact(resultPath);
      if (replay.result.rows.length !== 1 || result === undefined) throw new AlayaError("CONFLICT", "first exposure did not retain one native row");
    }
    return writeStage(root, member, stage, "completed", identity, resultPath, chainIdentity(result), null);
  } catch (error) {
    if (stageRecord(root, member, stage, "failed", identity) === undefined) {
      writeStage(root, member, stage, "failed", identity, null, null,
        error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}
