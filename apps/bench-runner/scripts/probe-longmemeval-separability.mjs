#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCompleteReplayQuestion,
  loadEvidenceBundle
} from "./longmemeval-replay/contract.mjs";
import {
  deriveCandidateFeatures,
  fitFeaturePipeline,
  vectorizeSparseFeatures
} from "./longmemeval-replay/separability-features.mjs";
import { assignGroupedStratifiedFolds } from "./longmemeval-replay/separability-folds.mjs";
import { runBoundaryObjectiveLane } from "./longmemeval-replay/separability-boundary-objective.mjs";
import { isScorableMeasurementCohort } from "./longmemeval-replay/measurement-status.mjs";

const ITERATIONS = 300;
const INITIAL_LEARNING_RATE = 0.05;
const L2 = 1e-3;
const TRACKS = ["baseline", "typed_path"];

export function runSeparabilityProbe(diagnostics, options = {}) {
  const emit = createProgressEmitter(options.on_progress);
  emit({ stage: "probe_start" });
  const cohortById = indexCohort(options.cohort);
  const questions = answerableQuestions(diagnostics, cohortById);
  const assignments = assignGroupedStratifiedFolds(questions, options.fold_count ?? 5);
  const foldCount = new Set(assignments.values()).size;
  const tracks = Object.fromEntries(TRACKS.map((track) => [
    track, runTrack(questions, assignments, foldCount, track, cohortById, emit)
  ]));
  assertIdenticalQuestionSets(tracks.baseline.rows, tracks.typed_path.rows);
  const objectiveLane = runBoundaryObjectiveLane(questions, assignments, foldCount, {
    candidates: top50Candidates,
    goldIds: goldObjectIds,
    isScorable: (question) => isScorable(question, cohortById)
  }, emit);
  emit({ stage: "probe_complete" });
  return Object.freeze({
    schema_version: "longmemeval-separability.v1",
    score_semantics: "ordinal_pairwise_linear_score",
    optimizer: Object.freeze({
      initialization: "zeros", iterations: ITERATIONS,
      learning_rate: INITIAL_LEARNING_RATE, decay: "inverse_sqrt", l2: L2
    }),
    fold_count: foldCount,
    evidence_bundle_sha256: options.evidence_bundle_sha256 ?? null,
    fold_assignments: Object.freeze(questions.map((question) => Object.freeze({
      question_id: question.question_id,
      fold: assignments.get(question.question_id)
    }))),
    dataset_answerable_count: questions.length,
    runtime_scorable_count: questions.filter((question) => isScorable(question, cohortById)).length,
    runtime_scorable_coverage: ratio(
      questions.filter((question) => isScorable(question, cohortById)).length,
      questions.length
    ),
    feature_availability: summarizeFeatureAvailability(questions),
    tracks: Object.freeze(tracks),
    objective_lane: objectiveLane,
    comparison: compareTracks(tracks.baseline, tracks.typed_path)
  });
}

function runTrack(questions, assignments, foldCount, track, cohortById, emit) {
  const predictions = new Map();
  const foldModels = [];
  emit({ stage: "track_start", track });
  for (let fold = 0; fold < foldCount; fold += 1) {
    emit({ stage: "fold_start", track, fold });
    const train = questions.filter((question) =>
      assignments.get(question.question_id) !== fold && isScorable(question, cohortById)
    );
    const heldOut = questions.filter((question) =>
      assignments.get(question.question_id) === fold && isScorable(question, cohortById)
    );
    const rawRows = train.flatMap((question) => rawCandidateRows(question, track));
    if (rawRows.length === 0) throw new Error(`fold ${fold} has no scorable training candidates`);
    const pipeline = fitFeaturePipeline(rawRows.map((row) => row.features));
    const optimizer = trainPairwiseRanker(train, track, pipeline, (iteration) =>
      emit({ stage: "optimizer_progress", track, fold, iteration })
    );
    for (const question of heldOut) {
      predictions.set(question.question_id, rankQuestion(question, track, pipeline, optimizer.weights));
    }
    foldModels.push(Object.freeze({
      fold, training_question_count: train.length,
      feature_count: optimizer.weights.length, optimizer_work: optimizer.work
    }));
    emit({ stage: "fold_complete", track, fold, ...optimizer.work });
  }
  const rows = questions.map((question) => renderQuestionRow(
    question,
    predictions.get(question.question_id),
    cohortById
  ));
  const anyAt5 = rows.filter((row) => row.any_at_5 === true).length;
  const currentHits = rows.filter((row) => row.current_any_at_5).length;
  const currentScorableHits = rows.filter((row) => row.status === "scored" && row.current_any_at_5).length;
  return Object.freeze({
    track,
    rows: Object.freeze(rows),
    fold_models: Object.freeze(foldModels),
    any_at_5_count: anyAt5,
    runtime_scorable_any_at_5: ratio(anyAt5, rows.filter((row) => row.status === "scored").length),
    end_to_end_projection_any_at_5: ratio(anyAt5, rows.length),
    current_any_at_5_count: currentHits,
    current_end_to_end_any_at_5: ratio(currentHits, rows.length),
    gain_count: rows.filter((row) => row.any_at_5 === true && !row.current_any_at_5).length,
    loss_count: rows.filter((row) => row.any_at_5 === false && row.current_any_at_5).length,
    retrieval_conditional_net_gain_count: anyAt5 - currentScorableHits,
    question_type_metrics: summarizeQuestionTypes(rows)
  });
}

function trainPairwiseRanker(questions, track, pipeline, onProgress) {
  const pairs = questions.flatMap((question) => vectorPairs(question, track, pipeline));
  if (pairs.length === 0) throw new Error("pairwise ranker requires at least one gold/distractor pair");
  const weights = optimizePairwiseDifferences(pairs, pipeline.feature_names.length, onProgress);
  return Object.freeze({ weights, work: optimizerWork(pairs, weights.length) });
}

export function optimizePairwiseDifferences(pairs, featureCount, onProgress = () => {}) {
  const weights = new Float64Array(featureCount);
  const gradient = new Float64Array(weights.length);
  const stamps = new Uint16Array(weights.length);
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const touched = [];
    for (const difference of pairs) {
      const multiplier = -stableLogisticNegative(sparseDot(weights, difference));
      accumulateSparseGradient(gradient, stamps, touched, difference, multiplier, iteration + 1);
    }
    const learningRate = INITIAL_LEARNING_RATE / Math.sqrt(iteration + 1);
    for (const index of touched) {
      const averageGradient = gradient[index] / pairs.length + L2 * weights[index];
      weights[index] -= learningRate * averageGradient;
    }
    if ((iteration + 1) % 50 === 0) onProgress(iteration + 1);
  }
  return Object.freeze(Array.from(weights));
}

function vectorPairs(question, track, pipeline) {
  const goldIds = goldObjectIds(question);
  const rows = rawCandidateRows(question, track).map((row) => ({
    label: goldIds.has(row.candidate.object_id),
    vector: vectorizeSparseFeatures(row.features, pipeline)
  }));
  const positives = rows.filter((row) => row.label);
  const negatives = rows.filter((row) => !row.label);
  return positives.flatMap((positive) =>
    negatives.map((negative) => subtractSparseVectors(positive.vector, negative.vector))
  );
}

function rankQuestion(question, track, pipeline, weights) {
  const goldIds = goldObjectIds(question);
  const ranked = rawCandidateRows(question, track).map((row) => ({
    candidate: row.candidate,
    score: sparseDot(weights, vectorizeSparseFeatures(row.features, pipeline))
  })).sort(compareScoredCandidates);
  return Object.freeze({
    any_at_5: ranked.slice(0, 5).some((row) => goldIds.has(row.candidate.object_id)),
    top_5_candidate_keys: Object.freeze(ranked.slice(0, 5).map((row) => stableCandidateKey(row.candidate)))
  });
}

function rawCandidateRows(question, track) {
  return top50Candidates(question).map((candidate) => Object.freeze({
    candidate,
    features: deriveCandidateFeatures(question, candidate, track)
  }));
}

function renderQuestionRow(question, prediction, cohortById) {
  if (!isScorable(question, cohortById)) {
    return Object.freeze({
      question_id: question.question_id,
      question_type: question.question_type ?? null,
      status: "unscorable",
      unscorable_reason: unscorableReason(question),
      current_any_at_5: question.hit_at_5 === true,
      any_at_5: null,
      top_5_candidate_keys: Object.freeze([])
    });
  }
  if (prediction === undefined) throw new Error(`missing OOF prediction: ${question.question_id}`);
  return Object.freeze({
    question_id: question.question_id,
    question_type: question.question_type ?? null,
    status: "scored",
    unscorable_reason: null,
    current_any_at_5: question.hit_at_5 === true,
    ...prediction
  });
}

function compareTracks(baseline, typedPath) {
  const baselineById = new Map(baseline.rows.map((row) => [row.question_id, row]));
  const uniqueGains = typedPath.rows.filter((row) =>
    row.any_at_5 === true && baselineById.get(row.question_id)?.any_at_5 === false
  );
  const uniqueLosses = typedPath.rows.filter((row) =>
    row.any_at_5 === false && baselineById.get(row.question_id)?.any_at_5 === true
  );
  return Object.freeze({
    baseline_gain_count: baseline.gain_count,
    baseline_loss_count: baseline.loss_count,
    typed_path_unique_gain_count: uniqueGains.length,
    typed_path_unique_loss_count: uniqueLosses.length,
    typed_path_unique_gain_question_ids: Object.freeze(uniqueGains.map((row) => row.question_id)),
    typed_path_unique_loss_question_ids: Object.freeze(uniqueLosses.map((row) => row.question_id))
  });
}

function summarizeQuestionTypes(rows) {
  const types = [...new Set(rows.map((row) => row.question_type ?? "unknown"))].sort();
  return Object.freeze(types.map((type) => {
    const members = rows.filter((row) => (row.question_type ?? "unknown") === type);
    const scored = members.filter((row) => row.status === "scored");
    return Object.freeze({
      question_type: type,
      dataset_answerable_count: members.length,
      runtime_scorable_count: scored.length,
      any_at_5_count: scored.filter((row) => row.any_at_5 === true).length,
      gain_count: scored.filter((row) => row.any_at_5 === true && !row.current_any_at_5).length,
      loss_count: scored.filter((row) => row.any_at_5 === false && row.current_any_at_5).length
    });
  }));
}

function answerableQuestions(diagnostics, cohortById) {
  if (diagnostics === null || typeof diagnostics !== "object" || !Array.isArray(diagnostics.questions)) {
    throw new Error("diagnostics.questions is required");
  }
  const questions = diagnostics.questions.filter((question) =>
    question !== null && typeof question === "object" &&
    question.is_abstention !== true && question.premise_invalid !== true &&
    !String(question.question_id ?? "").includes("_abs") &&
    (cohortById === null || cohortById.get(question.question_id)?.dataset_cohort === "answerable")
  );
  if (questions.length === 0) throw new Error("separability requires answerable questions");
  return [...questions].sort((left, right) => left.question_id.localeCompare(right.question_id));
}

function isScorable(question, cohortById = null) {
  if (question.candidate_pool_complete !== true) return false;
  if (cohortById !== null) {
    const row = cohortById.get(question.question_id);
    if (row?.candidate_pool_complete !== true) return false;
    if (!isScorableMeasurementCohort(row)) return false;
    assertCompleteReplayQuestion(question, row);
  }
  return goldObjectIds(question).size > 0 && top50Candidates(question).length > 1 &&
    top50Candidates(question).some((candidate) => goldObjectIds(question).has(candidate.object_id)) &&
    top50Candidates(question).some((candidate) => !goldObjectIds(question).has(candidate.object_id));
}

function unscorableReason(question) {
  if (question.candidate_pool_complete !== true) return "candidate_pool_incomplete";
  if (goldObjectIds(question).size === 0) return "runtime_gold_absent";
  if (top50Candidates(question).length <= 1) return "insufficient_candidate_pool";
  if (!top50Candidates(question).some((candidate) => goldObjectIds(question).has(candidate.object_id))) return "gold_outside_top_50";
  return "no_distractor_in_top_50";
}

function top50Candidates(question) {
  if (!Array.isArray(question.candidates)) return [];
  return question.candidates.filter((candidate) => candidate !== null && typeof candidate === "object")
    .filter((candidate) => positiveRank(candidate.fused_rank) <= 50);
}

function summarizeFeatureAvailability(questions) {
  const candidates = questions.flatMap(top50Candidates);
  const emptyQueryProbes = countEmpty(questions, (row) => row.query_probes);
  const emptySoughtFacets = countEmpty(questions, (row) => row.query_sought_facets);
  const emptyAnswerFeatures = countEmpty(candidates, candidateAnswerFeatures);
  const emptyDirectPathFeatures = countEmpty(candidates, candidatePathFeatures);
  const emptyPathEdgeTraces = countEmpty(candidates, (row) =>
    object(row.flood_potential).edge_traces
  );
  return Object.freeze({
    questions: Object.freeze({
      total: questions.length,
      empty_query_probes: emptyQueryProbes,
      empty_query_probes_rate: ratio(emptyQueryProbes, questions.length),
      empty_sought_facets: emptySoughtFacets,
      empty_sought_facets_rate: ratio(emptySoughtFacets, questions.length)
    }),
    candidates: Object.freeze({
      total: candidates.length,
      empty_answer_features: emptyAnswerFeatures,
      empty_answer_features_rate: ratio(emptyAnswerFeatures, candidates.length),
      empty_direct_path_features: emptyDirectPathFeatures,
      empty_direct_path_features_rate: ratio(emptyDirectPathFeatures, candidates.length),
      empty_path_edge_traces: emptyPathEdgeTraces,
      empty_path_edge_traces_rate: ratio(emptyPathEdgeTraces, candidates.length)
    })
  });
}

function candidateAnswerFeatures(candidate) {
  return {
    ...object(object(candidate.score_factors).answer_features),
    ...object(candidate.answer_features)
  };
}

function candidatePathFeatures(candidate) {
  return {
    ...object(object(candidate.score_factors).path_features),
    ...object(candidate.path_features)
  };
}

function countEmpty(rows, select) {
  return rows.filter((row) => !hasFeatureValue(select(row))).length;
}

function hasFeatureValue(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasFeatureValue);
  return Object.values(object(value)).some(hasFeatureValue);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function goldObjectIds(question) {
  const gold = Array.isArray(question.gold) ? question.gold : [];
  return new Set(gold.flatMap((row) =>
    row !== null && typeof row === "object" && typeof row.object_id === "string" ? [row.object_id] : []
  ));
}

function compareScoredCandidates(left, right) {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) return scoreDelta;
  const leftRank = positiveRank(left.candidate.fused_rank);
  const rightRank = positiveRank(right.candidate.fused_rank);
  if (leftRank !== rightRank) return leftRank - rightRank;
  return stableCandidateKey(left.candidate).localeCompare(stableCandidateKey(right.candidate));
}

function stableCandidateKey(candidate) {
  if (typeof candidate.candidate_key === "string" && candidate.candidate_key.length > 0) return candidate.candidate_key;
  if (typeof candidate.object_id === "string" && candidate.object_id.length > 0) return candidate.object_id;
  throw new Error("candidate_key or object_id is required for deterministic ties");
}

function assertIdenticalQuestionSets(left, right) {
  const leftIds = left.map((row) => row.question_id).join("\0");
  const rightIds = right.map((row) => row.question_id).join("\0");
  if (leftIds !== rightIds) throw new Error("separability tracks evaluated different question sets");
}

function stableLogisticNegative(score) {
  if (score >= 0) {
    const exp = Math.exp(-score);
    return exp / (1 + exp);
  }
  return 1 / (1 + Math.exp(score));
}

function subtractSparseVectors(left, right) {
  const difference = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftEntry = left[leftIndex];
    const rightEntry = right[rightIndex];
    if (rightEntry === undefined || (leftEntry !== undefined && leftEntry[0] < rightEntry[0])) {
      difference.push(leftEntry); leftIndex += 1;
    } else if (leftEntry === undefined || rightEntry[0] < leftEntry[0]) {
      difference.push([rightEntry[0], -rightEntry[1]]); rightIndex += 1;
    } else {
      const value = leftEntry[1] - rightEntry[1];
      if (value !== 0) difference.push([leftEntry[0], value]);
      leftIndex += 1; rightIndex += 1;
    }
  }
  return Object.freeze(difference);
}

function sparseDot(weights, entries) {
  let sum = 0;
  for (const [index, value] of entries) sum += weights[index] * value;
  return sum;
}

function accumulateSparseGradient(gradient, stamps, touched, entries, multiplier, stamp) {
  for (const [index, value] of entries) {
    if (stamps[index] !== stamp) {
      stamps[index] = stamp;
      gradient[index] = 0;
      touched.push(index);
    }
    gradient[index] += multiplier * value;
  }
}

function optimizerWork(pairs, featureCount) {
  const pairTerms = pairs.reduce((sum, pair) => sum + pair.length, 0);
  const activeIndexes = new Set();
  for (const pair of pairs) for (const [index] of pair) activeIndexes.add(index);
  const activeFeatures = activeIndexes.size;
  const sparseTermVisits = ITERATIONS * (pairTerms * 2 + activeFeatures);
  const denseTermVisits = ITERATIONS * (pairs.length * featureCount * 2 + featureCount);
  return Object.freeze({
    pair_count: pairs.length,
    sparse_term_visits: sparseTermVisits,
    dense_equivalent_term_visits: denseTermVisits
  });
}

function createProgressEmitter(listener) {
  const startedAt = performance.now();
  return (event) => {
    if (typeof listener !== "function") return;
    listener(Object.freeze({ ...event, elapsed_ms: Math.round((performance.now() - startedAt) * 100) / 100 }));
  };
}

function positiveRank(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function indexCohort(cohort) {
  if (cohort === undefined) return null;
  if (cohort === null || typeof cohort !== "object" || !Array.isArray(cohort.rows)) {
    throw new Error("cohort.rows is required when cohort is supplied");
  }
  return new Map(cohort.rows.map((row) => [row.question_id, row]));
}

export function parseArgs(argv) {
  const args = { manifest: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--manifest") args.manifest = argv[++index] ?? null;
    else if (argv[index] === "--output") args.output = argv[++index] ?? null;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (args.manifest === null) {
    throw new Error(
      "Usage: probe-longmemeval-separability.mjs --manifest <evidence-manifest.json> [--output <file>]"
    );
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundle = await loadEvidenceBundle(args.manifest);
  const report = runSeparabilityProbe(bundle.diagnostics, {
    cohort: bundle.cohort,
    evidence_bundle_sha256: bundle.manifest.bundle_sha256,
    on_progress: renderProgress
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output === null) process.stdout.write(output);
  else await writeFile(args.output, output, "utf8");
}

function renderProgress(event) {
  const fields = [event.track, event.fold === undefined ? null : `fold=${event.fold}`,
    event.iteration === undefined ? null : `iteration=${event.iteration}`]
    .filter((value) => value !== null).join(" ");
  console.error(`[separability] ${event.stage}${fields === "" ? "" : ` ${fields}`} elapsed_ms=${event.elapsed_ms}`);
}

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
