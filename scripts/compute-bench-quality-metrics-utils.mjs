export function createCohortCounters() {
  return {
    delivered: new Map(),
    gold: new Map()
  };
}

export function countPlane(counters, plane, isGoldHit) {
  const key = plane ?? "null";
  counters.delivered.set(key, (counters.delivered.get(key) ?? 0) + 1);
  if (isGoldHit) {
    counters.gold.set(key, (counters.gold.get(key) ?? 0) + 1);
  }
}

export function buildCohort(counters, goldHitCount) {
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

// Script presentation only: keep the diagnostic owner's plane keys/counts and
// six-decimal-round its hit_at_5_rate. Division and zero-denominator policy stay
// on the owner.
export function roundPerPlaneRecallCoverageRates(coverage) {
  return Object.fromEntries(
    Object.entries(coverage).map(([plane, row]) => [
      plane,
      {
        gold_count: row.gold_count,
        hit_at_5_count: row.hit_at_5_count,
        hit_at_5_rate: round(row.hit_at_5_rate)
      }
    ])
  );
}

export function buildCountDistribution(counts, denominator) {
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

export function readPlaneWithPresence(deliveredResult, goldDiagnostic, field) {
  if (hasOwnField(deliveredResult, field)) {
    return { present: true, value: normalizePlane(deliveredResult?.[field]) };
  }
  if (hasOwnField(goldDiagnostic, field)) {
    return { present: true, value: normalizePlane(goldDiagnostic?.[field]) };
  }
  return { present: false, value: null };
}

export function normalizePlane(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function countActiveConstraints(root) {
  const arraySources = [];
  const countSources = [];
  let incomplete = false;

  walk(root, "$");

  // Preserve the historical array-over-count precedence and summation. Presence
  // on one question does not prove a complete archive population. An explicit
  // nullable count or incomplete receipt cannot be replaced by an observed list.
  const sources = arraySources.length > 0 ? arraySources : countSources;
  const populationCovered = !Array.isArray(root?.questions) ||
    sources.some(source => !source.path.startsWith("$.questions[")) ||
    root.questions.every((_question, index) => sources.some(source =>
      source.path.startsWith(`$.questions[${index}].`)));
  return {
    count: sources.reduce((sum, source) => sum + source.count, 0),
    sources,
    available: sources.length > 0 && !incomplete && populationCovered
  };

  function walk(value, path) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;

    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (key === "active_constraints") {
        if (!Array.isArray(child) || !child.every(isRecord)) {
          throw new Error(`invalid active_constraints at ${childPath}`);
        }
        arraySources.push({ path: childPath, count: child.length });
      } else if (key === "active_constraints_count") {
        if (child === null) incomplete = true;
        else if (!Number.isSafeInteger(child) || child < 0) {
          throw new Error(`invalid active_constraints_count at ${childPath}`);
        } else countSources.push({ path: childPath, count: child });
      } else if (key === "active_constraints_completeness") {
        if (child !== "complete" && child !== "incomplete") {
          throw new Error(`invalid active_constraints_completeness at ${childPath}`);
        }
        incomplete ||= child === "incomplete";
      }
      walk(child, childPath);
    }
  }
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function asStringArray(value) {
  return asArray(value).filter((item) => typeof item === "string");
}

export function readString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function hasOwnField(value, field) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, field);
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function share(count, total) {
  return total === 0 ? 0 : round(count / total);
}

export function round(value) {
  return Number(value.toFixed(6));
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

