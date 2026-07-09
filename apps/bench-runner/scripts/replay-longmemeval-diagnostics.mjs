#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_CANDIDATE_TIEBREAKERS = [
  "facet_overlap",
  "activation",
  "created_at"
];

const CANDIDATE_RETRIEVAL_ARG_PREFIXES = [
  "--candidate-",
  "--retrieval-",
  "--recall-"
];

const CANDIDATE_RETRIEVAL_ARGS = new Set([
  "--candidate-limit",
  "--candidate-pool",
  "--candidate-pool-size",
  "--max-candidates",
  "--retrieval-limit",
  "--top-k"
]);

function usage() {
  return [
    "Usage:",
    "  node apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs --diagnostics <longmemeval-diagnostics.json>",
    "  node apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs --diagnostics <file> --weights stream=multiplier[,stream=multiplier...]",
    "  node apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs --diagnostics <file> --weights stream=multiplier[,stream=multiplier...] --rrf-k <k>",
    "  node apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs --diagnostics <file> --weights stream=multiplier[,stream=multiplier...] --facet-order first|tie-break",
    "  Default --facet-order is tie-break (matches production fused-rank: score first, facet nudge).",
    "",
    "Baseline mode reproduces gold-bearing any@5 from persisted gold final_rank fields.",
    "A/B mode is refused unless every gold-bearing question explicitly declares a complete candidate pool and carries tie-break fields.",
    "--rrf-k recomputes stream contribution from per_stream_rank fields and refuses frozen-only diagnostics."
  ].join("\n");
}

function parseArgs(argv) {
  // Default matches production fused-rank order: fused score first, facet as tie-break.
  const args = { diagnostics: null, weights: null, rrfK: null, facetOrder: "tie-break" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--diagnostics") {
      args.diagnostics = argv[++index] ?? null;
      continue;
    }
    if (arg === "--weights") {
      args.weights = parseWeights(argv[++index] ?? "");
      continue;
    }
    if (arg === "--rrf-k") {
      args.rrfK = parsePositiveNumber(argv[++index] ?? "", "--rrf-k");
      continue;
    }
    if (arg === "--facet-order") {
      args.facetOrder = parseFacetOrder(argv[++index] ?? "");
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (isCandidateRetrievalArg(arg)) {
      throw new Error(
        `candidate-retrieval parameter changes are not replayable from diagnostics: ${arg}`
      );
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (args.diagnostics === null) {
    throw new Error("--diagnostics is required");
  }
  return args;
}

function parseFacetOrder(raw) {
  if (raw === "first" || raw === "tie-break") {
    return raw;
  }
  throw new Error("--facet-order must be one of: first, tie-break");
}

function isCandidateRetrievalArg(arg) {
  return CANDIDATE_RETRIEVAL_ARGS.has(arg) ||
    CANDIDATE_RETRIEVAL_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix));
}

function parseWeights(raw) {
  if (raw.trim().length === 0) {
    throw new Error("--weights requires stream=multiplier pairs");
  }
  const weights = new Map();
  for (const part of raw.split(",")) {
    const [stream, multiplierRaw] = part.split("=");
    const multiplier = Number(multiplierRaw);
    if (stream === undefined || stream.length === 0 || !Number.isFinite(multiplier)) {
      throw new Error(`invalid --weights entry '${part}'`);
    }
    weights.set(stream, multiplier);
  }
  return weights;
}

function parsePositiveNumber(raw, field) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} requires a positive number`);
  }
  return value;
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function loadDiagnostics(filePath) {
  const diagnostics = await readJson(filePath);
  if (
    diagnostics?.compact_schema_version === 1 &&
    typeof diagnostics.full_diagnostics_artifact_path === "string"
  ) {
    const artifactPath = path.isAbsolute(diagnostics.full_diagnostics_artifact_path)
      ? diagnostics.full_diagnostics_artifact_path
      : path.resolve(path.dirname(filePath), diagnostics.full_diagnostics_artifact_path);
    return readJson(artifactPath);
  }
  return diagnostics;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) {
    throw new Error(`missing required array field: ${field}`);
  }
  return value;
}

function requireNumberOrNull(value, field) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`missing required numeric/null field: ${field}`);
  }
  return value;
}

function isAbstentionQuestion(questionId) {
  return questionId.includes("_abs");
}

function goldBearingQuestions(diagnostics) {
  const questions = requireArray(diagnostics.questions, "questions");
  return questions.filter((question, index) => {
    if (typeof question.question_id !== "string") {
      throw new Error(`missing required string field: questions[${index}].question_id`);
    }
    const gold = requireArray(question.gold, `questions[${index}].gold`);
    return !isAbstentionQuestion(question.question_id) && gold.length > 0;
  });
}

function replayBaseline(questions) {
  let anyAt5 = 0;
  let fullAt5 = 0;
  let goldAt5 = 0;
  let goldTotal = 0;
  for (const [questionIndex, question] of questions.entries()) {
    const gold = requireArray(question.gold, `questions[${questionIndex}].gold`);
    let anyHit = false;
    let allHit = true;
    for (const [goldIndex, row] of gold.entries()) {
      const finalRank = requireNumberOrNull(
        row.final_rank,
        `questions[${questionIndex}].gold[${goldIndex}].final_rank`
      );
      goldTotal += 1;
      if (finalRank !== null && finalRank <= 5) {
        anyHit = true;
        goldAt5 += 1;
      } else {
        allHit = false;
      }
    }
    if (anyHit) anyAt5 += 1;
    if (allHit) fullAt5 += 1;
  }
  return {
    gold_bearing_questions: questions.length,
    any_at_5_count: anyAt5,
    any_at_5: ratio(anyAt5, questions.length),
    full_gold_at_5_count: fullAt5,
    full_gold_at_5: ratio(fullAt5, questions.length),
    gold_coverage_at_5_count: goldAt5,
    gold_coverage_at_5: ratio(goldAt5, goldTotal)
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function replayWeightedAb(questions, weights, options) {
  let anyAt5 = 0;
  let fullAt5 = 0;
  let goldAt5 = 0;
  let goldTotal = 0;
  for (const [questionIndex, question] of questions.entries()) {
    const candidates = readCandidateRows(question, questionIndex, options);
    const ranked = [...candidates].sort((left, right) =>
      compareReplayCandidates(left, right, weights, options)
    );
    const top5 = new Set(ranked.slice(0, 5).map((candidate) => candidate.object_id));
    const gold = requireArray(question.gold, `questions[${questionIndex}].gold`);
    let anyHit = false;
    let allHit = true;
    for (const row of gold) {
      goldTotal += 1;
      if (top5.has(row.object_id)) {
        anyHit = true;
        goldAt5 += 1;
      } else {
        allHit = false;
      }
    }
    if (anyHit) {
      anyAt5 += 1;
    }
    if (allHit) {
      fullAt5 += 1;
    }
  }
  return {
    mode: "weighted_ab",
    gold_bearing_questions: questions.length,
    any_at_5_count: anyAt5,
    any_at_5: ratio(anyAt5, questions.length),
    full_gold_at_5_count: fullAt5,
    full_gold_at_5: ratio(fullAt5, questions.length),
    gold_coverage_at_5_count: goldAt5,
    gold_coverage_at_5: ratio(goldAt5, goldTotal),
    weights: Object.fromEntries(weights),
    facet_order: options.facetOrder,
    ...(options.rrfK === null ? {} : { rrf_k: options.rrfK })
  };
}

function readCandidateRows(question, questionIndex, options) {
  if (question.candidate_pool_complete !== true) {
    throw new Error(
      `A/B replay refused: questions[${questionIndex}] does not declare candidate_pool_complete=true`
    );
  }
  const candidates = question.candidates ?? question.recall_diagnostics?.candidates;
  if (!Array.isArray(candidates)) {
    throw new Error(
      `A/B replay refused: questions[${questionIndex}] lacks full per-candidate rows`
    );
  }
  return candidates.map((candidate, candidateIndex) =>
    validateCandidate(candidate, questionIndex, candidateIndex, options)
  );
}

function validateCandidate(candidate, questionIndex, candidateIndex, options) {
  const prefix = `questions[${questionIndex}].candidates[${candidateIndex}]`;
  if (typeof candidate.object_id !== "string") {
    throw new Error(`A/B replay refused: ${prefix}.object_id missing`);
  }
  if (options.rrfK === null && !isRecord(candidate.fused_rank_contribution_per_stream)) {
    throw new Error(
      `A/B replay refused: ${prefix}.fused_rank_contribution_per_stream missing`
    );
  }
  if (options.rrfK !== null && !isRecord(candidate.per_stream_rank)) {
    throw new Error(
      `A/B replay refused: --rrf-k requires per_stream_rank; ${prefix} only has frozen contributions`
    );
  }
  const scoreFactors = candidate.score_factors;
  if (!isRecord(scoreFactors)) {
    throw new Error(`A/B replay refused: ${prefix}.score_factors missing`);
  }
  for (const key of REQUIRED_CANDIDATE_TIEBREAKERS) {
    if (scoreFactors[key] === undefined) {
      throw new Error(`A/B replay refused: ${prefix}.score_factors.${key} missing`);
    }
  }
  return candidate;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareReplayCandidates(left, right, weights, options) {
  const leftFactors = left.score_factors;
  const rightFactors = right.score_factors;
  const facetDelta = Number(rightFactors.facet_overlap) - Number(leftFactors.facet_overlap);
  if (options.facetOrder === "first" && facetDelta !== 0) return facetDelta;
  const scoreDelta = weightedScore(right, weights, options) - weightedScore(left, weights, options);
  if (scoreDelta !== 0) return scoreDelta;
  if (options.facetOrder === "tie-break" && facetDelta !== 0) return facetDelta;
  const activationDelta = Number(rightFactors.activation) - Number(leftFactors.activation);
  if (activationDelta !== 0) return activationDelta;
  const createdDelta = String(leftFactors.created_at).localeCompare(
    String(rightFactors.created_at)
  );
  if (createdDelta !== 0) return createdDelta;
  return left.object_id.localeCompare(right.object_id);
}

function weightedScore(candidate, weights, options) {
  if (options.rrfK !== null) {
    return rrfScore(candidate, weights, options.rrfK);
  }
  let score = 0;
  for (const [stream, value] of Object.entries(candidate.fused_rank_contribution_per_stream)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `A/B replay refused: candidate ${candidate.object_id} stream ${stream} is not numeric`
      );
    }
    score += value * (weights.get(stream) ?? 1);
  }
  return score;
}

function rrfScore(candidate, weights, rrfK) {
  let score = 0;
  for (const [stream, rank] of Object.entries(candidate.per_stream_rank)) {
    if (rank === null) {
      continue;
    }
    if (typeof rank !== "number" || !Number.isFinite(rank) || rank <= 0) {
      throw new Error(
        `A/B replay refused: candidate ${candidate.object_id} stream ${stream} rank is not positive numeric/null`
      );
    }
    score += (weights.get(stream) ?? 1) / (rrfK + rank);
  }
  return score;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const diagnostics = await loadDiagnostics(args.diagnostics);
  const questions = goldBearingQuestions(diagnostics);
  const baseline = replayBaseline(questions);
  const output = { baseline };
  if (args.weights !== null || args.rrfK !== null) {
    output.ab = replayWeightedAb(questions, args.weights ?? new Map(), {
      rrfK: args.rrfK,
      facetOrder: args.facetOrder
    });
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(`replay-longmemeval-diagnostics: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
