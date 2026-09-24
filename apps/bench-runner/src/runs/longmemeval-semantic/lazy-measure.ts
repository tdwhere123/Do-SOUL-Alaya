import { join, resolve } from "node:path";
import { AlayaError } from "@do-soul/alaya-protocol";
import { measureSemanticChain, semanticChainReplayInputPaths } from "../semantic-chain/replay.js";
import { readLazyQualifiedExposureState } from "../semantic-chain/lazy-qualification.js";
import { lazyQualificationRetainedInputPaths } from "../semantic-chain/lazy-qualification-inputs.js";
import { semanticProposalCacheInputPaths } from "../semantic-proposal/attempt.js";
import { retainedSourceRequestInputKeys, sourceCacheInputPaths } from "../extraction/cache/source-cache-inputs.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "../semantic-chain/contract.js";
import { classifyLongMemEvalDatasetCohort } from "../selection/dataset-cohort.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { QuestionPublicationSchema, longMemEvalQuestionInputPaths } from "./execute.js";
import { loadFrozenLongMemEvalDataset, readLongMemEvalSemanticFreeze, longMemEvalFreezePath } from "./contract.js";
import { admitLongMemEvalLazyConfig, type LongMemEvalLazyConfigInput } from "./lazy-config.js";
import { joinLongMemEvalGold } from "./measure.js";
import { longMemEvalMetricOutcome } from "./measure.js";
import { isContainedPath } from "../fs/opened-contained-path.js";
import { admitEvaluatorOutputRoot } from "../measurement/evaluator-output.js";
import { longMemEvalDatasetInputPaths } from "../../datasets/longmemeval/ingestion/fetch.js";

export type LongMemEvalLazyMeasurementInput = LongMemEvalLazyConfigInput & Readonly<{
  lazyRoot: string;
  evaluatorRoot: string;
}>;

type NativeFreeze = Extract<ReturnType<typeof readLongMemEvalSemanticFreeze>,
  { contract: "longmemeval-native-semantic-v3" }>;
type LazyExposure = Awaited<ReturnType<typeof readLazyQualifiedExposureState>>;
type BoundLazyConfig = Awaited<ReturnType<typeof admitLongMemEvalLazyConfig>>;

/** Inventory the retained producer paths before any evaluator output or gold join. */
function lazyMeasurementInputPaths(input: LongMemEvalLazyMeasurementInput,
  first: LazyExposure, bound: BoundLazyConfig, frozen: NativeFreeze): readonly string[] {
  const selected = frozen.selected[0]!;
  const questionPaths = longMemEvalQuestionInputPaths(input.root, selected.index);
  const datasetPaths = longMemEvalDatasetInputPaths("longmemeval_s", {
    dataDir: frozen.config.data_dir, pinnedMetaRoot: frozen.config.pinned_meta_root });
  const sourceKeys = [
    ...first.window.window.flatMap(row => row.key === null ? [] : [row.key]),
    ...frozen.source_caches.flatMap(cache => cache.shards.map(shard => shard.key)),
    ...frozen.config.source_publication_associations.flatMap(row => "generation_key" in row ? [row.generation_key] : []),
    ...bound.config.cache_owners.flatMap(owner => retainedSourceRequestInputKeys(owner.retainedPreparationPath)),
    ...retainedSourceRequestInputKeys(input.sourcePreflightPath)
  ];
  const sourceRoots = new Set([input.sourceCacheRoot, ...frozen.config.source_cache_roots,
    ...bound.config.cache_owners.map(owner => owner.cacheRoot)]);
  return [input.root, longMemEvalFreezePath(input.root), input.lazyRoot,
    ...lazyQualificationRetainedInputPaths(input.lazyRoot), input.preparedPath, input.sourcePreflightPath,
    bound.config.initial_chain_root, join(bound.config.initial_chain_root, "prepare.json"),
    ...semanticChainReplayInputPaths(first.final.final_chain_root, first.path, [selected.query_key]),
    first.final.final_chain_root, first.final.final_snapshot_path, first.final.publication_report_path,
    ...questionPaths.admittedInputPaths, frozen.config.data_dir, frozen.config.pinned_meta_root,
    datasetPaths.sourcePath, datasetPaths.checksumSource,
    ...semanticProposalCacheInputPaths(frozen.query_workset, frozen.config.query_cache_root, frozen.config.max_output_tokens),
    frozen.config.correspondence_cache_root,
    ...[...sourceRoots].flatMap(cacheRoot => sourceCacheInputPaths(cacheRoot, sourceKeys)),
    bound.config.chain.snapshot_path, bound.config.chain.query_cache_root, bound.config.chain.correspondence_cache_root];
}

/** Persist an unknown result without joining gold when first exposure was not durable. */
function writeUnavailableLazyMeasurement(outputRoot: string, first: LazyExposure,
  bound: BoundLazyConfig, frozen: NativeFreeze) {
  const selected = frozen.selected[0]!;
  const absenceReason = first.status === "reserved_unknown"
    ? "first_exposure_reserved_unknown" : "first_exposure_not_durable";
  const eligible = selected.cohort === "answerable" ? 1 : 0;
  const rows = frozen.inventory.map(entry => entry.question_id === selected.question_id
    ? { ...entry, selected: true, outcome: selected.cohort === "abstention" ? "uncalibrated" : "unknown",
      reason: absenceReason, measurement_path: null, mechanism: "not_exercised",
      attribution: { layer: first.status === "reserved_unknown" ? "first_exposure_unknown" : "first_exposure_unattempted", native: null } }
    : { ...entry, selected: false, outcome: "not_selected_development", reason: null,
      measurement_path: null, mechanism: "not_exercised", attribution: { layer: "not_selected", native: null } });
  const result = { contract: "longmemeval-lazy-semantic-measurement-v1", status: "development_only",
    metric: "source-bearing-union-first-exposure-any-at-k-v1", provider_calls: 0,
    freeze_identity: bound.freeze_identity, prepared_identity: bound.prepared_identity,
    window_identity: chainIdentity(first.window), final_identity: chainIdentity(first.final),
    first_exposure_identity: null, replay_identity: null,
    final_publication_identity: first.final.publication_report_identity,
    source_preflight_identity: bound.source_preflight_identity,
    question_id: selected.question_id, question_index: selected.index,
    inventory: { questions: rows.length, answerable: frozen.inventory.filter(row => row.cohort === "answerable").length,
      abstention: frozen.inventory.filter(row => row.cohort === "abstention").length },
    primary: { eligible, hits: 0, misses: 0, unknown: eligible,
      lower_bound: eligible === 0 ? null : 0, upper_bound: eligible === 0 ? null : 1 }, rows };
  const path = join(outputRoot, `lazy-measurement-${chainIdentity(result)}.json`);
  writeChainArtifact(path, result);
  return { path, result };
}

/** Trusted import may parse labels; answer-session gold joins only after durable first exposure is readmitted. */
export async function measureLongMemEvalLazyFirstExposure(input: LongMemEvalLazyMeasurementInput) {
  const first = await readLazyQualifiedExposureState(input.lazyRoot);
  const bound = await admitLongMemEvalLazyConfig(input);
  const frozen = readLongMemEvalSemanticFreeze(input.root);
  if (frozen.contract !== "longmemeval-native-semantic-v3") throw new AlayaError("CONFLICT", "native question arm changed");
  const selected = frozen.selected[0]!;
  const outputRoot = admitEvaluatorOutputRoot(input.evaluatorRoot, lazyMeasurementInputPaths(input, first, bound, frozen));
  if (chainIdentity(first.window.config) !== chainIdentity(bound.config) ||
      first.window.starting_publication_identity !== bound.publication_identity) {
    throw new AlayaError("CONFLICT", "lazy first exposure belongs to another frozen LongMemEval question");
  }
  if (first.window.query_key !== selected.query_key) {
    throw new AlayaError("CONFLICT", "lazy stage query differs from the selected original question");
  }
  if (first.status !== "durable") return writeUnavailableLazyMeasurement(outputRoot, first, bound, frozen);
  if (first.window.query_key !== selected.query_key || first.result.rows.length !== 1 ||
      first.result.rows[0]?.query_key !== selected.query_key ||
      first.final.final_snapshot_path === bound.config.chain.snapshot_path) {
    throw new AlayaError("CONFLICT", "lazy replay or final snapshot differs from the selected question");
  }
  const dataset = await loadFrozenLongMemEvalDataset(frozen.config);
  const question = dataset.questions[selected.index];
  if (question === undefined || question.question_id !== selected.question_id ||
      classifyLongMemEvalDatasetCohort(question) !== selected.cohort) {
    throw new AlayaError("CONFLICT", "frozen original question or cohort changed before gold join");
  }
  const finalPublication = QuestionPublicationSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: first.final.publication_report_path, maxBytes: 32 * 1024 * 1024,
    label: "final question source publication" })));
  if (finalPublication.snapshot_path !== first.final.final_snapshot_path ||
      finalPublication.db_sha256 !== first.final.final_snapshot_sha256 ||
      finalPublication.workspace_id !== bound.config.chain.workspace_id) {
    throw new AlayaError("CONFLICT", "gold join does not bind the sealed final question publication");
  }
  const gold = joinLongMemEvalGold(question, finalPublication, selected.source_manifest.length);
  const measured = measureSemanticChain(first.final.final_chain_root, first.path,
    [{ query_key: selected.query_key, source_units: gold.sourceUnits }], outputRoot);
  const native = measured.result.rows[0];
  if (measured.result.rows.length !== 1 || native?.query_key !== selected.query_key ||
      measured.result.replay_identity !== first.result.identity) {
    throw new AlayaError("CONFLICT", "native measurement differs from the frozen first exposure");
  }
  const metric = native.source_bearing_union?.any_at_5;
  const outcome = selected.cohort === "abstention" ? "uncalibrated" : longMemEvalMetricOutcome(metric, gold.complete);
  const reason = selected.cohort === "abstention" ? "abstention_requires_separate_calibration"
    : !gold.complete && outcome !== "hit" ? "source_or_gold_mapping_incomplete"
    : outcome === "unknown" ? native.reason ?? "native_measurement_unavailable" : null;
  const rows = frozen.inventory.map(entry => entry.question_id === selected.question_id
    ? { ...entry, selected: true, outcome, reason, measurement_path: measured.path,
      mechanism: native.mechanism.status, attribution: { layer: "lazy_native_first_exposure", native } }
    : { ...entry, selected: false, outcome: "not_selected_development" as const, reason: null,
      measurement_path: null, mechanism: "not_exercised", attribution: { layer: "not_selected", native: null } });
  const eligible = selected.cohort === "answerable" ? 1 : 0;
  const hits = outcome === "hit" ? 1 : 0, misses = outcome === "miss" ? 1 : 0;
  const result = { contract: "longmemeval-lazy-semantic-measurement-v1", status: "development_only",
    metric: "source-bearing-union-first-exposure-any-at-k-v1", provider_calls: 0,
    freeze_identity: bound.freeze_identity, prepared_identity: bound.prepared_identity,
    window_identity: chainIdentity(first.window), final_identity: chainIdentity(first.final),
    first_exposure_identity: chainIdentity(first.exposure), replay_identity: first.result.identity,
    final_publication_identity: first.final.publication_report_identity,
    source_preflight_identity: bound.source_preflight_identity,
    question_id: selected.question_id, question_index: selected.index,
    inventory: { questions: rows.length, answerable: frozen.inventory.filter(row => row.cohort === "answerable").length,
      abstention: frozen.inventory.filter(row => row.cohort === "abstention").length },
    primary: { eligible, hits, misses, unknown: eligible - hits - misses,
      lower_bound: eligible === 0 ? null : hits / eligible,
      upper_bound: eligible === 0 ? null : (eligible - misses) / eligible },
    rows };
  const path = join(outputRoot, `lazy-measurement-${chainIdentity(result)}.json`);
  writeChainArtifact(path, result);
  return { path, result };
}

/** Recomputes from the admitted first replay and gold; retained scores cannot author their own outcome. */
export async function admitLongMemEvalLazyMeasurement(input: LongMemEvalLazyMeasurementInput, path: string) {
  if (!isContainedPath(input.evaluatorRoot, path)) throw new AlayaError("CONFLICT", "lazy measurement escaped evaluator root");
  const retained = readChainArtifact(path);
  if (retained === undefined) throw new AlayaError("CONFLICT", "retained lazy measurement is missing");
  const current = await measureLongMemEvalLazyFirstExposure(input);
  if (resolve(current.path) !== resolve(path) || chainIdentity(retained) !== chainIdentity(current.result)) {
    throw new AlayaError("CONFLICT", "retained lazy measurement differs from the native first exposure and gold join");
  }
  return current;
}
