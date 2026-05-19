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
    result.warnings.push("no readable archive JSON source found; emitting neutral metrics");
  } else {
    const archive = JSON.parse(readFileSync(source.selectedPath, "utf8"));
    result.source.archive_kind = detectArchiveKind(archive, source.selectedPath);
    result.metadata.archive_file = basename(source.selectedPath);
    result.metadata.bench_name = readString(archive?.bench_name);
    result.metadata.run_at = readString(archive?.run_at);
    result.metadata.schema_version = readString(archive?.schema_version);

    if (result.source.archive_kind === "longmemeval-diagnostics") {
      applyLongMemEvalDiagnostics(archive, result);
    } else if (result.source.archive_kind === "controlled-replay") {
      applyControlledReplay(archive, result);
    } else {
      result.warnings.push(
        `unrecognized archive shape in ${source.selectedPath}; emitting neutral metrics`
      );
      applyGenericArchiveMetrics(archive, result);
    }
  }
} catch (error) {
  result.warnings.push(`failed to read archive: ${errorMessage(error)}`);
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
    active_constraints_count: 0
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

function detectArchiveKind(archive, selectedPath) {
  if (Array.isArray(archive?.questions)) return "longmemeval-diagnostics";
  if (
    Array.isArray(archive?.scenarios) &&
    archive?.metrics !== null &&
    typeof archive?.metrics === "object"
  ) {
    return "controlled-replay";
  }
  if (basename(selectedPath) === "longmemeval-diagnostics.json") {
    return "longmemeval-diagnostics";
  }
  if (basename(selectedPath) === "controlled-replay.json") {
    return "controlled-replay";
  }
  return "unknown";
}

function applyLongMemEvalDiagnostics(archive, output) {
  const questions = asArray(archive?.questions);
  const allGold = [];
  const firstAdmitted = createCohortCounters();
  const winningAdmission = createCohortCounters();
  const budgetDropCounts = new Map();

  let deliveredCount = 0;
  let goldHitCount = 0;
  let nonMonotonicCount = 0;
  let nonMonotonicEvaluable = 0;
  let nonMonotonicMissingScores = 0;
  let planeFirstFields = 0;
  let planeWinningFields = 0;
  let budgetDropFieldCount = 0;
  let highLexicalDemotedCount = 0;
  let highLexicalDenominator = 0;

  for (const question of questions) {
    const deliveredResults = asArray(question?.delivered_results);
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

    const goldSet = new Set(asStringArray(question?.gold_memory_ids));
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

  for (const gold of allGold) {
    if (hasOwnField(gold, "budget_drop_reason")) {
      budgetDropFieldCount += 1;
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

  const firstRows = buildCohort(firstAdmitted, goldHitCount);
  const winningRows = buildCohort(winningAdmission, goldHitCount);
  const activeConstraints = countActiveConstraints(archive);

  output.non_monotonic_rate = share(nonMonotonicCount, questions.length);
  output.budget_drop_distribution = buildCountDistribution(
    budgetDropCounts,
    allGold.length
  );
  output.high_lexical_demoted_rate = share(
    highLexicalDemotedCount,
    highLexicalDenominator
  );
  output.cohort_first_admitted = firstRows;
  output.cohort_winning_admission = winningRows;
  output.path_expansion_share =
    firstRows.path_expansion?.delivered_share ??
    firstRows.path_expansion?.gold_hit_share ??
    0;
  output.active_constraints_count = activeConstraints.count;

  output.metadata.longmemeval = {
    questions_count: questions.length,
    delivered_results_count: deliveredCount,
    gold_count: allGold.length,
    gold_hit_count: goldHitCount,
    non_monotonic_count: nonMonotonicCount,
    non_monotonic_denominator: questions.length,
    non_monotonic_evaluable_questions: nonMonotonicEvaluable,
    non_monotonic_missing_score_questions: nonMonotonicMissingScores,
    budget_drop_denominator: allGold.length,
    budget_drop_field_count: budgetDropFieldCount,
    high_lexical_demoted_count: highLexicalDemotedCount,
    high_lexical_demoted_denominator: highLexicalDenominator,
    plane_first_admitted_field_count: planeFirstFields,
    plane_winning_admission_field_count: planeWinningFields
  };
  output.metadata.active_constraints_sources = activeConstraints.sources;

  if (questions.length === 0) {
    output.warnings.push("questions[] missing or empty; non_monotonic_rate set to 0");
  }
  if (deliveredCount > 0 && nonMonotonicEvaluable === 0) {
    output.warnings.push(
      "delivered_results[].relevance_score missing or incomplete; non_monotonic_rate set to 0"
    );
  }
  if (allGold.length > 0 && budgetDropFieldCount === 0) {
    output.warnings.push(
      "gold[].budget_drop_reason missing; budget_drop_distribution set to empty"
    );
  }
  if (highLexicalDenominator === 0) {
    output.warnings.push(
      "no gold rows with numeric lexical_rank and final_rank; high_lexical_demoted_rate set to 0"
    );
  }
  if (planeFirstFields === 0) {
    output.warnings.push(
      "plane_first_admitted missing from delivered_results[]/gold[]; cohort_first_admitted set to empty"
    );
  }
  if (planeWinningFields === 0) {
    output.warnings.push(
      "plane_winning_admission missing from delivered_results[]/gold[]; cohort_winning_admission set to empty"
    );
  }
  if (activeConstraints.sources.length === 0) {
    output.warnings.push(
      "active_constraints[] or active_constraints_count not present; active_constraints_count set to 0"
    );
  }
}

function applyControlledReplay(archive, output) {
  const metrics = isRecord(archive?.metrics) ? archive.metrics : {};
  const diagnosticsCount = readNumber(metrics.diagnostics_count) ?? 0;
  const deliveryCount = readNumber(metrics.delivery_count) ?? 0;
  const nonMonotonicCount = readNumber(metrics.non_monotonic?.count) ?? 0;
  const highLexicalDemotedCount =
    readNumber(metrics.high_lexical_demoted?.count) ?? 0;
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
  output.active_constraints_count = activeConstraints.count;

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
  if (activeConstraints.sources.length === 0) {
    output.warnings.push(
      "active_constraints[] or active_constraints_count not present; active_constraints_count set to 0"
    );
  }
}

function applyGenericArchiveMetrics(archive, output) {
  const activeConstraints = countActiveConstraints(archive);
  output.active_constraints_count = activeConstraints.count;
  output.metadata.active_constraints_sources = activeConstraints.sources;
  if (activeConstraints.sources.length === 0) {
    output.warnings.push(
      "active_constraints[] or active_constraints_count not present; active_constraints_count set to 0"
    );
  }
}

function createCohortCounters() {
  return {
    delivered: new Map(),
    gold: new Map()
  };
}

function countPlane(counters, plane, isGoldHit) {
  const key = plane ?? "null";
  counters.delivered.set(key, (counters.delivered.get(key) ?? 0) + 1);
  if (isGoldHit) {
    counters.gold.set(key, (counters.gold.get(key) ?? 0) + 1);
  }
}

function buildCohort(counters, goldHitCount) {
  const keys = new Set([...counters.delivered.keys(), ...counters.gold.keys()]);
  const deliveredDenominator = [...counters.delivered.values()].reduce(
    (sum, count) => sum + count,
    0
  );
  return Object.fromEntries(
    [...keys]
      .sort((a, b) => {
        const countDelta =
          (counters.delivered.get(b) ?? 0) - (counters.delivered.get(a) ?? 0);
        return countDelta === 0 ? a.localeCompare(b) : countDelta;
      })
      .map((plane) => [
        plane,
        {
          delivered_count: counters.delivered.get(plane) ?? 0,
          delivered_share: share(
            counters.delivered.get(plane) ?? 0,
            deliveredDenominator
          ),
          delivered_denominator: deliveredDenominator,
          gold_hit_count: counters.gold.get(plane) ?? 0,
          gold_hit_share: share(counters.gold.get(plane) ?? 0, goldHitCount),
          gold_hit_denominator: goldHitCount
        }
      ])
  );
}

function buildCountDistribution(counts, denominator) {
  return Object.fromEntries(
    [...counts.entries()]
      .sort((a, b) => {
        const countDelta = b[1] - a[1];
        return countDelta === 0 ? a[0].localeCompare(b[0]) : countDelta;
      })
      .map(([key, count]) => [
        key,
        {
          count,
          share: share(count, denominator),
          denominator
        }
      ])
  );
}

function isScoreOrderNonMonotonic(scores) {
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[i - 1]) {
      return true;
    }
  }
  return false;
}

function readPlaneWithPresence(deliveredResult, goldDiagnostic, field) {
  if (hasOwnField(deliveredResult, field)) {
    return { present: true, value: normalizePlane(deliveredResult?.[field]) };
  }
  if (hasOwnField(goldDiagnostic, field)) {
    return { present: true, value: normalizePlane(goldDiagnostic?.[field]) };
  }
  return { present: false, value: null };
}

function normalizePlane(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function countActiveConstraints(root) {
  const arraySources = [];
  const countSources = [];

  walk(root, "$");

  if (arraySources.length > 0) {
    return {
      count: arraySources.reduce((sum, source) => sum + source.count, 0),
      sources: arraySources
    };
  }

  return {
    count: countSources.reduce((sum, source) => sum + source.count, 0),
    sources: countSources
  };

  function walk(value, path) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;

    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (key === "active_constraints" && Array.isArray(child)) {
        arraySources.push({ path: childPath, count: child.length });
      } else if (key === "active_constraints_count") {
        const count = readNumber(child);
        if (count !== null) {
          countSources.push({ path: childPath, count });
        }
      }
      walk(child, childPath);
    }
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value) {
  return asArray(value).filter((item) => typeof item === "string");
}

function readString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasOwnField(value, field) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, field);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function share(count, total) {
  return total === 0 ? 0 : round(count / total);
}

function round(value) {
  return Number(value.toFixed(6));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
