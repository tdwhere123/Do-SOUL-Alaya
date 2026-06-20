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

// invariant: plane keys are whatever source_planes the gold candidates
// exposed; no static plane list. Mirrors diagnostics.ts buildPerPlaneRecallCoverage.
export function buildPerPlaneRecallCoverage(goldCounts, hitAt5Counts) {
  return Object.fromEntries(
    [...goldCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([plane, goldCount]) => {
        const hitCount = hitAt5Counts.get(plane) ?? 0;
        return [
          plane,
          {
            gold_count: goldCount,
            hit_at_5_count: hitCount,
            hit_at_5_rate: share(hitCount, goldCount)
          }
        ];
      })
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

export function isScoreOrderNonMonotonic(scores) {
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[i - 1]) {
      return true;
    }
  }
  return false;
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

