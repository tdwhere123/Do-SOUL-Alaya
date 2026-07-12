export const FORBIDDEN_FEATURE_FIELDS = Object.freeze([
  "object_id", "candidate_key", "gold", "gold_memory_ids", "evaluator_gold_identity",
  "hit_at_5", "final_rank", "selection_order", "rank_after_*", "pre_budget_rank",
  "relevance_score", "miss_taxonomy"
]);
const FORBIDDEN_FEATURE_PATTERN = /(?:^|[.:_-])(object[-_]id|candidate[-_]key|gold(?:[-_]memory[-_]ids)?|evaluator[-_]gold[-_]identity|hit[-_]at[-_]5|final[-_]rank|selection[-_]order|rank[-_]after|pre[-_]budget[-_]rank|relevance[-_]score|miss[-_]taxonomy)(?:$|[.:_-])/i;
const SAFE_SCORE_NUMBERS = new Set([
  "activation", "facet_overlap", "lexical_overlap", "embedding_similarity",
  "semantic_similarity", "evidence_overlap", "temporal_overlap"
]);
const ANSWER_FIELDS = new Set([
  "domain_tags", "facet_tags", "canonical_entities", "typed_values",
  "preference_subject", "preference_predicate", "preference_object",
  "preference_category", "preference_polarity", "subject", "predicate", "object",
  "polarity", "answer_role", "event_time_start", "event_time_end", "valid_from",
  "valid_to", "time_precision", "time_source", "valid_time", "facets"
]);
const TYPED_PATH_NUMBERS = new Set([
  "direction_match", "query_trigger_match", "answer_role_match",
  "typed_value_match", "valid_time_match", "confidence", "provenance_present"
]);
const QUERY_PROBE_FIELDS = new Set([
  "subject_hints", "dimensions", "scope_classes", "domain_tags", "lexical_terms",
  "expanded_terms", "phrases", "char_ngrams", "date_terms"
]);

export function deriveCandidateFeatures(question, candidate, track = "baseline") {
  if (track !== "baseline" && track !== "typed_path") {
    throw new Error(`unknown separability track: ${track}`);
  }
  const numeric = {};
  const categorical = [];
  addStreamFeatures(numeric, candidate);
  addStructuralFeatures(numeric, candidate);
  addSafeScoreFactors(numeric, candidate.score_factors);
  const queryValues = collectQueryValues(question);
  addAnswerFeatures(numeric, categorical, queryValues, candidate);
  addQuestionFeatures(categorical, question);
  if (track === "typed_path") addTypedPathFeatures(numeric, categorical, candidate);
  assertNoForbiddenFeatureNames([...Object.keys(numeric), ...categorical]);
  return Object.freeze({ numeric: Object.freeze(numeric), categorical: Object.freeze(sortedUnique(categorical)) });
}

export function fitFeaturePipeline(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("feature pipeline requires non-empty training rows");
  }
  const numericFields = sortedUnique(rows.flatMap((row) => Object.keys(row.numeric)));
  const vocabulary = sortedUnique(rows.flatMap((row) => row.categorical));
  assertNoForbiddenFeatureNames([...numericFields, ...vocabulary]);
  const means = numericFields.map((field) => mean(rows.map((row) => finite(row.numeric[field]))));
  const scales = numericFields.map((field, index) => {
    const variance = mean(rows.map((row) => (finite(row.numeric[field]) - means[index]) ** 2));
    const scale = Math.sqrt(variance);
    return scale > 0 ? scale : 1;
  });
  return Object.freeze({
    numeric_fields: Object.freeze(numericFields),
    means: Object.freeze(means),
    scales: Object.freeze(scales),
    vocabulary: Object.freeze(vocabulary),
    vocabulary_index: new Map(vocabulary.map((value, index) => [value, index])),
    feature_names: Object.freeze([
      ...numericFields.map((field) => `num:${field}`),
      ...vocabulary.map((value) => `cat:${value}`)
    ])
  });
}

export function vectorizeFeatures(row, pipeline) {
  const categories = new Set(row.categorical);
  return Object.freeze([
    ...pipeline.numeric_fields.map((field, index) =>
      (finite(row.numeric[field]) - pipeline.means[index]) / pipeline.scales[index]
    ),
    ...pipeline.vocabulary.map((value) => categories.has(value) ? 1 : 0)
  ]);
}

export function vectorizeSparseFeatures(row, pipeline) {
  const entries = [];
  for (const [index, field] of pipeline.numeric_fields.entries()) {
    const value = (finite(row.numeric[field]) - pipeline.means[index]) / pipeline.scales[index];
    if (value !== 0) entries.push([index, value]);
  }
  const offset = pipeline.numeric_fields.length;
  for (const category of row.categorical) {
    const index = pipeline.vocabulary_index.get(category);
    if (index !== undefined) entries.push([offset + index, 1]);
  }
  entries.sort((left, right) => left[0] - right[0]);
  return Object.freeze(entries);
}

export function assertNoForbiddenFeatureNames(names) {
  const forbidden = names.find((name) => FORBIDDEN_FEATURE_PATTERN.test(featureField(name)));
  if (forbidden !== undefined) {
    throw new Error(`forbidden separability feature: ${forbidden}`);
  }
}

function featureField(name) {
  const delimiter = name.indexOf("=");
  return delimiter < 0 ? name : name.slice(0, delimiter);
}

function addStreamFeatures(numeric, candidate) {
  const ranks = record(candidate.per_stream_rank);
  for (const key of Object.keys(ranks).sort()) {
    const rank = positive(ranks[key]);
    numeric[`stream_reciprocal:${safeKey(key)}`] = rank === null ? 0 : 1 / rank;
  }
  numeric.stream_agreement_count = Object.values(ranks).filter((value) => positive(value) !== null).length;
  const contributions = record(candidate.fused_rank_contribution_per_stream);
  for (const key of Object.keys(contributions).sort()) {
    numeric[`stream_contribution:${safeKey(key)}`] = finite(contributions[key]);
  }
}

function addStructuralFeatures(numeric, candidate) {
  for (const [key, value] of Object.entries(record(candidate.per_axis_contribution)).sort()) {
    numeric[`axis_magnitude:${safeKey(key)}`] = Math.abs(finite(value));
  }
  const flood = record(candidate.flood_potential);
  for (const key of ["R_obj", "Slice", "A_path", "B_evidence", "E_direct", "omega", "Flood"]) {
    if (typeof flood[key] === "number") numeric[`flood_magnitude:${safeKey(key)}`] = Math.abs(finite(flood[key]));
  }
  numeric.path_suppression_magnitude = Math.abs(readSuppression(candidate));
}

function addSafeScoreFactors(numeric, value) {
  const factors = record(value);
  for (const key of [...SAFE_SCORE_NUMBERS].sort()) {
    if (typeof factors[key] === "number") numeric[`score:${key}`] = finite(factors[key]);
  }
}

function addAnswerFeatures(numeric, categorical, queryValues, candidate) {
  const answer = mergedRecord(record(candidate.score_factors).answer_features, candidate.answer_features);
  const textTerms = [...tokenize(answer.content), ...tokenize(answer.evidence_gist)];
  numeric.answer_text_overlap = textTerms.filter((value) => queryValues.has(value)).length;
  for (const field of [...ANSWER_FIELDS].sort()) {
    const values = strings(answer[field]);
    if (values.length === 0) continue;
    const normalized = values.map(normalizeValue).filter(Boolean);
    numeric[`answer_overlap:${field}`] = normalized.filter((value) => queryValues.has(value)).length;
    categorical.push(...normalized.map((value) => `answer:${field}=${value}`));
  }
  const dimension = normalizeValue(candidate.dimension);
  if (dimension !== "") categorical.push(`candidate:dimension=${dimension}`);
}

function addQuestionFeatures(categorical, question) {
  const type = normalizeValue(question.question_type);
  if (type !== "") categorical.push(`question:type=${type}`);
  for (const facet of strings(question.query_sought_facets)) {
    categorical.push(`query:sought_facet=${normalizeValue(facet)}`);
  }
}

function addTypedPathFeatures(numeric, categorical, candidate) {
  const path = mergedRecord(record(candidate.score_factors).path_features, candidate.path_features);
  const hopCount = positive(path.hop_count);
  if (hopCount !== null && hopCount > 1) throw new Error("typed-Path probe refuses two-hop features");
  const relationKind = normalizeValue(path.relation_kind);
  if (relationKind === "answers_with") {
    numeric.path_association_present = 1;
  } else {
    if (relationKind !== "") categorical.push(`path:relation_kind=${relationKind}`);
    for (const key of [...TYPED_PATH_NUMBERS].sort()) {
      if (typeof path[key] === "number" || typeof path[key] === "boolean") {
        numeric[`path_typed:${key}`] = finite(path[key]);
      }
    }
    for (const key of ["direction", "answer_role", "value_type", "time_relation", "provenance_kind"]) {
      const value = normalizeValue(path[key]);
      if (value !== "") categorical.push(`path:${key}=${value}`);
    }
  }
  addFloodEdgeFeatures(numeric, categorical, candidate.flood_potential);
}

function addFloodEdgeFeatures(numeric, categorical, floodPotential) {
  const traces = Array.isArray(record(floodPotential).edge_traces)
    ? record(floodPotential).edge_traces.filter((trace) => trace !== null && typeof trace === "object")
    : [];
  for (const trace of traces) {
    const relationKind = normalizeValue(trace.relation_kind);
    if (relationKind === "answers_with") {
      numeric.path_association_edge_count = (numeric.path_association_edge_count ?? 0) + 1;
      continue;
    }
    if (relationKind !== "") categorical.push(`path:relation_kind=${relationKind}`);
    numeric.path_direct_edge_count = (numeric.path_direct_edge_count ?? 0) + 1;
    numeric.path_transfer_magnitude = (numeric.path_transfer_magnitude ?? 0) + Math.abs(finite(trace.capped_transfer));
    for (const key of ["decision", "reason", "slice_compatibility"]) {
      const value = normalizeValue(trace[key]);
      if (value !== "") categorical.push(`path:${key}=${value}`);
    }
  }
}

function collectQueryValues(question) {
  const values = new Set(strings(question.query_sought_facets).map(normalizeValue));
  const probes = record(question.query_probes);
  for (const field of QUERY_PROBE_FIELDS) {
    for (const value of strings(probes[field])) values.add(normalizeValue(value));
  }
  values.delete("");
  return values;
}

function readSuppression(candidate) {
  const value = candidate.path_suppression_score ?? candidate.path_suppression ??
    record(candidate.score_factors).path_suppression;
  if (typeof value === "number") return finite(value);
  const source = record(value);
  return finite(source.magnitude ?? source.score ?? source.delta);
}

function mergedRecord(left, right) {
  return Object.freeze({ ...record(left), ...record(right) });
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function strings(value) {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}

function safeKey(value) {
  return String(value).replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 120) : "";
}

function tokenize(value) {
  if (typeof value !== "string") return [];
  return sortedUnique(value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).slice(0, 256);
}

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finite(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
