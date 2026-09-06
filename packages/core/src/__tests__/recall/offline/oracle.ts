// Historical coverage illustration: packet costs and packet ranks are not unit-set Q.
// The independent unit-set oracle below models union charges explicitly.

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


export interface OracleUnit {
  readonly id: string;
  readonly rank: number;
  readonly charge: number;
  readonly bindings: readonly string[];
}

export function enumerateUnitSets(input: {
  readonly units: readonly OracleUnit[];
  readonly k: number;
  readonly budget: number;
  readonly envelope: number;
  readonly enumeration: boolean;
  readonly witnesses: readonly (readonly string[])[];
}) {
  if (input.units.length > 12) throw new Error("unit oracle domain too large");
  if (new Set(input.units.map((unit) => unit.id)).size !== input.units.length) throw new Error("duplicate oracle identity");
  const results: { ids: string[]; charge: number; obligations: number; bindings: number; reciprocal: readonly [bigint, bigint] }[] = [];
  for (let mask = 0; mask < 2 ** input.units.length; mask += 1) {
    const chosen = input.units.filter((_, index) => (mask & 2 ** index) !== 0);
    const charge = chosen.reduce((sum, unit) => sum + unit.charge, chosen.length ? input.envelope : 0);
    if (chosen.length > input.k || charge > input.budget) continue;
    const ids = chosen.map((unit) => unit.id).sort();
    let numerator = 0n;
    let denominator = 1n;
    for (const unit of chosen) {
      if (!Number.isSafeInteger(unit.rank) || unit.rank < 1 || unit.charge <= 0) throw new Error("invalid oracle unit");
      numerator = numerator * BigInt(unit.rank) + denominator;
      denominator *= BigInt(unit.rank);
    }
    results.push({ ids, charge,
      obligations: input.witnesses.filter((witness) => witness.length > 0 && witness.every((id) => ids.includes(id))).length,
      bindings: input.enumeration ? new Set(chosen.flatMap((unit) => unit.bindings)).size : 0,
      reciprocal: [numerator, denominator] });
  }
  return results.sort((a, b) => {
    if (a.obligations !== b.obligations) return b.obligations - a.obligations;
    if (a.bindings !== b.bindings) return b.bindings - a.bindings;
    const delta = b.reciprocal[0] * a.reciprocal[1] - a.reciprocal[0] * b.reciprocal[1];
    if (delta) return delta < 0n ? -1 : 1;
    return a.charge - b.charge || (a.ids.join("\0") < b.ids.join("\0") ? -1 : 1);
  });
}
