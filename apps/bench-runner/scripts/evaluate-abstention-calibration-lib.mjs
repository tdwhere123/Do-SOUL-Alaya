/** Pure helpers for evaluate-abstention-calibration.mjs (CLI entry stays thin). */

import {
  calibratedSignalName as calibratedSignalNameImpl,
  summarizeIsotonic as summarizeIsotonicImpl
} from "./evaluate-abstention-calibration-isotonic.mjs";

/** Likelihood / lexical retrieval streams counted for support features. */
export const LIKELIHOOD_STREAMS = new Set([
  "embedding_similarity",
  "lexical_fts",
  "trigram_fts",
  "evidence_fts",
  "synthesis_fts"
]);

/** Structural / graph / agreement streams counted for support features. */
export const STRUCTURAL_STREAMS = new Set([
  "structural",
  "graph_expansion",
  "path_expansion",
  "workspace_activation",
  "evidence_structural_agreement",
  "source_evidence_agreement",
  "entity_seed",
  "temporal_recency"
]);

/**
 * Fusion streams that are neither likelihood nor structural support.
 * Kept explicit so taxonomy coverage stays honest — do not fold these into
 * likelihood/structural counts without a product decision.
 */
export const OTHER_STREAMS = new Set([
  "facet_overlap",
  "source_proximity",
  "subject_alignment",
  "existing_score"
]);

export const SIGNAL_DEFINITIONS = [
  { signal: "top1_relevance_score", family: "raw_relevance", comparison_group: "raw_score" },
  { signal: "top1_fused_score", family: "raw_fused", comparison_group: "raw_score" },
  { signal: "top1_top2_relevance_margin", family: "relevance_margin", comparison_group: "margin" },
  { signal: "top1_top5_mean_relevance_margin", family: "relevance_margin", comparison_group: "margin" },
  { signal: "top1_top2_fused_margin", family: "fused_margin", comparison_group: "margin" },
  { signal: "top1_top5_mean_fused_margin", family: "fused_margin", comparison_group: "margin" },
  { signal: "abstention_confidence_score", family: "runtime_confidence", comparison_group: "runtime_confidence" },
  { signal: "likelihood_stream_support_count", family: "likelihood_support", comparison_group: "likelihood_support" },
  { signal: "structural_stream_support_count", family: "structural_support", comparison_group: "structural_support" }
];

export const SIGNALS = SIGNAL_DEFINITIONS.map((definition) => definition.signal);

/** Fused-margin signals that receive an isotonic (PAVA) calibration pass. */
export const ISOTONIC_SOURCE_SIGNALS = [
  "top1_top2_fused_margin",
  "top1_top5_mean_fused_margin",
  "abstention_confidence_score"
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAbstentionQuestionId(questionId) {
  return typeof questionId === "string" && questionId.endsWith("_abs");
}

export function readQuestions(sidecar) {
  const questions = Array.isArray(sidecar?.questions) ? sidecar.questions : null;
  if (questions === null) {
    throw new Error("diagnostics JSON does not contain a questions[] array");
  }
  return questions;
}

function scoreArray(results, key) {
  return results.map((result) => numberOrNull(result?.[key])).filter((value) => value !== null);
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function marginFeatures(results, key) {
  const values = scoreArray(results.slice(0, 5), key);
  const top1 = values[0] ?? null;
  const top2 = values[1] ?? null;
  const restMean = mean(values.slice(1));
  return {
    top1,
    top1Top2: top1 !== null && top2 !== null ? top1 - top2 : null,
    top1Top5Mean: top1 !== null && restMean !== null ? top1 - restMean : null
  };
}

function streamSupport(result) {
  const contributions = isObject(result?.fused_rank_contribution_per_stream)
    ? result.fused_rank_contribution_per_stream
    : null;
  if (contributions === null) {
    return {
      likelihood: null,
      structural: null,
      missing: ["fused_rank_contribution_per_stream"]
    };
  }
  let likelihood = 0;
  let structural = 0;
  for (const [stream, rawValue] of Object.entries(contributions)) {
    const value = numberOrNull(rawValue) ?? 0;
    if (value <= 0) continue;
    if (LIKELIHOOD_STREAMS.has(stream)) likelihood += 1;
    if (STRUCTURAL_STREAMS.has(stream)) structural += 1;
  }
  return { likelihood, structural, missing: [] };
}

function featureVector(results) {
  const relevance = marginFeatures(results, "relevance_score");
  const fused = marginFeatures(results, "fused_score");
  const support = streamSupport(results[0]);
  const confidenceScores = results
    .map((result) => numberOrNull(result?.abstention_confidence_score))
    .filter((value) => value !== null);
  // List-level confidence is identical across delivered rows when produced;
  // take the first finite value.
  const abstentionConfidence = confidenceScores[0] ?? null;
  const missing = [];
  if (relevance.top1Top2 === null) missing.push("top1_top2_relevance_margin");
  if (relevance.top1Top5Mean === null) missing.push("top1_top5_mean_relevance_margin");
  if (fused.top1 === null) missing.push("top1_fused_score");
  if (fused.top1Top2 === null) missing.push("top1_top2_fused_margin");
  if (fused.top1Top5Mean === null) missing.push("top1_top5_mean_fused_margin");
  if (abstentionConfidence === null) missing.push("abstention_confidence_score");
  missing.push(...support.missing);
  return {
    result_count: results.length,
    top1_relevance_score: relevance.top1,
    top1_top2_relevance_margin: relevance.top1Top2,
    top1_top5_mean_relevance_margin: relevance.top1Top5Mean,
    top1_fused_score: fused.top1,
    top1_top2_fused_margin: fused.top1Top2,
    top1_top5_mean_fused_margin: fused.top1Top5Mean,
    abstention_confidence_score: abstentionConfidence,
    likelihood_stream_support_count: support.likelihood,
    structural_stream_support_count: support.structural,
    premise_invalid: false,
    premise_invalid_available: false,
    missing_fields: [...new Set(missing)].sort()
  };
}

function leaveGoldOut(question) {
  const goldIds = new Set(Array.isArray(question.gold_memory_ids) ? question.gold_memory_ids : []);
  const delivered = Array.isArray(question.delivered_results) ? question.delivered_results : [];
  const hadDeliveredGold = delivered.some((result) => goldIds.has(result?.object_id));
  if (!hadDeliveredGold) {
    return null;
  }
  return delivered.filter((result) => !goldIds.has(result?.object_id));
}

export function buildExamples(questions) {
  const answerable = [];
  const syntheticNegatives = [];
  const holdoutAbstentions = [];
  let syntheticSkippedNoDeliveredGold = 0;
  for (const question of questions) {
    const questionId = String(question?.question_id ?? "");
    const delivered = Array.isArray(question?.delivered_results) ? question.delivered_results : [];
    const goldIds = Array.isArray(question?.gold_memory_ids) ? question.gold_memory_ids : [];
    if (isAbstentionQuestionId(questionId)) {
      holdoutAbstentions.push({
        question_id: questionId,
        source: "true_abstention_holdout",
        should_answer: false,
        features: featureVector(delivered)
      });
      continue;
    }
    if (goldIds.length === 0) {
      continue;
    }
    answerable.push({
      question_id: questionId,
      source: "answerable",
      should_answer: true,
      features: featureVector(delivered)
    });
    const syntheticResults = leaveGoldOut(question);
    if (syntheticResults === null) {
      syntheticSkippedNoDeliveredGold += 1;
      continue;
    }
    syntheticNegatives.push({
      question_id: questionId,
      source: "synthetic_leave_gold_out",
      should_answer: false,
      features: featureVector(syntheticResults)
    });
  }
  return {
    training: [...answerable, ...syntheticNegatives],
    answerable,
    syntheticNegatives,
    holdoutAbstentions,
    syntheticSkippedNoDeliveredGold
  };
}

function thresholdsFor(examples, signal) {
  const values = [...new Set(
    examples
      .map((example) => numberOrNull(example.features[signal]))
      .filter((value) => value !== null)
  )].sort((left, right) => left - right);
  if (values.length === 0) return [];
  const min = values[0];
  const max = values[values.length - 1];
  const epsilon = max > min ? (max - min) * 1e-6 : 1e-9;
  return [min - epsilon, ...values, max + epsilon];
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function f1(precision, recall) {
  if (precision === null || recall === null || precision + recall === 0) return null;
  return (2 * precision * recall) / (precision + recall);
}

function evaluateThreshold(examples, signal, threshold) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let missing = 0;
  for (const example of examples) {
    const value = numberOrNull(example.features[signal]);
    if (value === null) {
      missing += 1;
      continue;
    }
    const predictsAnswer = value >= threshold;
    if (predictsAnswer && example.should_answer) tp += 1;
    else if (predictsAnswer && !example.should_answer) fp += 1;
    else if (!predictsAnswer && !example.should_answer) tn += 1;
    else fn += 1;
  }
  const evaluated = tp + fp + tn + fn;
  const answerablePrecision = ratio(tp, tp + fp);
  const answerableRecall = ratio(tp, tp + fn);
  const abstentionPrecision = ratio(tn, tn + fn);
  const abstentionRecall = ratio(tn, tn + fp);
  return {
    threshold,
    evaluated,
    missing,
    tp_answerable: tp,
    fp_answerable: fp,
    tn_abstain: tn,
    fn_abstain: fn,
    accuracy: ratio(tp + tn, evaluated),
    answerable_precision: answerablePrecision,
    answerable_recall: answerableRecall,
    answerable_f1: f1(answerablePrecision, answerableRecall),
    abstention_precision: abstentionPrecision,
    abstention_recall: abstentionRecall
  };
}

export function signalDefinition(signal) {
  return SIGNAL_DEFINITIONS.find((definition) => definition.signal === signal) ?? {
    signal,
    family: "unknown",
    comparison_group: "unknown"
  };
}

function rocThresholds(values) {
  if (values.length === 0) return [];
  const unique = [...new Set(values)].sort((left, right) => right - left);
  const max = unique[0];
  const min = unique[unique.length - 1];
  const epsilon = max > min ? (max - min) * 1e-6 : 1e-9;
  return [max + epsilon, ...unique, min - epsilon];
}

function rocPoint(examples, signal, threshold) {
  let tp = 0;
  let fp = 0;
  let positives = 0;
  let negatives = 0;
  for (const example of examples) {
    const value = numberOrNull(example.features[signal]);
    if (value === null) continue;
    if (example.should_answer) positives += 1;
    else negatives += 1;
    if (value >= threshold && example.should_answer) tp += 1;
    if (value >= threshold && !example.should_answer) fp += 1;
  }
  return {
    threshold,
    true_positive_rate: ratio(tp, positives),
    false_positive_rate: ratio(fp, negatives),
    tp_answerable: tp,
    fp_true_abs: fp
  };
}

function trapezoidAuc(points) {
  let auc = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    const width = current.false_positive_rate - previous.false_positive_rate;
    const height = (current.true_positive_rate + previous.true_positive_rate) / 2;
    auc += width * height;
  }
  return auc;
}

export function summarizeRocAuc(answerable, holdout, signal) {
  const candidates = [...answerable, ...holdout];
  const usable = candidates.filter((example) => numberOrNull(example.features[signal]) !== null);
  const positives = usable.filter((example) => example.should_answer).length;
  const negatives = usable.length - positives;
  const values = usable.map((example) => numberOrNull(example.features[signal])).filter((value) => value !== null);
  if (positives === 0 || negatives === 0) {
    return {
      signal,
      positive_class: "answerable",
      negative_class: "true_abstention_holdout",
      evaluated: usable.length,
      missing: candidates.length - usable.length,
      positives,
      negatives,
      auc: null,
      auc_reason: positives === 0 ? "missing_positive_examples" : "missing_negative_examples",
      roc: []
    };
  }
  const roc = rocThresholds(values).map((threshold) => rocPoint(usable, signal, threshold));
  const auc = trapezoidAuc([...roc].sort((left, right) => left.false_positive_rate - right.false_positive_rate));
  return {
    signal,
    positive_class: "answerable",
    negative_class: "true_abstention_holdout",
    evaluated: usable.length,
    missing: candidates.length - usable.length,
    positives,
    negatives,
    auc,
    auc_reason: null,
    roc
  };
}

export function summarizeSignal(examples, holdout, signal, options = {}) {
  const thresholds = thresholdsFor(examples, signal);
  const rows = thresholds.map((threshold) => {
    const training = evaluateThreshold(examples, signal, threshold);
    const holdoutMetrics = evaluateThreshold(holdout, signal, threshold);
    return {
      ...training,
      holdout_true_abs_evaluated: holdoutMetrics.evaluated,
      holdout_true_abs_missing: holdoutMetrics.missing,
      holdout_true_abs_recall: holdoutMetrics.abstention_recall
    };
  });
  const best = [...rows].sort((left, right) => {
    const leftF1 = left.answerable_f1 ?? -1;
    const rightF1 = right.answerable_f1 ?? -1;
    if (rightF1 !== leftF1) return rightF1 - leftF1;
    const leftRecall = left.abstention_recall ?? -1;
    const rightRecall = right.abstention_recall ?? -1;
    if (rightRecall !== leftRecall) return rightRecall - leftRecall;
    return left.threshold - right.threshold;
  })[0] ?? null;
  const definition = signalDefinition(signal);
  return {
    signal,
    family: definition.family,
    comparison_group: definition.comparison_group,
    thresholds_evaluated: rows.length,
    best_by_answerable_f1: best,
    ...(options.includeSweep === true ? { sweep: rows } : {})
  };
}

export function summarizeFeatureAvailability(examples) {
  const all = [...examples.training, ...examples.holdoutAbstentions];
  const availability = {};
  for (const signal of SIGNALS) {
    const available = all.filter((example) => numberOrNull(example.features[signal]) !== null).length;
    availability[signal] = {
      available,
      missing: all.length - available,
      available_rate: ratio(available, all.length)
    };
  }
  return availability;
}

export function summarizeSignalComparison() {
  const comparison = {};
  for (const definition of SIGNAL_DEFINITIONS) {
    const group = definition.comparison_group;
    comparison[group] ??= [];
    comparison[group].push(definition.signal);
  }
  return comparison;
}

export function calibratedSignalName(signal) {
  return calibratedSignalNameImpl(signal);
}

export function summarizeIsotonic(examples) {
  return summarizeIsotonicImpl(examples, {
    sourceSignals: ISOTONIC_SOURCE_SIGNALS,
    summarizeSignal,
    summarizeRocAuc
  });
}

