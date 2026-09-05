import { emitPackets, globalRanks } from "./field.js";
import {
  BUDGET_AWARE_Q_AUTHORITY,
  compareIdentity,
  compareIdentitySequence,
  type DecisionResult,
  type EvidenceUnit,
  type PacketProposal,
  type QuerySpec,
  type TypedSupportEdge
} from "./types.js";

interface Frac {
  readonly n: bigint;
  readonly d: bigint;
}

interface Quality {
  readonly c1: number;
  readonly c2: number;
  readonly c3: Frac;
}

interface ScanPick {
  readonly packet: PacketProposal;
  readonly added: readonly string[];
  readonly cost: number;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a === 0n ? 1n : a;
}

function frac(n: bigint | number, d: bigint | number = 1n): Frac {
  let num = typeof n === "number" ? BigInt(n) : n;
  let den = typeof d === "number" ? BigInt(d) : d;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  if (den === 0n) throw new Error("budget-aware-q fraction denominator is zero");
  const divisor = gcd(num, den);
  return { n: num / divisor, d: den / divisor };
}

function addFrac(left: Frac, right: Frac): Frac {
  return frac(left.n * right.d + right.n * left.d, left.d * right.d);
}

function cmpFrac(left: Frac, right: Frac): number {
  const delta = left.n * right.d - right.n * left.d;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

function compareQuality(left: Quality, right: Quality): number {
  if (left.c1 !== right.c1) return left.c1 - right.c1;
  if (left.c2 !== right.c2) return left.c2 - right.c2;
  return cmpFrac(left.c3, right.c3);
}

function compareDensity(left: ScanPick, right: ScanPick, leftGain: Quality, rightGain: Quality): number {
  const costLeft = BigInt(left.cost);
  const costRight = BigInt(right.cost);
  const c1 = leftGain.c1 * right.cost - rightGain.c1 * left.cost;
  if (c1 !== 0) return c1;
  const c2 = leftGain.c2 * right.cost - rightGain.c2 * left.cost;
  if (c2 !== 0) return c2;
  const c3 = cmpFrac(
    frac(leftGain.c3.n * costRight, leftGain.c3.d * costLeft),
    frac(rightGain.c3.n * costLeft, rightGain.c3.d * costRight)
  );
  if (c3 !== 0) return c3;
  if (left.cost !== right.cost) return right.cost - left.cost;
  return compareIdentitySequence(left.added, right.added);
}

function unitIndex(units: readonly EvidenceUnit[]): ReadonlyMap<string, EvidenceUnit> {
  return new Map(units.map((unit) => [unit.id, unit]));
}

function chargeOf(units: readonly EvidenceUnit[], ids: readonly string[], envelope: number, nonempty: boolean): number {
  const byId = unitIndex(units);
  let tokens = 0;
  for (const id of ids) {
    const unit = byId.get(id);
    if (unit === undefined) throw new Error(`budget-aware-q missing cost for ${id}`);
    if (unit.chargedTokens <= 0) throw new Error(`budget-aware-q zero charge for new entry ${id}`);
    tokens += unit.chargedTokens;
  }
  return tokens + (nonempty && ids.length > 0 ? envelope : 0);
}

function qualityOf(
  spec: QuerySpec,
  units: readonly EvidenceUnit[],
  ranks: ReadonlyMap<string, number>,
  selected: ReadonlySet<string>,
  edges: readonly TypedSupportEdge[]
): Quality {
  let c3 = frac(0n);
  const bindings = new Set<string>();
  for (const id of selected) {
    const rank = ranks.get(id);
    if (rank === undefined) continue;
    c3 = addFrac(c3, frac(1n, BigInt(rank)));
    const unit = units.find((item) => item.id === id);
    for (const binding of unit?.answerBindings ?? []) bindings.add(binding);
  }
  let c1 = 0;
  for (const obligation of spec.obligations) {
    const present = new Set(
      edges.filter((edge) =>
        edge.assignmentKey === obligation.assignmentKey && selected.has(edge.resultObjectId)
      ).map((edge) => edge.predicate)
    );
    if (obligation.requiredPredicates.every((predicate) => present.has(predicate))) c1 += 1;
  }
  return { c1, c2: spec.enumeration ? bindings.size : 0, c3 };
}

function incremental(
  selected: ReadonlySet<string>,
  packet: PacketProposal
): readonly string[] {
  return Object.freeze(packet.unitIds.filter((id) => !selected.has(id)));
}

function fits(
  spec: QuerySpec,
  units: readonly EvidenceUnit[],
  selected: ReadonlySet<string>,
  added: readonly string[],
  currentTokens: number
): { readonly cost: number } | null {
  if (added.length === 0) return null;
  if (selected.size + added.length > spec.k) return null;
  const cost = chargeOf(units, added, spec.envelopeBytes, selected.size === 0);
  if (currentTokens + cost > spec.tokenBudget) return null;
  return { cost };
}

function inspectionWork(spec: QuerySpec, packet: PacketProposal): number {
  return Math.min(packet.unitIds.length, spec.widthW) + 1;
}

function considerBestSingle(
  spec: QuerySpec,
  units: readonly EvidenceUnit[],
  ranks: ReadonlyMap<string, number>,
  edges: readonly TypedSupportEdge[],
  selected: ReadonlySet<string>,
  packet: PacketProposal,
  added: readonly string[],
  cost: number,
  current: ScanPick | null
): ScanPick | null {
  if (selected.size !== 0) return current;
  const q = qualityOf(spec, units, ranks, new Set(added), edges);
  const candidate: ScanPick = { packet, added, cost };
  if (current === null) return candidate;
  const currentQ = qualityOf(spec, units, ranks, new Set(current.added), edges);
  const qDelta = compareQuality(q, currentQ);
  if (qDelta > 0 || (qDelta === 0 && (cost < current.cost ||
    (cost === current.cost && compareIdentitySequence(added, current.added) < 0)))) {
    return candidate;
  }
  return current;
}

function scanBestAddition(
  spec: QuerySpec,
  units: readonly EvidenceUnit[],
  ranks: ReadonlyMap<string, number>,
  packets: readonly PacketProposal[],
  edges: readonly TypedSupportEdge[],
  selected: ReadonlySet<string>,
  currentTokens: number,
  workUsed: number,
  bestSingle: ScanPick | null
): {
  readonly pick: ScanPick | null;
  readonly workUsed: number;
  readonly truncated: boolean;
  readonly bestSingle: ScanPick | null;
} {
  let pick: ScanPick | null = null;
  let pickGain: Quality | null = null;
  let work = workUsed;
  let trackedSingle = bestSingle;
  const currentQ = qualityOf(spec, units, ranks, selected, edges);
  for (const packet of packets) {
    const costWork = inspectionWork(spec, packet);
    if (work + costWork > spec.workLimit) {
      return { pick: null, workUsed: work, truncated: true, bestSingle: trackedSingle };
    }
    work += costWork;
    const added = incremental(selected, packet);
    const fit = fits(spec, units, selected, added, currentTokens);
    if (fit === null) continue;
    trackedSingle = considerBestSingle(
      spec, units, ranks, edges, selected, packet, added, fit.cost, trackedSingle
    );
    const next = new Set(selected);
    for (const id of added) next.add(id);
    const nextQ = qualityOf(spec, units, ranks, next, edges);
    const gain: Quality = {
      c1: nextQ.c1 - currentQ.c1,
      c2: nextQ.c2 - currentQ.c2,
      c3: addFrac(nextQ.c3, frac(-currentQ.c3.n, currentQ.c3.d))
    };
    if (gain.c1 <= 0 && gain.c2 <= 0 && cmpFrac(gain.c3, frac(0n)) <= 0) continue;
    const candidate: ScanPick = { packet, added, cost: fit.cost };
    if (pick === null || pickGain === null || compareDensity(candidate, pick, gain, pickGain) > 0) {
      pick = candidate;
      pickGain = gain;
    }
  }
  return { pick, workUsed: work, truncated: false, bestSingle: trackedSingle };
}

function greedyFrom(
  spec: QuerySpec,
  units: readonly EvidenceUnit[],
  ranks: ReadonlyMap<string, number>,
  packets: readonly PacketProposal[],
  edges: readonly TypedSupportEdge[],
  seed: ReadonlySet<string>,
  seedTokens: number,
  workUsed: number,
  initialBestSingle: ScanPick | null = null
): {
  readonly selected: ReadonlySet<string>;
  readonly tokens: number;
  readonly workUsed: number;
  readonly truncated: boolean;
  readonly used: string[];
  readonly bestSingle: ScanPick | null;
  readonly firstScanComplete: boolean;
} {
  const selected = new Set(seed);
  let tokens = seedTokens;
  let work = workUsed;
  let truncated = false;
  let bestSingle = initialBestSingle;
  let firstScanComplete = false;
  const used: string[] = [];
  while (selected.size < spec.k) {
    const scan = scanBestAddition(
      spec, units, ranks, packets, edges, selected, tokens, work, bestSingle
    );
    work = scan.workUsed;
    bestSingle = scan.bestSingle;
    if (scan.truncated) {
      truncated = true;
      break;
    }
    firstScanComplete = true;
    if (scan.pick === null) break;
    for (const id of scan.pick.added) selected.add(id);
    tokens += scan.pick.cost;
    used.push(scan.pick.packet.id);
  }
  return { selected, tokens, workUsed: work, truncated, used, bestSingle, firstScanComplete };
}

function orderSelected(
  ids: readonly string[],
  ranks: ReadonlyMap<string, number>,
  edges: readonly TypedSupportEdge[]
): readonly string[] {
  const selected = new Set(ids);
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of ids) {
    incoming.set(id, 0);
    outgoing.set(id, []);
  }
  for (const edge of edges) {
    if (!selected.has(edge.resultObjectId) || !selected.has(edge.sourceObjectId)) continue;
    if (edge.resultObjectId === edge.sourceObjectId) continue;
    outgoing.get(edge.sourceObjectId)?.push(edge.resultObjectId);
    incoming.set(edge.resultObjectId, (incoming.get(edge.resultObjectId) ?? 0) + 1);
  }
  const ready = [...ids].filter((id) => (incoming.get(id) ?? 0) === 0)
    .sort((left, right) => rankThenId(left, right, ranks));
  const ordered: string[] = [];
  const remaining = new Set(ids);
  while (ready.length > 0) {
    const node = ready.shift()!;
    if (!remaining.delete(node)) continue;
    ordered.push(node);
    for (const next of outgoing.get(node) ?? []) {
      const degree = (incoming.get(next) ?? 1) - 1;
      incoming.set(next, degree);
      if (degree === 0) ready.push(next);
      ready.sort((left, right) => rankThenId(left, right, ranks));
    }
  }
  if (remaining.size > 0) {
    return Object.freeze([...ids].sort((left, right) => rankThenId(left, right, ranks)));
  }
  return Object.freeze(ordered);
}

function rankThenId(left: string, right: string, ranks: ReadonlyMap<string, number>): number {
  const leftRank = ranks.get(left) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = ranks.get(right) ?? Number.MAX_SAFE_INTEGER;
  return leftRank !== rightRank ? leftRank - rightRank : compareIdentity(left, right);
}

function actualBytesOf(units: readonly EvidenceUnit[], ids: readonly string[]): number {
  const byId = unitIndex(units);
  let bytes = 0;
  for (const id of ids) bytes += byId.get(id)?.framedBytes ?? 0;
  return bytes;
}

export function selectBudgetAwareQ(input: {
  readonly spec: QuerySpec;
  readonly digest: string;
  readonly units: readonly EvidenceUnit[];
  readonly edges: readonly TypedSupportEdge[];
  readonly packets?: readonly PacketProposal[];
}): Omit<DecisionResult, "claims"> {
  if (input.spec.deliveryPath === "legacy") {
    return Object.freeze({
      ranking_authority: BUDGET_AWARE_Q_AUTHORITY,
      membership: Object.freeze([]),
      order: Object.freeze([]),
      chargedTokens: 0,
      actualBytes: 0,
      truncated: false,
      selectionCount: 0,
      querySpecDigest: input.digest,
      satisfiedObligations: 0,
      bindingCount: 0,
      usedPacketIds: Object.freeze([])
    });
  }
  const ranks = globalRanks(input.units);
  const packets = input.packets ?? emitPackets(input.spec, input.units.map((unit) => unit.id), input.edges);
  const orderedPackets = [...packets].sort((left, right) => compareIdentity(left.id, right.id));
  const greedy = greedyFrom(
    input.spec, input.units, ranks, orderedPackets, input.edges, new Set(), 0, 0
  );
  let selected = greedy.selected;
  let tokens = greedy.tokens;
  let truncated = greedy.truncated;
  let used = [...greedy.used];
  const bestSingle = greedy.firstScanComplete ? greedy.bestSingle : null;
  if (bestSingle !== null) {
    const greedyQ = qualityOf(input.spec, input.units, ranks, selected, input.edges);
    const singleSet = new Set(bestSingle.added);
    const singleQ = qualityOf(input.spec, input.units, ranks, singleSet, input.edges);
    const qDelta = compareQuality(singleQ, greedyQ);
    const replace = qDelta > 0 || (qDelta === 0 && (bestSingle.cost < tokens ||
      (bestSingle.cost === tokens && compareIdentitySequence(
        [...singleSet].sort(compareIdentity),
        [...selected].sort(compareIdentity)
      ) < 0)));
    if (replace) {
      const refill = greedyFrom(
        input.spec, input.units, ranks, orderedPackets, input.edges,
        singleSet, bestSingle.cost, greedy.workUsed
      );
      selected = refill.selected;
      tokens = refill.tokens;
      truncated = refill.truncated;
      used = [bestSingle.packet.id, ...refill.used];
    }
  }
  const membership = Object.freeze([...selected].sort(compareIdentity));
  const order = orderSelected(membership, ranks, input.edges);
  const q = qualityOf(input.spec, input.units, ranks, selected, input.edges);
  return Object.freeze({
    ranking_authority: BUDGET_AWARE_Q_AUTHORITY,
    membership,
    order,
    chargedTokens: selected.size === 0 ? 0 : tokens,
    actualBytes: actualBytesOf(input.units, order),
    truncated,
    selectionCount: 1,
    querySpecDigest: input.digest,
    satisfiedObligations: q.c1,
    bindingCount: q.c2,
    usedPacketIds: Object.freeze(used)
  });
}
