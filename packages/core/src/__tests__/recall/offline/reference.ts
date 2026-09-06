// Independent C02 policy reference. Derives expected sets from the algorithm
// document, not from production fusion / prefixSK / selectGamma / packet-gain.
import type {
  EvidenceUnit,
  PacketProposal,
  QuerySpec,
  TypedSupportEdge
} from "../../../recall/decision/budget-aware-q/types.js";

export interface ReferenceDecision {
  readonly membership: readonly string[];
  readonly order: readonly string[];
  readonly chargedTokens: number;
  readonly truncated: boolean;
  readonly usedPacketIds: readonly string[];
  readonly satisfiedObligations: number;
  readonly bindingCount: number;
}

type Fr = readonly [bigint, bigint];

function gcd(a0: bigint, b0: bigint): bigint {
  let a = a0 < 0n ? -a0 : a0;
  let b = b0 < 0n ? -b0 : b0;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

function fr(n: bigint | number, d: bigint | number = 1n): Fr {
  let num = BigInt(n);
  let den = BigInt(d);
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return [num / g, den / g];
}

function add(a: Fr, b: Fr): Fr {
  return fr(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
}

function cmp(a: Fr, b: Fr): number {
  const d = a[0] * b[1] - b[0] * a[1];
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

function familyR(unit: EvidenceUnit): Fr {
  let total = fr(0);
  const lexical = unit.familyRanks.lexical;
  const typed = unit.familyRanks.typed_relation;
  const embedding = unit.familyRanks.embedding;
  if (lexical !== undefined && lexical >= 1) total = add(total, fr(1, lexical));
  if (typed !== undefined && typed >= 1) total = add(total, fr(1, typed));
  if (embedding !== undefined && embedding >= 1) total = add(total, fr(1, embedding));
  return total;
}

export function referenceGlobalRank(units: readonly EvidenceUnit[]): ReadonlyMap<string, number> {
  const sorted = [...units].sort((a, b) => {
    const delta = cmp(familyR(b), familyR(a));
    return delta !== 0 ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return new Map(sorted.map((unit, index) => [unit.id, index + 1]));
}

function qCoords(
  spec: QuerySpec,
  units: readonly EvidenceUnit[],
  ranks: ReadonlyMap<string, number>,
  selected: ReadonlySet<string>,
  edges: readonly TypedSupportEdge[]
): { readonly c1: number; readonly c2: number; readonly c3: Fr } {
  let c3 = fr(0n);
  const bindings = new Set<string>();
  for (const id of selected) {
    const rank = ranks.get(id);
    if (rank !== undefined) c3 = add(c3, fr(1n, BigInt(rank)));
    for (const binding of units.find((unit) => unit.id === id)?.answerBindings ?? []) {
      bindings.add(binding);
    }
  }
  let c1 = 0;
  for (const obligation of spec.obligations) {
    if (obligation.supportForm !== "endpoint_path" || !obligation.requiredPredicates.length) continue;
    let endpoints: Set<string> | null = null;
    for (const predicate of obligation.requiredPredicates) {
      endpoints = new Set(edges.filter((edge) => edge.assignmentKey === obligation.assignmentKey &&
        selected.has(edge.resultObjectId) && edge.predicate === predicate &&
        (endpoints === null || endpoints.has(edge.sourceObjectId))).map((edge) => edge.targetObjectId));
    }
    if (endpoints && endpoints.size > 0) c1 += 1;
  }
  return { c1, c2: spec.enumeration ? bindings.size : 0, c3 };
}

function compareQ(
  left: { readonly c1: number; readonly c2: number; readonly c3: Fr },
  right: { readonly c1: number; readonly c2: number; readonly c3: Fr }
): number {
  if (left.c1 !== right.c1) return left.c1 - right.c1;
  if (left.c2 !== right.c2) return left.c2 - right.c2;
  return cmp(left.c3, right.c3);
}

function addedCost(
  spec: QuerySpec,
  units: readonly EvidenceUnit[],
  selected: ReadonlySet<string>,
  added: readonly string[]
): number | null {
  if (added.length === 0 || selected.size + added.length > spec.k) return null;
  if (spec.perDimensionLimits) {
    for (const [dimension, limit] of Object.entries(spec.perDimensionLimits)) {
      if (units.filter((unit) => unit.dimension === dimension &&
          (selected.has(unit.id) || added.includes(unit.id))).length > limit) return null;
    }
  }
  let tokens = 0;
  for (const id of added) {
    const unit = units.find((item) => item.id === id);
    if (unit === undefined || unit.chargedTokens <= 0) return null;
    tokens += unit.chargedTokens;
  }
  if (selected.size === 0) tokens += spec.envelopeBytes;
  return tokens;
}

function densityBetter(
  leftGain: { readonly c1: number; readonly c2: number; readonly c3: Fr },
  leftCost: number,
  leftIds: readonly string[],
  rightGain: { readonly c1: number; readonly c2: number; readonly c3: Fr },
  rightCost: number,
  rightIds: readonly string[]
): boolean {
  const c1 = leftGain.c1 * rightCost - rightGain.c1 * leftCost;
  if (c1 !== 0) return c1 > 0;
  const c2 = leftGain.c2 * rightCost - rightGain.c2 * leftCost;
  if (c2 !== 0) return c2 > 0;
  const left = fr(leftGain.c3[0], leftGain.c3[1] * BigInt(leftCost));
  const right = fr(rightGain.c3[0], rightGain.c3[1] * BigInt(rightCost));
  const c3 = cmp(left, right);
  if (c3 !== 0) return c3 > 0;
  if (leftCost !== rightCost) return leftCost < rightCost;
  const bound = Math.min(leftIds.length, rightIds.length);
  for (let i = 0; i < bound; i += 1) {
    if (leftIds[i] !== rightIds[i]) return leftIds[i]! < rightIds[i]!;
  }
  return leftIds.length < rightIds.length;
}

interface Pick {
  readonly packet: PacketProposal;
  readonly added: readonly string[];
  readonly cost: number;
}

function inspectAll(
  spec: QuerySpec,
  units: readonly EvidenceUnit[],
  ranks: ReadonlyMap<string, number>,
  packets: readonly PacketProposal[],
  edges: readonly TypedSupportEdge[],
  selected: ReadonlySet<string>,
  spent: number,
  work: { value: number },
  bestSingle: { value: Pick | null }
): Pick | "truncated" | null {
  const current = qCoords(spec, units, ranks, selected, edges);
  let best: Pick | null = null;
  let bestGain: { readonly c1: number; readonly c2: number; readonly c3: Fr } | null = null;
  const ordered = [...packets].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, spec.packetM);
  for (const packet of ordered) {
    const width = Math.min(packet.unitIds.length, spec.widthW);
    const edgeWork = spec.obligations.reduce((total, obligation) => total +
      edges.filter((edge) => edge.assignmentKey === obligation.assignmentKey).length *
      (obligation.requiredPredicates.length + 3), 0) * 12 + spec.obligations.length;
    const visit = 5 * (selected.size + width + edgeWork + 1) + width + 1;
    if (work.value + visit > spec.workLimit) return "truncated";
    work.value += visit;
    const added = packet.unitIds.filter((id) => !selected.has(id));
    const cost = addedCost(spec, units, selected, added);
    if (cost === null || spent + cost > spec.tokenBudget) continue;
    if (selected.size === 0) {
      const candidate: Pick = { packet, added, cost };
      const q = qCoords(spec, units, ranks, new Set(added), edges);
      const currentBest = bestSingle.value;
      if (currentBest === null) bestSingle.value = candidate;
      else {
        const currentQ = qCoords(spec, units, ranks, new Set(currentBest.added), edges);
        const delta = compareQ(q, currentQ);
        if (delta > 0 || (delta === 0 && (cost < currentBest.cost ||
          (cost === currentBest.cost && candidate.added.join("\0") < currentBest.added.join("\0"))))) {
          bestSingle.value = candidate;
        }
      }
    }
    const nextSet = new Set(selected);
    for (const id of added) nextSet.add(id);
    const next = qCoords(spec, units, ranks, nextSet, edges);
    const gain = { c1: next.c1 - current.c1, c2: next.c2 - current.c2, c3: add(next.c3, fr(-current.c3[0], current.c3[1])) };
    if (gain.c1 <= 0 && gain.c2 <= 0 && cmp(gain.c3, fr(0n)) <= 0) continue;
    const candidate: Pick = { packet, added, cost };
    if (best === null || bestGain === null || densityBetter(gain, cost, added, bestGain, best.cost, best.added)) {
      best = candidate;
      bestGain = gain;
    }
  }
  return best;
}

function fill(
  spec: QuerySpec,
  units: readonly EvidenceUnit[],
  ranks: ReadonlyMap<string, number>,
  packets: readonly PacketProposal[],
  edges: readonly TypedSupportEdge[],
  seed: ReadonlySet<string>,
  seedCost: number,
  work: { value: number },
  bestSingle: { value: Pick | null }
): { selected: Set<string>; tokens: number; used: string[]; truncated: boolean; firstComplete: boolean } {
  const selected = new Set(seed);
  let tokens = seedCost;
  const used: string[] = [];
  let truncated = false;
  let firstComplete = false;
  while (selected.size < spec.k) {
    const pick = inspectAll(spec, units, ranks, packets, edges, selected, tokens, work, bestSingle);
    if (pick === "truncated") {
      truncated = true;
      break;
    }
    firstComplete = true;
    if (pick === null) break;
    for (const id of pick.added) selected.add(id);
    tokens += pick.cost;
    used.push(pick.packet.id);
  }
  return { selected, tokens, used, truncated, firstComplete };
}

export function referenceSelect(input: {
  readonly spec: QuerySpec;
  readonly units: readonly EvidenceUnit[];
  readonly edges: readonly TypedSupportEdge[];
  readonly packets: readonly PacketProposal[];
}): ReferenceDecision {
  if (input.spec.deliveryPath !== null) {
    return {
      membership: [],
      order: [],
      chargedTokens: 0,
      truncated: false,
      usedPacketIds: [],
      satisfiedObligations: 0,
      bindingCount: 0
    };
  }
  const ranks = referenceGlobalRank(input.units);
  const work = { value: 0 };
  const bestSingle = { value: null as Pick | null };
  const greedy = fill(
    input.spec, input.units, ranks, input.packets, input.edges, new Set(), 0, work, bestSingle
  );
  let selected = greedy.selected;
  let tokens = greedy.tokens;
  let used = greedy.used;
  let truncated = greedy.truncated;
  const single = greedy.firstComplete ? bestSingle.value : null;
  if (single !== null) {
    const greedyQ = qCoords(input.spec, input.units, ranks, selected, input.edges);
    const singleSet = new Set(single.added);
    const singleQ = qCoords(input.spec, input.units, ranks, singleSet, input.edges);
    const delta = compareQ(singleQ, greedyQ);
    const replace = delta > 0 || (delta === 0 && (single.cost < tokens ||
      (single.cost === tokens && [...singleSet].sort().join("\0") < [...selected].sort().join("\0"))));
    if (replace) {
      const refill = fill(
        input.spec, input.units, ranks, input.packets, input.edges, singleSet, single.cost, work, { value: null }
      );
      selected = refill.selected;
      tokens = refill.tokens;
      used = [single.packet.id, ...refill.used];
      truncated = refill.truncated;
    }
  }
  const membership = [...selected].sort();
  const order = [...membership].sort((a, b) => {
    const ra = ranks.get(a) ?? 1e9;
    const rb = ranks.get(b) ?? 1e9;
    return ra !== rb ? ra - rb : a < b ? -1 : a > b ? 1 : 0;
  });
  const fallback = [...order];
  const pending = new Set(order);
  const dependencyOrder: string[] = [];
  while (pending.size) {
    const ready = fallback.find((id) => pending.has(id) && !input.edges.some((edge) =>
      edge.resultObjectId === id && edge.sourceObjectId !== id && pending.has(edge.sourceObjectId)));
    if (!ready) break;
    dependencyOrder.push(ready);
    pending.delete(ready);
  }
  if (!pending.size) order.splice(0, order.length, ...dependencyOrder);
  const q = qCoords(input.spec, input.units, ranks, selected, input.edges);
  return {
    membership,
    order,
    chargedTokens: selected.size === 0 ? 0 : tokens,
    truncated: truncated || input.packets.length > input.spec.packetM,
    usedPacketIds: used,
    satisfiedObligations: q.c1,
    bindingCount: q.c2
  };
}
