// Tiny exhaustive set oracle. Tests/offline only; never a production selector.

export interface OraclePacket {
  readonly id: string;
  readonly units: readonly string[];
  readonly cost: number;
  readonly rank: number;
}

export interface OracleSet {
  readonly ids: readonly string[];
  readonly units: readonly string[];
  readonly cost: number;
  readonly coverage: number;
  readonly q3: number;
}

function subsetIds(packets: readonly OraclePacket[], mask: number): OraclePacket[] {
  return packets.filter((_, index) => ((mask >> index) & 1) === 1);
}

function evaluate(packets: readonly OraclePacket[], k: number, budget: number, envelope: number): OracleSet {
  const units = [...new Set(packets.flatMap((packet) => packet.units))].sort();
  if (units.length > k) {
    return { ids: packets.map((packet) => packet.id), units, cost: Number.POSITIVE_INFINITY, coverage: 0, q3: 0 };
  }
  const cost = packets.reduce((sum, packet) => sum + packet.cost, 0) + (packets.length > 0 ? envelope : 0);
  if (cost > budget) {
    return { ids: packets.map((packet) => packet.id), units, cost: Number.POSITIVE_INFINITY, coverage: 0, q3: 0 };
  }
  const q3 = units.reduce((sum, unit) => {
    const owner = packets.find((packet) => packet.units.includes(unit));
    return owner === undefined ? sum : sum + 1 / owner.rank;
  }, 0);
  return {
    ids: packets.map((packet) => packet.id).sort(),
    units,
    cost,
    coverage: units.length,
    q3
  };
}

export function enumerateFeasibleSets(
  packets: readonly OraclePacket[],
  k: number,
  budget: number,
  envelope = 0
): readonly OracleSet[] {
  if (packets.length > 12) throw new Error("oracle domain too large");
  const out: OracleSet[] = [];
  const limit = 1 << packets.length;
  for (let mask = 0; mask < limit; mask += 1) {
    const chosen = subsetIds(packets, mask);
    const evaluated = evaluate(chosen, k, budget, envelope);
    if (Number.isFinite(evaluated.cost)) out.push(evaluated);
  }
  return Object.freeze(out);
}

export function globalOptimum(
  packets: readonly OraclePacket[],
  k: number,
  budget: number,
  objective: "coverage" | "q3",
  envelope = 0
): OracleSet {
  const feasible = enumerateFeasibleSets(packets, k, budget, envelope);
  return [...feasible].sort((left, right) => {
    const primary = objective === "coverage"
      ? right.coverage - left.coverage
      : right.q3 - left.q3;
    if (primary !== 0) return primary;
    if (left.cost !== right.cost) return left.cost - right.cost;
    return left.ids.join(",").localeCompare(right.ids.join(","));
  })[0] ?? { ids: [], units: [], cost: 0, coverage: 0, q3: 0 };
}

export function prefixByRank(
  packets: readonly OraclePacket[],
  k: number,
  budget: number,
  envelope = 0
): OracleSet {
  const ordered = [...packets].sort((left, right) =>
    left.rank !== right.rank ? left.rank - right.rank : left.id.localeCompare(right.id)
  );
  const chosen: OraclePacket[] = [];
  for (const packet of ordered) {
    const next = [...chosen, packet];
    const evaluated = evaluate(next, k, budget, envelope);
    if (!Number.isFinite(evaluated.cost)) continue;
    chosen.push(packet);
  }
  return evaluate(chosen, k, budget, envelope);
}

export function reportGap(targetIds: readonly string[], optimum: OracleSet): {
  readonly target: readonly string[];
  readonly optimum: readonly string[];
  readonly equal: boolean;
} {
  const target = [...targetIds].sort();
  const opt = [...optimum.ids].sort();
  return {
    target,
    optimum: opt,
    equal: target.length === opt.length && target.every((id, index) => id === opt[index])
  };
}
