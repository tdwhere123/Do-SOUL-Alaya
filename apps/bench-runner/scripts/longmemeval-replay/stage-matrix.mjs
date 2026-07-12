import { isDeepStrictEqual } from "node:util";

import {
  assertCompleteReplayQuestion,
  consumeReplayContract,
  STAGE_FIELDS,
  STAGE_ORDER,
  validateEvidenceBundle
} from "./contract.mjs";
import {
  isScorableMeasurementCohort,
  measurementUnscorableReason
} from "./measurement-status.mjs";

export const CEILING_KS = Object.freeze([5, 10, 25, 50, 100]);

export function buildStageMatrix(rawContract) {
  const contract = validateEvidenceBundle(rawContract);
  const rows = new Map(contract.cohort.rows.map((row) => [row.question_id, row]));
  const diagnostics = new Map(contract.diagnostics.questions.map((question) => [
    question.question_id, question
  ]));
  const allQuestions = contract.cohort.rows.map((row) =>
    diagnostics.get(row.question_id) ?? cohortOnlyQuestion(row)
  );
  const answerable = allQuestions.filter((question) =>
    rows.get(question.question_id).dataset_cohort === "answerable"
  );
  const questions = answerable.map((question) => buildQuestionRow(question, rows.get(question.question_id)));
  return {
    schema_version: 1,
    kind: "longmemeval_stage_matrix",
    run_slug: contract.manifest?.run?.slug ?? null,
    stage_order: [...STAGE_ORDER],
    stage_rank_fields: { ...STAGE_FIELDS },
    ceiling_ks: [...CEILING_KS],
    questions,
    summary: summarize(questions, allQuestions, rows)
  };
}

export async function loadStageMatrix(manifestPath) {
  const questions = [];
  const axesById = new Map();
  const contract = await consumeReplayContract(manifestPath, {
    requireComplete: true,
    onQuestion(question, cohort) {
      axesById.set(question.question_id, readQualityAxes(question, cohort));
      if (cohort.dataset_cohort === "answerable") {
        questions.push(buildQuestionRow(question, cohort));
      }
    }
  });
  const rows = new Map(contract.cohort.rows.map((row) => [row.question_id, row]));
  const allQuestions = contract.cohort.rows.map((row) => ({
    question_id: row.question_id,
    quality_axes: axesById.get(row.question_id) ?? row.quality_axes ?? null
  }));
  return assembleStageMatrix(contract.manifest, questions, allQuestions, rows);
}

function assembleStageMatrix(manifest, questions, allQuestions, rows) {
  return {
    schema_version: 1,
    kind: "longmemeval_stage_matrix",
    run_slug: manifest?.run?.slug ?? null,
    stage_order: [...STAGE_ORDER],
    stage_rank_fields: { ...STAGE_FIELDS },
    ceiling_ks: [...CEILING_KS],
    questions,
    summary: summarize(questions, allQuestions, rows)
  };
}

function cohortOnlyQuestion(row) {
  return {
    question_id: row.question_id,
    question_type: null,
    candidate_pool_complete: false,
    candidates: [],
    quality_axes: row.quality_axes
  };
}

export function renderStageMatrix(matrix) {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

function buildQuestionRow(question, cohort) {
  const goldIds = cohort.evaluator_gold_identity?.object_ids ?? [];
  const poolComplete = question.candidate_pool_complete === true &&
    cohort.candidate_pool_complete === true;
  if (poolComplete) assertCompleteReplayQuestion(question, cohort);
  const scorable = poolComplete && isScorableMeasurementCohort(cohort);
  const bestRanks = Object.fromEntries(STAGE_ORDER.map((stage) => [
    stage,
    scorable ? bestGoldRank(question.candidates, goldIds, STAGE_FIELDS[stage]) : null
  ]));
  const anyGoldAtK = Object.fromEntries(STAGE_ORDER.map((stage) => [
    stage,
    Object.fromEntries(CEILING_KS.map((k) => [
      k,
      scorable ? bestRanks[stage] !== null && bestRanks[stage] <= k : null
    ]))
  ]));
  const finalHit = anyGoldAtK.final_rank[5];
  const failure = scorable && !finalHit ? classifyFailures(anyGoldAtK) : null;
  const unscorableReason = scorable
    ? null
    : cohort.evaluation_issue_reason ??
      (poolComplete
        ? measurementUnscorableReason(cohort)
        : "incomplete_candidate_pool");
  const qualityAxes = readQualityAxes(question, cohort);
  return {
    question_id: question.question_id,
    question_type: question.question_type ?? null,
    extraction_materialization: cohort.extraction_materialization,
    evaluator_gold_identity: cohort.evaluator_gold_identity,
    candidate_pool_complete: poolComplete,
    phase_latency_ms: question.phase_latency_ms ?? null,
    quality_axes: qualityAxes,
    classification: !scorable ? "unscorable" : finalHit ? "final_hit" : "ranked_miss",
    unscorable_reason: unscorableReason,
    first_failure: failure?.firstFailure ?? null,
    terminal_loss: failure?.terminalLoss ?? null,
    best_gold_rank: bestRanks,
    any_gold_at_k: anyGoldAtK,
    fused_margin: scorable ? buildFusedMargin(question.candidates, goldIds) : null
  };
}

function bestGoldRank(candidates, goldIds, field) {
  const gold = new Set(goldIds);
  const ranks = candidates
    .filter((candidate) => gold.has(candidate.object_id) && candidate[field] !== null)
    .map((candidate) => candidate[field]);
  return ranks.length === 0 ? null : Math.min(...ranks);
}

function classifyFailures(anyGoldAtK) {
  const hits = STAGE_ORDER.map((stage) => anyGoldAtK[stage][5]);
  let firstFailure = hits[0] ? null : STAGE_ORDER[0];
  let terminalLoss = null;
  for (let index = 1; index < hits.length; index += 1) {
    if (hits[index - 1] && !hits[index]) {
      firstFailure ??= STAGE_ORDER[index];
      terminalLoss = STAGE_ORDER[index];
    }
  }
  return { firstFailure: firstFailure ?? "final_rank", terminalLoss };
}

function buildFusedMargin(candidates, goldIds) {
  const gold = new Set(goldIds);
  const bestGold = [...candidates]
    .filter((candidate) => gold.has(candidate.object_id) && candidate.rank_after_fusion !== null)
    .sort(compareFusionContext)[0] ?? null;
  const rankFive = [...candidates]
    .filter((candidate) => candidate.rank_after_fusion === 5)
    .sort((left, right) => left.object_id.localeCompare(right.object_id))[0] ?? null;
  if (bestGold === null || rankFive === null) return null;
  const goldContext = fusionContext(bestGold);
  const fifthContext = fusionContext(rankFive);
  const margin = typeof bestGold.fused_score === "number" && typeof rankFive.fused_score === "number"
    ? round(bestGold.fused_score - rankFive.fused_score)
    : null;
  return { gold: goldContext, rank_five: fifthContext, gold_minus_rank_five: margin };
}

function compareFusionContext(left, right) {
  return left.rank_after_fusion - right.rank_after_fusion ||
    left.object_id.localeCompare(right.object_id);
}

function fusionContext(candidate) {
  const facet = candidate.score_factors?.facet_overlap;
  return {
    object_id: candidate.object_id,
    rank: candidate.rank_after_fusion,
    fused_score: typeof candidate.fused_score === "number" ? candidate.fused_score : null,
    facet_overlap: typeof facet === "number" ? facet : null
  };
}

function round(value) {
  return Number(value.toFixed(12));
}

function summarize(questions, allQuestions, rows) {
  const scorable = questions.filter((question) => question.classification !== "unscorable");
  const unscorable = questions.filter((question) => question.classification === "unscorable");
  const byStage = Object.fromEntries(STAGE_ORDER.map((stage) => [
    stage,
    stageSummary(scorable, stage)
  ]));
  const transitions = Object.fromEntries(STAGE_ORDER.map((stage, index) => [
    stage,
    index === 0 ? { gains: 0, losses: 0 } : transitionSummary(scorable, index)
  ]));
  const nonAnswerable = allQuestions
    .map((question) => ({ id: question.question_id, cohort: rows.get(question.question_id).dataset_cohort }))
    .filter((entry) => entry.cohort !== "answerable");
  return {
    source_questions: allQuestions.length,
    dataset_answerable: questions.length,
    scorable_answerable: scorable.length,
    unscorable_answerable: unscorable.length,
    excluded_non_answerable: nonAnswerable.length,
    excluded_non_answerable_question_ids: nonAnswerable.map((entry) => entry.id),
    ranked_misses: questions.filter((question) => question.classification === "ranked_miss").length,
    classified_answerable_misses: questions.filter((question) =>
      question.classification !== "final_hit" &&
      (question.first_failure !== null || question.unscorable_reason !== null)
    ).length,
    quality_axes: summarizeQualityAxes(questions, allQuestions, rows),
    by_stage: byStage,
    transitions
  };
}

function readQualityAxes(question, cohort) {
  const diagnosticAxes = question.quality_axes ?? null;
  const cohortAxes = cohort.quality_axes ?? null;
  if (diagnosticAxes !== null && cohortAxes !== null &&
      !isDeepStrictEqual(diagnosticAxes, cohortAxes)) {
    throw new Error(`quality_axes drift between diagnostics and cohort for ${question.question_id}`);
  }
  return diagnosticAxes ?? cohortAxes;
}

function summarizeQualityAxes(answerable, allQuestions, rows) {
  const measuredAnswerable = answerable.filter((question) => question.quality_axes !== null);
  const abstention = allQuestions.filter((question) =>
    rows.get(question.question_id).dataset_cohort === "abstention"
  );
  const measuredAbstention = abstention
    .map((question) => readQualityAxes(question, rows.get(question.question_id)))
    .filter((axes) => axes?.abstention?.applicable === true);
  return {
    answerable: summarizeAnswerableAxes(measuredAnswerable),
    abstention: summarizeAbstentionAxes(measuredAbstention)
  };
}

function summarizeAnswerableAxes(questions) {
  const axes = questions.map((question) => question.quality_axes);
  const coverage = axes.map((item) => item.answer_session_coverage_at_5)
    .filter((item) => item.applicable);
  const literal = axes.map((item) => item.answer_literal_witness_lower_bound_at_5)
    .filter((item) => item.applicable);
  const timestamps = axes.map((item) => item.source_timestamp_availability_at_5);
  return {
    measured_question_count: questions.length,
    answer_session_coverage_at_5: summarizeSessionCoverage(coverage),
    answer_literal_witness_lower_bound_at_5: summarizeLiteralWitnesses(literal),
    source_timestamp_availability_at_5: summarizeTimestampAvailability(timestamps)
  };
}

function summarizeSessionCoverage(rows) {
  const covered = sum(rows, "covered_count");
  const total = sum(rows, "total_count");
  const full = rows.filter((row) => row.full_coverage).length;
  return {
    applicable_count: rows.length,
    full_coverage_count: full,
    full_coverage_rate: nullableRatio(full, rows.length),
    covered_count: covered,
    total_count: total,
    ratio: nullableRatio(covered, total)
  };
}

function summarizeLiteralWitnesses(rows) {
  const witnessed = rows.filter((row) => row.witnessed).length;
  return {
    applicable_count: rows.length,
    witnessed_count: witnessed,
    rate: nullableRatio(witnessed, rows.length),
    inspected_candidate_count: sum(rows, "inspected_candidate_count"),
    matched_candidate_count: sum(rows, "matched_candidate_count")
  };
}

function summarizeTimestampAvailability(rows) {
  const available = sum(rows, "available_count");
  const candidates = sum(rows, "candidate_count");
  return {
    question_count: rows.length,
    all_available_count: rows.filter((row) => row.all_available).length,
    available_count: available,
    candidate_count: candidates,
    ratio: nullableRatio(available, candidates)
  };
}

function summarizeAbstentionAxes(rows) {
  const correct = rows.filter((axes) => axes.abstention.status === "correct").length;
  const falseConfident = rows.filter((axes) =>
    axes.abstention.status === "false_confident"
  ).length;
  const uncalibrated = rows.filter((axes) =>
    axes.abstention.status === "uncalibrated"
  ).length;
  const scored = correct + falseConfident;
  return {
    measured_question_count: rows.length,
    scored_count: scored,
    uncalibrated_count: uncalibrated,
    correct_count: correct,
    false_confident_count: falseConfident,
    correct_rate: nullableRatio(correct, scored)
  };
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + row[field], 0);
}

function stageSummary(questions, stage) {
  const denominator = questions.length;
  const atK = Object.fromEntries(CEILING_KS.map((k) => {
    const count = questions.filter((question) => question.any_gold_at_k[stage][k]).length;
    return [k, { count, denominator, rate: ratio(count, denominator) }];
  }));
  return { at_5: atK[5], at_k: atK };
}

function transitionSummary(questions, index) {
  const previous = STAGE_ORDER[index - 1];
  const current = STAGE_ORDER[index];
  let gains = 0;
  let losses = 0;
  for (const question of questions) {
    const before = question.any_gold_at_k[previous][5];
    const after = question.any_gold_at_k[current][5];
    if (!before && after) gains += 1;
    if (before && !after) losses += 1;
  }
  return { gains, losses };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function nullableRatio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}
