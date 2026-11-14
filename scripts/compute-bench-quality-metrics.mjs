#!/usr/bin/env node
// Compute Phase-0-safe benchmark quality metrics from a bench archive.
// Accepts either an archive directory or a concrete JSON diagnostics file.
// Usage: node scripts/compute-bench-quality-metrics.mjs <archive>

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { readGoldObjectIds } from "../apps/bench-runner/dist/diagnostics/gold-object-identities.js";
import { QualityMetricsSchema } from "../packages/eval/dist/contracts/kpi-quality-schema.js";
import {
  asArray,
  asStringArray,
  buildCohort,
  buildCountDistribution,
  buildPerPlaneRecallCoverage,
  countActiveConstraints,
  countPlane,
  createCohortCounters,
  errorMessage,
  hasOwnField,
  isRecord,
  isScoreOrderNonMonotonic,
  readNumber,
  readPlaneWithPresence,
  readString,
  share
} from "./compute-bench-quality-metrics-utils.mjs";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("usage: compute-bench-quality-metrics.mjs <archive>");
  process.exit(2);
}

const result = createEmptyResult(argv[0]);

try {
  const source = resolveArchiveSource(argv[0], result.warnings);
  result.source.resolved_path = source?.resolvedPath ?? resolve(argv[0]);
  result.source.selected_path = source?.selectedPath ?? null;

  if (source === null) {
    throw new Error("no readable archive JSON source found");
  } else {
    const archive = JSON.parse(readFileSync(source.selectedPath, "utf8"));
    result.source.archive_kind = detectArchiveKind(archive);
    result.metadata.archive_file = basename(source.selectedPath);
    result.metadata.bench_name = readString(archive?.bench_name);
    result.metadata.run_at = readString(archive?.run_at);
    result.metadata.schema_version = readString(archive?.schema_version);

    if (result.source.archive_kind === "longmemeval-diagnostics") {
      applyLongMemEvalDiagnostics(archive, result);
    } else if (result.source.archive_kind === "controlled-replay") {
      applyControlledReplay(archive, result);
    } else if (result.source.archive_kind === "kpi-payload") {
      applyKpiPayload(archive, result);
    } else {
      throw new Error(`unrecognized archive shape in ${source.selectedPath}`);
    }
  }
} catch (error) {
  console.error(`failed to read archive: ${errorMessage(error)}`);
  process.exit(1);
}

console.log(JSON.stringify(result, null, 2));

function createEmptyResult(input) {
  return {
    schema_version: "bench-quality-metrics.v1",
    source: {
      input,
      resolved_path: null,
      selected_path: null,
      archive_kind: "unknown"
    },
    metadata: {},
    warnings: [],
    non_monotonic_rate: 0,
    budget_drop_distribution: {},
    high_lexical_demoted_rate: 0,
    cohort_first_admitted: {},
    cohort_winning_admission: {},
    path_expansion_share: 0,
    active_constraints_count: 0,
    per_plane_recall_coverage: {}
  };
}

function resolveArchiveSource(inputPath, warnings) {
  const resolvedPath = resolve(inputPath);
  if (!existsSync(resolvedPath)) {
    warnings.push(`input path does not exist: ${resolvedPath}`);
    return null;
  }

  const stat = statSync(resolvedPath);
  if (stat.isFile()) {
    return { resolvedPath, selectedPath: resolvedPath };
  }

  if (!stat.isDirectory()) {
    warnings.push(`input path is neither a file nor directory: ${resolvedPath}`);
    return null;
  }

  const preferredNames = [
    "longmemeval-diagnostics.json",
    "locomo-diagnostics.json",
    "controlled-replay.json",
    "diagnostics.json",
    "kpi.json"
  ];
  for (const name of preferredNames) {
    const candidate = join(resolvedPath, name);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { resolvedPath, selectedPath: candidate };
    }
  }

  const jsonFiles = readdirSync(resolvedPath)
    .filter((name) => extname(name) === ".json")
    .sort();

  if (jsonFiles.length === 1) {
    return { resolvedPath, selectedPath: join(resolvedPath, jsonFiles[0]) };
  }

  if (jsonFiles.length > 1) {
    warnings.push(
      `archive directory has multiple JSON files and no preferred diagnostics file: ${jsonFiles.join(", ")}`
    );
  }

  return null;
}

function detectArchiveKind(archive) {
  if (Array.isArray(archive?.questions) && archive.questions.every(isRecord)) return "longmemeval-diagnostics";
  if (
    Array.isArray(archive?.scenarios) &&
    archive?.metrics !== null &&
    typeof archive?.metrics === "object"
  ) {
    return "controlled-replay";
  }
  // A KpiPayload archive (kpi.json) carries the bench-runner's own
  // quality_metrics block; read per-plane coverage straight from it.
  if (isRecord(archive?.kpi) && isRecord(archive?.kpi?.quality_metrics)) {
    return "kpi-payload";
  }
  return "unknown";
}

function applyLongMemEvalDiagnostics(archive, output) {
  const questions = archive.questions;
  const availability = validateDiagnosticsMeasurement(archive);
  const questionStats = accumulateQuestionStats(questions);
  const goldStats = accumulateGoldStats(questionStats.allGold);
  const activeConstraints = countActiveConstraints(archive);

  assignDiagnosticsOutput(output, {
    questions,
    questionStats,
    goldStats,
    activeConstraints
  });
  preserveMissingDiagnosticsMeasurements(output, availability, questionStats, goldStats, activeConstraints);
}

// This offline projection also reads historical partial sidecars, not just the
// current full schema. Its minimum input is an observed delivery list plus gold
// diagnostics or a declared gold identity list. Missing lists are never [].
function validateDiagnosticsMeasurement(archive) {
  if (hasOwnField(archive, "schema_version") && archive.schema_version !== 1) {
    throw new Error("unsupported diagnostics schema_version");
  }
  let goldComplete = true, identityComplete = true;
  for (const question of archive.questions) {
    if (!Array.isArray(question.delivered_results)) {
      throw new Error("diagnostics question requires measured delivered_results[]");
    }
    for (const key of ["delivered_results", "gold"]) {
      if (hasOwnField(question, key) && (!Array.isArray(question[key]) ||
          !question[key].every(row => isRecord(row) && typeof row.object_id === "string" && row.object_id.length > 0))) {
        throw new Error(`invalid diagnostics question ${key}`);
      }
    }
    for (const row of [...question.delivered_results, ...(question.gold ?? [])]) validateDiagnosticFacetFields(row);
    const identityKeys = ["gold_object_ids", "gold_memory_ids", "gold_evidence_ids"]
      .filter(key => hasOwnField(question, key));
    for (const key of identityKeys) {
      if (!Array.isArray(question[key]) || !question[key].every(id => typeof id === "string" && id.length > 0)) {
        throw new Error(`invalid diagnostics question ${key}`);
      }
    }
    if (!hasOwnField(question, "gold") && identityKeys.length === 0) {
      throw new Error("diagnostics question requires measured gold[] or gold identity list");
    }
    goldComplete &&= hasOwnField(question, "gold");
    identityComplete &&= identityKeys.length > 0 || question.gold?.length === 0;
  }
  return { goldComplete, identityComplete };
}

// Validate supplied coordinates even when another field makes their facet
// unavailable. Preserve the producer's nullable rank/drop/plane semantics;
// unlike these fields, relevance_score is a number, not a nullable coordinate.
function validateDiagnosticFacetFields(row) {
  const valid = (key, predicate) => {
    if (hasOwnField(row, key) && !predicate(row[key])) {
      throw new Error(`invalid diagnostics facet ${key}`);
    }
  };
  const finite = value => typeof value === "number" && Number.isFinite(value);
  valid("relevance_score", finite);
  for (const key of ["lexical_rank", "final_rank"]) valid(key, value => value === null || finite(value));
  valid("budget_drop_reason", value => value === null || typeof value === "string" && value.trim().length > 0);
  for (const key of ["plane_first_admitted", "plane_winning_admission"]) {
    valid(key, value => value === null || typeof value === "string");
  }
  valid("source_planes", value => Array.isArray(value) && value.every(plane => typeof plane === "string"));
}

function preserveMissingDiagnosticsMeasurements(output, availability, stats, goldStats, constraints) {
  const unavailable = {};
  const omit = (keys, reason) => {
    for (const key of keys) { delete output[key]; unavailable[key] = reason; }
  };
  const metadata = output.metadata.longmemeval;
  const goldReason = availability.goldComplete
    ? "required gold facet fields absent on some rows" : "gold diagnostics absent on some questions";
  if (!availability.goldComplete) delete metadata.gold_count;
  if (!availability.goldComplete || !goldStats.budgetComplete) {
    omit(["budget_drop_distribution"], goldReason);
    delete metadata.budget_drop_denominator;
    delete metadata.budget_drop_field_count;
  }
  if (!availability.goldComplete || !goldStats.lexicalComplete) {
    omit(["high_lexical_demoted_rate"], goldReason);
    delete metadata.high_lexical_demoted_count;
    delete metadata.high_lexical_demoted_denominator;
  }
  if (!availability.goldComplete || !goldStats.coverageComplete) omit(["per_plane_recall_coverage"], goldReason);
  for (const [facet, observed, counter] of [
    ["cohort_first_admitted", stats.planeFirstFields, "plane_first_admitted_field_count"],
    ["cohort_winning_admission", stats.planeWinningFields, "plane_winning_admission_field_count"]
  ]) {
    if (observed !== stats.deliveredCount) {
      omit([facet], "admission plane absent on some delivered rows and their gold fallback");
      delete metadata[counter];
    } else if (!availability.identityComplete) {
      // Delivery attribution is independently measured; only its gold-hit
      // component requires the identity list. Do not discard valid delivery.
      for (const row of Object.values(output[facet])) {
        delete row.gold_hit_count;
        delete row.gold_hit_share;
        delete row.gold_hit_denominator;
      }
      unavailable[`${facet}.gold_hit_share`] = "gold identity measurement absent on some questions";
    }
  }
  if (!availability.identityComplete) delete metadata.gold_hit_count;
  if (stats.planeFirstFields !== stats.deliveredCount) {
    omit(["path_expansion_share"], "first admission plane absent on some delivered rows and their gold fallback");
  }
  if (!constraints.available) omit(["active_constraints_count"], "active constraint total absent or incomplete");
  if (stats.nonMonotonicMissingScores > 0) {
    omit(["non_monotonic_rate"], "delivery scores absent on some questions");
    delete metadata.non_monotonic_count;
  }
  if (Object.keys(unavailable).length > 0) {
    output.metadata.unavailable_metrics = unavailable;
    output.warnings.push(...Object.entries(unavailable).map(([key, reason]) => `${key} unavailable: ${reason}`));
  }
}

function accumulateQuestionStats(questions) {
  const allGold = [];
  const firstAdmitted = createCohortCounters();
  const winningAdmission = createCohortCounters();

  let deliveredCount = 0;
  let goldHitCount = 0;
  let nonMonotonicCount = 0;
  let nonMonotonicEvaluable = 0;
  let nonMonotonicMissingScores = 0;
  let planeFirstFields = 0;
  let planeWinningFields = 0;

  for (const question of questions) {
    const deliveredResults = question.delivered_results;
    const gold = asArray(question?.gold);
    deliveredCount += deliveredResults.length;

    if (deliveredResults.length >= 2) {
      const scores = deliveredResults.map((item) => readNumber(item?.relevance_score));
      if (scores.every((score) => score !== null)) {
        nonMonotonicEvaluable += 1;
        if (isScoreOrderNonMonotonic(scores)) {
          nonMonotonicCount += 1;
        }
      } else {
        nonMonotonicMissingScores += 1;
      }
    }

    const goldSet = new Set(readGoldObjectIds({
      gold_memory_ids: asStringArray(question?.gold_memory_ids),
      gold_evidence_ids: asStringArray(question?.gold_evidence_ids),
      ...(Array.isArray(question?.gold_object_ids)
        ? { gold_object_ids: asStringArray(question.gold_object_ids) } : {})
    }));
    const goldByObjectId = new Map();
    for (const item of gold) {
      const objectId = readString(item?.object_id);
      if (objectId !== null) {
        goldByObjectId.set(objectId, item);
      }
      allGold.push(item);
    }

    for (const result of deliveredResults) {
      const objectId = readString(result?.object_id);
      const goldDiagnostic = objectId === null ? undefined : goldByObjectId.get(objectId);
      const isGoldHit = objectId !== null && goldSet.has(objectId);
      if (isGoldHit) {
        goldHitCount += 1;
      }

      const firstPlane = readPlaneWithPresence(
        result,
        goldDiagnostic,
        "plane_first_admitted"
      );
      if (firstPlane.present) {
        planeFirstFields += 1;
        countPlane(firstAdmitted, firstPlane.value, isGoldHit);
      }

      const winningPlane = readPlaneWithPresence(
        result,
        goldDiagnostic,
        "plane_winning_admission"
      );
      if (winningPlane.present) {
        planeWinningFields += 1;
        countPlane(winningAdmission, winningPlane.value, isGoldHit);
      }
    }
  }

  return {
    allGold,
    firstAdmitted,
    winningAdmission,
    deliveredCount,
    goldHitCount,
    nonMonotonicCount,
    nonMonotonicEvaluable,
    nonMonotonicMissingScores,
    planeFirstFields,
    planeWinningFields
  };
}

function accumulateGoldStats(allGold) {
  const budgetDropCounts = new Map();
  const planeGoldCounts = new Map();
  const planeHitAt5Counts = new Map();

  let budgetDropFieldCount = 0;
  let budgetComplete = true, lexicalComplete = true, coverageComplete = true;
  let highLexicalDemotedCount = 0;
  let highLexicalDenominator = 0;

  for (const gold of allGold) {
    budgetComplete &&= hasOwnField(gold, "budget_drop_reason");
    lexicalComplete &&= hasOwnField(gold, "lexical_rank") && hasOwnField(gold, "final_rank");
    // An explicitly empty plane set contributes no plane regardless of rank.
    coverageComplete &&= hasOwnField(gold, "source_planes") &&
      (gold.source_planes.length === 0 || hasOwnField(gold, "final_rank"));
    if (hasOwnField(gold, "budget_drop_reason")) {
      budgetDropFieldCount += 1;
    }
    const goldFinalRank = readNumber(gold?.final_rank);
    const goldHitAt5 = goldFinalRank !== null && goldFinalRank <= 5;
    for (const plane of new Set(asStringArray(gold?.source_planes))) {
      planeGoldCounts.set(plane, (planeGoldCounts.get(plane) ?? 0) + 1);
      if (goldHitAt5) {
        planeHitAt5Counts.set(plane, (planeHitAt5Counts.get(plane) ?? 0) + 1);
      }
    }
    const budgetDropReason = readString(gold?.budget_drop_reason);
    if (budgetDropReason !== null) {
      budgetDropCounts.set(
        budgetDropReason,
        (budgetDropCounts.get(budgetDropReason) ?? 0) + 1
      );
    }

    const lexicalRank = readNumber(gold?.lexical_rank);
    const finalRank = readNumber(gold?.final_rank);
    if (lexicalRank !== null && finalRank !== null) {
      highLexicalDenominator += 1;
      if (lexicalRank > 0.8 && finalRank > 5) {
        highLexicalDemotedCount += 1;
      }
    }
  }

  return {
    budgetComplete,
    lexicalComplete,
    coverageComplete,
    budgetDropCounts,
    planeGoldCounts,
    planeHitAt5Counts,
    budgetDropFieldCount,
    highLexicalDemotedCount,
    highLexicalDenominator
  };
}

function assignDiagnosticsOutput(output, ctx) {
  const { questions, questionStats, goldStats, activeConstraints } = ctx;
  const allGold = questionStats.allGold;
  const firstRows = buildCohort(questionStats.firstAdmitted, questionStats.goldHitCount);
  const winningRows = buildCohort(questionStats.winningAdmission, questionStats.goldHitCount);

  output.non_monotonic_rate = share(questionStats.nonMonotonicCount, questions.length);
  output.budget_drop_distribution = buildCountDistribution(
    goldStats.budgetDropCounts,
    allGold.length
  );
  output.high_lexical_demoted_rate = share(
    goldStats.highLexicalDemotedCount,
    goldStats.highLexicalDenominator
  );
  output.cohort_first_admitted = firstRows;
  output.cohort_winning_admission = winningRows;
  output.path_expansion_share =
    firstRows.path_expansion?.delivered_share ??
    firstRows.path_expansion?.gold_hit_share ??
    0;
  output.active_constraints_count = activeConstraints.count;
  output.per_plane_recall_coverage = buildPerPlaneRecallCoverage(
    goldStats.planeGoldCounts,
    goldStats.planeHitAt5Counts
  );

  output.metadata.longmemeval = {
    questions_count: questions.length,
    delivered_results_count: questionStats.deliveredCount,
    gold_count: allGold.length,
    gold_hit_count: questionStats.goldHitCount,
    non_monotonic_count: questionStats.nonMonotonicCount,
    non_monotonic_denominator: questions.length,
    non_monotonic_evaluable_questions: questionStats.nonMonotonicEvaluable,
    non_monotonic_missing_score_questions: questionStats.nonMonotonicMissingScores,
    budget_drop_denominator: allGold.length,
    budget_drop_field_count: goldStats.budgetDropFieldCount,
    high_lexical_demoted_count: goldStats.highLexicalDemotedCount,
    high_lexical_demoted_denominator: goldStats.highLexicalDenominator,
    plane_first_admitted_field_count: questionStats.planeFirstFields,
    plane_winning_admission_field_count: questionStats.planeWinningFields
  };
  output.metadata.active_constraints_sources = activeConstraints.sources;
}

function applyControlledReplay(archive, output) {
  const metrics = isRecord(archive?.metrics) ? archive.metrics : {};
  const diagnosticsCount = requiredReplayCount(metrics.diagnostics_count, "diagnostics_count");
  const deliveryCount = requiredReplayCount(metrics.delivery_count, "delivery_count");
  const nonMonotonicCount = requiredReplayCount(metrics.non_monotonic?.count, "non_monotonic.count");
  const highLexicalDemotedCount =
    requiredReplayCount(metrics.high_lexical_demoted?.count, "high_lexical_demoted.count");
  const budgetDropMaxEntries = readNumber(metrics.budget_drop?.max_entries);
  const activeConstraints = countActiveConstraints(archive);

  output.non_monotonic_rate = share(nonMonotonicCount, diagnosticsCount);
  output.high_lexical_demoted_rate = share(
    highLexicalDemotedCount,
    diagnosticsCount
  );
  output.budget_drop_distribution =
    budgetDropMaxEntries === null
      ? {}
      : {
          max_entries: {
            count: budgetDropMaxEntries,
            share: share(budgetDropMaxEntries, diagnosticsCount),
            denominator: diagnosticsCount
          }
        };
  if (activeConstraints.available) output.active_constraints_count = activeConstraints.count;
  else delete output.active_constraints_count;

  output.metadata.controlled_replay = {
    scenarios_count: asArray(archive?.scenarios).length,
    delivery_count: deliveryCount,
    diagnostics_count: diagnosticsCount,
    non_monotonic_count: nonMonotonicCount,
    non_monotonic_denominator: diagnosticsCount,
    high_lexical_demoted_count: highLexicalDemotedCount,
    high_lexical_demoted_denominator: diagnosticsCount,
    budget_drop_denominator: diagnosticsCount
  };
  output.metadata.active_constraints_sources = activeConstraints.sources;

  if (diagnosticsCount === 0) {
    output.warnings.push(
      "controlled replay metrics.diagnostics_count missing or zero; rate metrics set to 0"
    );
  }
  if (budgetDropMaxEntries === null) {
    output.warnings.push(
      "controlled replay metrics.budget_drop.max_entries missing; budget_drop_distribution set to empty"
    );
  }
  output.warnings.push(
    "controlled replay archive has no cohort plane diagnostics; cohort_* metrics set to empty"
  );
  if (!activeConstraints.available) {
    output.warnings.push("active_constraints_count unavailable: total absent or incomplete");
  }
}

function requiredReplayCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`controlled replay requires a measured nonnegative ${field}`);
  }
  return value;
}

// Read the bench-runner's own quality_metrics out of a kpi.json. This keeps
// the four bench surfaces comparable: a kpi.json from any of them yields the
// same per-plane-coverage shape this script also derives from a sidecar.
function applyKpiPayload(archive, output) {
  const quality = QualityMetricsSchema.parse(archive.kpi.quality_metrics);
  // KPI input already owns its measurement status and denominators. Discard
  // diagnostic defaults and copy only validated fields actually present in it;
  // parser defaults are not evidence that a historical field was measured.
  for (const key of ["non_monotonic_rate", "budget_drop_distribution", "high_lexical_demoted_rate",
    "cohort_first_admitted", "cohort_winning_admission", "path_expansion_share",
    "active_constraints_count", "per_plane_recall_coverage"]) delete output[key];
  Object.assign(output, Object.fromEntries(Object.entries(quality)
    .filter(([key]) => hasOwnField(archive.kpi.quality_metrics, key))));
  const diff = archive?.diff_vs_previous;
  output.metadata.kpi_payload = {
    bench_name: readString(archive?.bench_name),
    r_at_5: readNumber(archive?.kpi?.r_at_5),
    r_at_5_delta_pp: isRecord(diff)
      ? readNumber(diff.r_at_5_delta_pp)
      : null,
    previous_run: isRecord(diff) ? readString(diff.previous_run) : null
  };
  const activeConstraints = countActiveConstraints(archive);
  if (activeConstraints.available) output.active_constraints_count = activeConstraints.count;
  output.metadata.active_constraints_sources = activeConstraints.sources;
}
