import {
  deriveCandidateFeatures,
  fitFeaturePipeline,
  vectorizeSparseFeatures
} from "./separability-features.mjs";

const ITERATIONS = 300;
const INITIAL_LEARNING_RATE = 0.05;
const L2 = 1e-3;

export const BOUNDARY_OBJECTIVE = Object.freeze({
  name: "rank5_boundary_margin",
  positive_selection: "best_current_ranked_gold",
  negative_rank_ceiling: 10,
  top5_negative_weight: 2,
  top5_margin: 1,
  rank6_to_10_negative_weight: 1,
  rank6_to_10_margin: 0.5
});

export const PREREGISTERED_GUARDS = Object.freeze([
  Object.freeze({
    name: "top5_protected_floor", protected_top_k: 5,
    promotion_cap: 0, minimum_score_advantage: null
  }),
  Object.freeze({
    name: "top4_single_promotion", protected_top_k: 4,
    promotion_cap: 1, minimum_score_advantage: 0
  }),
  Object.freeze({
    name: "top4_margin_single_promotion", protected_top_k: 4,
    promotion_cap: 1, minimum_score_advantage: 0.5
  }),
  Object.freeze({
    name: "top3_margin_two_promotions", protected_top_k: 3,
    promotion_cap: 2, minimum_score_advantage: 1
  })
]);

export function runBoundaryObjectiveLane(questions, assignments, foldCount, adapters, emit) {
  const predictions = new Map();
  const foldModels = [];
  for (let fold = 0; fold < foldCount; fold += 1) {
    emit({ stage: "objective_fold_start", track: "typed_path_lexical_a", fold });
    const train = questions.filter((question) =>
      assignments.get(question.question_id) !== fold && adapters.isScorable(question)
    );
    const heldOut = questions.filter((question) =>
      assignments.get(question.question_id) === fold && adapters.isScorable(question)
    );
    const lexicalModel = fitFoldLexicalModel(train.flatMap(adapters.candidates));
    const trainRows = new Map(train.map((question) => [
      question.question_id, candidateRows(question, lexicalModel, adapters)
    ]));
    const pipeline = fitFeaturePipeline([...trainRows.values()].flat().map((row) => row.features));
    const pairs = train.flatMap((question) => vectorBoundaryPairs(
      trainRows.get(question.question_id), adapters.goldIds(question), pipeline
    ));
    const weights = optimizeBoundaryPairs(pairs, pipeline.feature_names.length);
    for (const question of heldOut) {
      const rows = candidateRows(question, lexicalModel, adapters);
      predictions.set(question.question_id, scoreCandidates(rows, pipeline, weights));
    }
    foldModels.push(renderFoldModel(fold, train, lexicalModel, pairs, pipeline));
    emit({ stage: "objective_fold_complete", track: "typed_path_lexical_a", fold });
  }
  const guards = PREREGISTERED_GUARDS.map((guard) =>
    evaluateGuard(guard, questions, predictions, adapters)
  );
  const currentHits = questions.filter((question) => question.hit_at_5 === true).length;
  return Object.freeze({
    track: "typed_path_plus_lexical_a",
    feature_addition: Object.freeze({
      family: "A", fields: Object.freeze(["idf_coverage", "length_normalization", "phrase_coverage"]),
      idf_fit_scope: "training_fold_candidates_only", vocabulary_fit_scope: "training_fold_only",
      normalization_fit_scope: "training_fold_only", high_dimensional_interactions: false
    }),
    objective: BOUNDARY_OBJECTIVE,
    optimizer: Object.freeze({
      initialization: "zeros", iterations: ITERATIONS,
      learning_rate: INITIAL_LEARNING_RATE, decay: "inverse_sqrt", l2: L2
    }),
    guards,
    fold_models: Object.freeze(foldModels),
    decision: summarizeGuardDecision(guards)
  });
}

export function fitFoldLexicalModel(candidates) {
  const documents = candidates.map(candidateDocument);
  if (documents.length === 0) throw new Error("lexical model requires training-fold candidates");
  const frequencies = new Map();
  for (const document of documents) {
    for (const token of new Set(document.all)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return Object.freeze({
    document_count: documents.length,
    average_length: documents.reduce((sum, document) => sum + document.all.length, 0) / documents.length,
    document_frequency: Object.freeze(Object.fromEntries([...frequencies].sort(([left], [right]) =>
      left.localeCompare(right)
    )))
  });
}

export function buildBoundaryPairs(rows, goldIds) {
  const positives = rows.filter((row) => goldIds.has(row.candidate.object_id))
    .sort((left, right) => rank(left.candidate.fused_rank) - rank(right.candidate.fused_rank));
  const positive = positives[0];
  if (positive === undefined) return Object.freeze([]);
  const negatives = rows.filter((row) =>
    !goldIds.has(row.candidate.object_id) && rank(row.candidate.fused_rank) <= BOUNDARY_OBJECTIVE.negative_rank_ceiling
  );
  return Object.freeze(negatives.map((negative) => {
    const insideTop5 = rank(negative.candidate.fused_rank) <= 5;
    return Object.freeze({
      difference: subtractSparseVectors(positive.vector, negative.vector),
      weight: insideTop5 ? BOUNDARY_OBJECTIVE.top5_negative_weight :
        BOUNDARY_OBJECTIVE.rank6_to_10_negative_weight,
      margin: insideTop5 ? BOUNDARY_OBJECTIVE.top5_margin : BOUNDARY_OBJECTIVE.rank6_to_10_margin
    });
  }));
}

export function optimizeBoundaryPairs(pairs, featureCount) {
  if (pairs.length === 0) throw new Error("rank-5 boundary objective requires training pairs");
  const weights = new Float64Array(featureCount);
  const gradient = new Float64Array(featureCount);
  const stamps = new Uint16Array(featureCount);
  const totalWeight = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const touched = [];
    for (const pair of pairs) {
      const multiplier = -pair.weight * stableLogisticNegative(
        sparseDot(weights, pair.difference) - pair.margin
      );
      accumulateSparseGradient(gradient, stamps, touched, pair.difference, multiplier, iteration + 1);
    }
    const learningRate = INITIAL_LEARNING_RATE / Math.sqrt(iteration + 1);
    for (const index of touched) {
      weights[index] -= learningRate * (gradient[index] / totalWeight + L2 * weights[index]);
    }
  }
  return Object.freeze(Array.from(weights));
}

export function applyMonotonicGuard(scoredRows, guard) {
  const current = [...scoredRows].sort(compareCurrentRank).slice(0, 5);
  const protectedRows = current.slice(0, guard.protected_top_k);
  const boundaryRows = current.slice(guard.protected_top_k);
  if (guard.promotion_cap === 0) return renderGuardRanking(current, []);
  const protectedKeys = new Set(protectedRows.map((row) => stableKey(row.candidate)));
  const currentKeys = new Set(current.map((row) => stableKey(row.candidate)));
  const outside = [...scoredRows].filter((row) => !currentKeys.has(stableKey(row.candidate)))
    .sort(compareObjectiveScore);
  const displacementOrder = [...boundaryRows].sort((left, right) => left.score - right.score ||
    compareCurrentRank(right, left));
  const accepted = admitPromotions(outside, displacementOrder, guard);
  const displacedKeys = new Set(accepted.map((row) => stableKey(row.displaced.candidate)));
  const retained = boundaryRows.filter((row) => !displacedKeys.has(stableKey(row.candidate)));
  const finalRows = [...protectedRows, ...accepted.map((row) => row.promoted), ...retained]
    .filter((row) => protectedKeys.has(stableKey(row.candidate)) || !displacedKeys.has(stableKey(row.candidate)))
    .slice(0, 5);
  return renderGuardRanking(finalRows, accepted);
}

export function summarizeGuardDecision(guards) {
  const candidates = guards.filter((guard) => guard.net_gain_count > 0);
  const ordered = [...candidates].sort((left, right) =>
    right.end_to_end_any_at_5_count - left.end_to_end_any_at_5_count ||
    left.loss_count - right.loss_count || left.name.localeCompare(right.name)
  );
  return Object.freeze({
    acceptance_rule: "held_out_net_gain_strictly_positive",
    candidate_guard_names: Object.freeze(candidates.map((guard) => guard.name)),
    zero_loss_candidate_guard_names: Object.freeze(candidates.filter((guard) => guard.loss_count === 0)
      .map((guard) => guard.name)),
    best_candidate_guard: ordered[0]?.name ?? null,
    production_authorization: "offline_evidence_only"
  });
}

function candidateRows(question, lexicalModel, adapters) {
  return adapters.candidates(question).map((candidate) => {
    const base = deriveCandidateFeatures(question, candidate, "typed_path");
    return Object.freeze({
      candidate,
      features: Object.freeze({
        numeric: Object.freeze({ ...base.numeric, ...deriveLexicalFeatures(question, candidate, lexicalModel) }),
        categorical: base.categorical
      })
    });
  });
}

function deriveLexicalFeatures(question, candidate, model) {
  const query = queryTerms(question);
  const phrases = queryPhrases(question);
  const document = candidateDocument(candidate);
  const all = new Set(document.all);
  const content = new Set(document.content);
  const gist = new Set(document.gist);
  const queryWeight = query.reduce((sum, token) => sum + idf(token, model), 0);
  const coverage = (tokens) => query.reduce((sum, token) =>
    sum + (tokens.has(token) ? idf(token, model) : 0), 0
  );
  const tf = termFrequencies(document.all);
  const lengthNorm = 1.2 * (0.25 + 0.75 * document.all.length / Math.max(1, model.average_length));
  const bm25 = query.reduce((sum, token) => {
    const count = tf.get(token) ?? 0;
    return sum + idf(token, model) * (count * 2.2) / (count + lengthNorm);
  }, 0);
  return Object.freeze({
    qlex_idf_coverage: queryWeight === 0 ? 0 : coverage(all) / queryWeight,
    qlex_content_idf_coverage: queryWeight === 0 ? 0 : coverage(content) / queryWeight,
    qlex_gist_idf_coverage: queryWeight === 0 ? 0 : coverage(gist) / queryWeight,
    qlex_phrase_coverage: ratio(phrases.filter((phrase) => document.raw.includes(phrase)).length, phrases.length),
    qlex_bm25_length_normalized: queryWeight === 0 ? 0 : bm25 / queryWeight,
    qlex_log_length: Math.log1p(document.all.length),
    qlex_length_ratio: document.all.length / Math.max(1, model.average_length)
  });
}

function vectorBoundaryPairs(rows, goldIds, pipeline) {
  const vectorRows = rows.map((row) => Object.freeze({
    candidate: row.candidate,
    vector: vectorizeSparseFeatures(row.features, pipeline)
  }));
  return buildBoundaryPairs(vectorRows, goldIds);
}

function scoreCandidates(rows, pipeline, weights) {
  return Object.freeze(rows.map((row) => Object.freeze({
    candidate: row.candidate,
    score: sparseDot(weights, vectorizeSparseFeatures(row.features, pipeline))
  })));
}

function evaluateGuard(guard, questions, predictions, adapters) {
  const rows = questions.map((question) => renderGuardQuestion(
    question, predictions.get(question.question_id), guard, adapters
  ));
  const scored = rows.filter((row) => row.status === "scored");
  const hits = scored.filter((row) => row.any_at_5).length;
  const gains = scored.filter((row) => row.any_at_5 && !row.current_any_at_5).length;
  const losses = scored.filter((row) => !row.any_at_5 && row.current_any_at_5).length;
  return Object.freeze({
    ...guard,
    conditional_any_at_5_count: hits,
    conditional_any_at_5: ratio(hits, scored.length),
    end_to_end_any_at_5_count: hits,
    end_to_end_any_at_5: ratio(hits, rows.length),
    gain_count: gains, loss_count: losses, net_gain_count: gains - losses,
    question_type_metrics: summarizeQuestionTypes(rows),
    rows: Object.freeze(rows)
  });
}

function renderGuardQuestion(question, prediction, guard, adapters) {
  const common = {
    question_id: question.question_id,
    question_type: question.question_type ?? null,
    current_any_at_5: question.hit_at_5 === true
  };
  if (!adapters.isScorable(question)) {
    return Object.freeze({ ...common, status: "unscorable", any_at_5: null,
      top_5_candidate_keys: Object.freeze([]), promoted_candidate_keys: Object.freeze([]),
      displaced_candidate_keys: Object.freeze([]), promotion_decisions: Object.freeze([]) });
  }
  if (prediction === undefined) throw new Error(`missing boundary-objective OOF prediction: ${question.question_id}`);
  const guarded = applyMonotonicGuard(prediction, guard);
  const goldIds = adapters.goldIds(question);
  return Object.freeze({ ...common, status: "scored",
    any_at_5: guarded.top_5_candidate_keys.some((key) =>
      prediction.some((row) => stableKey(row.candidate) === key && goldIds.has(row.candidate.object_id))
    ), ...guarded });
}

function admitPromotions(outside, displacementOrder, guard) {
  const accepted = [];
  for (const promoted of outside) {
    if (accepted.length >= guard.promotion_cap) break;
    const displaced = displacementOrder[accepted.length];
    if (displaced === undefined) break;
    if (promoted.score - displaced.score < guard.minimum_score_advantage) continue;
    accepted.push(Object.freeze({ promoted, displaced }));
  }
  return accepted;
}

function renderGuardRanking(rows, decisions) {
  return Object.freeze({
    top_5_candidate_keys: Object.freeze(rows.map((row) => stableKey(row.candidate))),
    promoted_candidate_keys: Object.freeze(decisions.map((row) => stableKey(row.promoted.candidate))),
    displaced_candidate_keys: Object.freeze(decisions.map((row) => stableKey(row.displaced.candidate))),
    promotion_decisions: Object.freeze(decisions.map((row) => Object.freeze({
      promoted_candidate_key: stableKey(row.promoted.candidate),
      displaced_candidate_key: stableKey(row.displaced.candidate),
      score_advantage: row.promoted.score - row.displaced.score
    })))
  });
}

function renderFoldModel(fold, train, lexicalModel, pairs, pipeline) {
  const active = new Set();
  for (const pair of pairs) for (const [index] of pair.difference) active.add(index);
  return Object.freeze({
    fold, training_question_count: train.length,
    lexical_training_document_count: lexicalModel.document_count,
    pair_count: pairs.length, feature_count: pipeline.feature_names.length,
    active_feature_count: active.size
  });
}

function summarizeQuestionTypes(rows) {
  const types = [...new Set(rows.map((row) => row.question_type ?? "unknown"))].sort();
  return Object.freeze(types.map((type) => {
    const members = rows.filter((row) => (row.question_type ?? "unknown") === type);
    const scored = members.filter((row) => row.status === "scored");
    return Object.freeze({
      question_type: type, dataset_answerable_count: members.length,
      runtime_scorable_count: scored.length,
      current_hit_count: scored.filter((row) => row.current_any_at_5).length,
      oof_hit_count: scored.filter((row) => row.any_at_5).length,
      gain_count: scored.filter((row) => row.any_at_5 && !row.current_any_at_5).length,
      loss_count: scored.filter((row) => !row.any_at_5 && row.current_any_at_5).length
    });
  }));
}

function candidateDocument(candidate) {
  const answer = { ...record(record(candidate.score_factors).answer_features), ...record(candidate.answer_features) };
  const contentRaw = strings(answer.content).join(" ");
  const gistRaw = strings(answer.evidence_gist).join(" ");
  const content = tokenize(contentRaw);
  const gist = tokenize(gistRaw);
  return Object.freeze({ content, gist, all: Object.freeze([...content, ...gist]),
    raw: normalize(`${contentRaw} ${gistRaw}`) });
}

function queryTerms(question) {
  const probes = record(question.query_probes);
  return sortedUnique([
    question.normalized_query, ...strings(probes.lexical_terms), ...strings(probes.expanded_terms),
    ...strings(probes.subject_hints), ...strings(probes.domain_tags), ...strings(probes.date_terms),
    ...strings(question.query_sought_facets)
  ].flatMap(tokenize));
}

function queryPhrases(question) {
  const probes = record(question.query_probes);
  return sortedUnique([...strings(probes.phrases), ...strings(question.query_sought_facets)]
    .map(normalize).filter((value) => value.length >= 3));
}

function idf(token, model) {
  const frequency = model.document_frequency[token] ?? 0;
  return Math.log(1 + (model.document_count - frequency + 0.5) / (frequency + 0.5));
}

function compareCurrentRank(left, right) {
  return currentRank(left.candidate) - currentRank(right.candidate) ||
    stableKey(left.candidate).localeCompare(stableKey(right.candidate));
}

function currentRank(candidate) {
  const delivered = rank(candidate.final_rank);
  return Number.isFinite(delivered) ? delivered : rank(candidate.fused_rank);
}

function compareObjectiveScore(left, right) {
  return right.score - left.score || compareCurrentRank(left, right);
}

function stableKey(candidate) {
  if (typeof candidate.candidate_key === "string" && candidate.candidate_key.length > 0) return candidate.candidate_key;
  if (typeof candidate.object_id === "string" && candidate.object_id.length > 0) return candidate.object_id;
  throw new Error("candidate_key or object_id is required for deterministic guard ranking");
}

function rank(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function stableLogisticNegative(score) {
  if (score >= 0) {
    const exp = Math.exp(-score);
    return exp / (1 + exp);
  }
  return 1 / (1 + Math.exp(score));
}

function subtractSparseVectors(left, right) {
  const result = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftEntry = left[leftIndex];
    const rightEntry = right[rightIndex];
    if (rightEntry === undefined || (leftEntry !== undefined && leftEntry[0] < rightEntry[0])) {
      result.push(leftEntry); leftIndex += 1;
    } else if (leftEntry === undefined || rightEntry[0] < leftEntry[0]) {
      result.push([rightEntry[0], -rightEntry[1]]); rightIndex += 1;
    } else {
      const value = leftEntry[1] - rightEntry[1];
      if (value !== 0) result.push([leftEntry[0], value]);
      leftIndex += 1; rightIndex += 1;
    }
  }
  return Object.freeze(result);
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

function termFrequencies(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function strings(value) {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function tokenize(value) {
  return typeof value === "string" ? value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [] : [];
}

function normalize(value) {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 160) : "";
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}
