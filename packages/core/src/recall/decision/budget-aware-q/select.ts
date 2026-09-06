import { preRenderEntry } from "./render.js";
import { detachInput } from "./capture-data.js";
import { SelectionSupportIndex } from "./support.js";
import { emitPackets, globalRanks } from "./field.js";
import {
  BUDGET_AWARE_Q_AUTHORITY,
  compareIdentity,
  compareIdentitySequence,
  type DecisionResult,
  type DecisionPhaseCounters,
  type DecisionWorkPhase,
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

type PhaseCounters = Record<DecisionWorkPhase, DecisionPhaseCounters>;

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
    frac(leftGain.c3.n, leftGain.c3.d * costLeft),
    frac(rightGain.c3.n, rightGain.c3.d * costRight)
  );
  if (c3 !== 0) return c3;
  if (left.cost !== right.cost) return right.cost - left.cost;
  return -compareIdentitySequence(left.added, right.added);
}

function unitIndex(units: readonly EvidenceUnit[], work: DecisionPhaseCounters): ReadonlyMap<string, EvidenceUnit> {
  return new Map(units.map((unit) => { work.rowVisits += 1; return [unit.id, unit]; }));
}

function chargeOf(units: ReadonlyMap<string, EvidenceUnit>, ids: readonly string[], envelope: number, nonempty: boolean, work: DecisionPhaseCounters): number {
  const byId = units;
  let tokens = 0;
  for (const id of ids) {
    work.rowVisits += 1;
    const unit = byId.get(id);
    if (unit === undefined) throw new Error(`budget-aware-q missing cost for ${id}`);
    if (unit.chargedTokens <= 0) throw new Error(`budget-aware-q zero charge for new entry ${id}`);
    tokens += unit.chargedTokens;
  }
  return tokens + (nonempty && ids.length > 0 ? envelope : 0);
}

function qualityOf(
  spec: QuerySpec,
  units: ReadonlyMap<string, EvidenceUnit>,
  ranks: ReadonlyMap<string, number>,
  selected: ReadonlySet<string>,
  edges: SelectionSupportIndex,
  work: DecisionPhaseCounters
): Quality {
  work.qualityCalls += 1;
  let c3 = frac(0n);
  const bindings = new Set<string>();
  for (const id of selected) {
    work.rowVisits += 1;
    const rank = ranks.get(id);
    if (rank === undefined) continue;
    c3 = addFrac(c3, frac(1n, BigInt(rank)));
    const unit = units.get(id);
    for (const binding of unit?.answerBindings ?? []) { work.rowVisits += 1; bindings.add(binding); }
  }
  let c1 = 0;
  for (const obligation of spec.obligations) {
    work.rowVisits += 1;
    if (edges.witness(obligation, selected, work)) c1 += 1;
  }
  return { c1, c2: spec.enumeration ? bindings.size : 0, c3 };
}

function incremental(
  selected: ReadonlySet<string>,
  packet: PacketProposal,
  work: DecisionPhaseCounters
): readonly string[] {
  return Object.freeze(packet.unitIds.filter((id) => { work.rowVisits += 1; return !selected.has(id); }));
}

function fits(
  spec: QuerySpec,
  units: ReadonlyMap<string, EvidenceUnit>,
  selected: ReadonlySet<string>,
  added: readonly string[],
  currentTokens: number,
  work: DecisionPhaseCounters
): { readonly cost: number } | null {
  if (added.length === 0) return null;
  if (selected.size + added.length > spec.k) return null;
  if (spec.perDimensionLimits) {
    const counts = new Map<string, number>();
    for (const id of [...selected, ...added]) {
      work.rowVisits += 1;
      const dimension = units.get(id)?.dimension;
      if (dimension === undefined) throw new Error("missing unit dimension");
      const count = (counts.get(dimension) ?? 0) + 1;
      if (count > (spec.perDimensionLimits[dimension] ?? Infinity)) return null;
      counts.set(dimension, count);
    }
  }
  const cost = chargeOf(units, added, spec.envelopeBytes, selected.size === 0, work);
  if (currentTokens + cost > spec.tokenBudget) return null;
  return { cost };
}

function inspectionWork(spec: QuerySpec, packet: PacketProposal, selected: ReadonlySet<string>, support: SelectionSupportIndex): number {
  const width = Math.min(packet.unitIds.length, spec.widthW);
  return 5 * (selected.size + width + support.evaluationWork + 1) + width + 1;
}

function considerBestSingle(
  spec: QuerySpec,
  units: ReadonlyMap<string, EvidenceUnit>,
  ranks: ReadonlyMap<string, number>,
  edges: SelectionSupportIndex,
  selected: ReadonlySet<string>,
  packet: PacketProposal,
  added: readonly string[],
  cost: number,
  current: ScanPick | null,
  work: DecisionPhaseCounters
): ScanPick | null {
  if (selected.size !== 0) return current;
  const q = qualityOf(spec, units, ranks, new Set(added), edges, work);
  const candidate: ScanPick = { packet, added, cost };
  if (current === null) return candidate;
  const currentQ = qualityOf(spec, units, ranks, new Set(current.added), edges, work);
  work.comparisons += 1;
  const qDelta = compareQuality(q, currentQ);
  if (qDelta > 0 || (qDelta === 0 && (cost < current.cost ||
    (cost === current.cost && compareIdentitySequence(added, current.added) < 0)))) {
    return candidate;
  }
  return current;
}

function scanBestAddition(
  spec: QuerySpec,
  units: ReadonlyMap<string, EvidenceUnit>,
  ranks: ReadonlyMap<string, number>,
  packets: readonly PacketProposal[],
  edges: SelectionSupportIndex,
  selected: ReadonlySet<string>,
  currentTokens: number,
  workUsed: number,
  bestSingle: ScanPick | null,
  phases: PhaseCounters
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
  const currentQ = qualityOf(spec, units, ranks, selected, edges, phases.scanBaseline);
  for (const packet of packets) {
    phases.decision.rowVisits += 1;
    phases.decision.packetInspections += 1;
    const costWork = inspectionWork(spec, packet, selected, edges);
    if (work + costWork > spec.workLimit) {
      return { pick: null, workUsed: work, truncated: true, bestSingle: trackedSingle };
    }
    work += costWork;
    const added = incremental(selected, packet, phases.decision);
    const fit = fits(spec, units, selected, added, currentTokens, phases.decision);
    if (fit === null) continue;
    trackedSingle = considerBestSingle(
      spec, units, ranks, edges, selected, packet, added, fit.cost, trackedSingle, phases.decision
    );
    const next = new Set(selected);
    for (const id of added) { phases.decision.rowVisits += 1; next.add(id); }
    const nextQ = qualityOf(spec, units, ranks, next, edges, phases.decision);
    const gain: Quality = {
      c1: nextQ.c1 - currentQ.c1,
      c2: nextQ.c2 - currentQ.c2,
      c3: addFrac(nextQ.c3, frac(-currentQ.c3.n, currentQ.c3.d))
    };
    if (gain.c1 <= 0 && gain.c2 <= 0 && cmpFrac(gain.c3, frac(0n)) <= 0) continue;
    const candidate: ScanPick = { packet, added, cost: fit.cost };
    if (pick !== null && pickGain !== null) phases.decision.comparisons += 1;
    if (pick === null || pickGain === null || compareDensity(candidate, pick, gain, pickGain) > 0) {
      pick = candidate;
      pickGain = gain;
    }
  }
  return { pick, workUsed: work, truncated: false, bestSingle: trackedSingle };
}

function greedyFrom(
  spec: QuerySpec,
  units: ReadonlyMap<string, EvidenceUnit>,
  ranks: ReadonlyMap<string, number>,
  packets: readonly PacketProposal[],
  edges: SelectionSupportIndex,
  seed: ReadonlySet<string>,
  seedTokens: number,
  workUsed: number,
  initialBestSingle: ScanPick | null,
  phases: PhaseCounters
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
      spec, units, ranks, packets, edges, selected, tokens, work, bestSingle, phases
    );
    work = scan.workUsed;
    bestSingle = scan.bestSingle;
    if (scan.truncated) {
      truncated = true;
      break;
    }
    firstScanComplete = true;
    if (scan.pick === null) break;
    for (const id of scan.pick.added) { phases.decision.rowVisits += 1; selected.add(id); }
    tokens += scan.pick.cost;
    used.push(scan.pick.packet.id);
  }
  return { selected, tokens, workUsed: work, truncated, used, bestSingle, firstScanComplete };
}

function orderSelected(
  ids: readonly string[],
  ranks: ReadonlyMap<string, number>,
  obligations: QuerySpec["obligations"],
  support: SelectionSupportIndex,
  work: DecisionPhaseCounters
): readonly string[] {
  const compare = (a: string, b: string): number => { work.comparisons += 1; return rankThenId(a, b, ranks); };
  const selected = new Set(ids);
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();
  for (const id of ids) {
    work.rowVisits += 1;
    incoming.set(id, 0);
    outgoing.set(id, new Set());
  }
  for (const obligation of obligations) {
    work.rowVisits += 1;
    const witness = support.witness(obligation, selected, work);
    for (let index = 1; index < (witness?.length ?? 0); index += 1) {
      work.rowVisits += 1;
      const from = witness![index - 1]!.resultObjectId;
      const to = witness![index]!.resultObjectId;
      if (from === to || outgoing.get(from)!.has(to)) continue;
      outgoing.get(from)!.add(to);
      incoming.set(to, incoming.get(to)! + 1);
    }
  }
  const ready = [...ids].filter((id) => { work.rowVisits += 1; return (incoming.get(id) ?? 0) === 0; }).sort(compare);
  const ordered: string[] = [];
  const remaining = new Set(ids);
  while (ready.length > 0) {
    work.rowVisits += 1;
    const node = ready.shift()!;
    if (!remaining.delete(node)) continue;
    ordered.push(node);
    for (const next of outgoing.get(node) ?? []) {
      work.rowVisits += 1;
      const degree = (incoming.get(next) ?? 1) - 1;
      incoming.set(next, degree);
      if (degree === 0) ready.push(next);
      ready.sort(compare);
    }
  }
  if (remaining.size > 0) {
    return Object.freeze([...ids].sort(compare));
  }
  return Object.freeze(ordered);
}

function rankThenId(left: string, right: string, ranks: ReadonlyMap<string, number>): number {
  const leftRank = ranks.get(left) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = ranks.get(right) ?? Number.MAX_SAFE_INTEGER;
  return leftRank !== rightRank ? leftRank - rightRank : compareIdentity(left, right);
}

export function selectBudgetAwareQ(input: {
  readonly spec: QuerySpec;
  readonly digest: string;
  readonly units: readonly EvidenceUnit[];
  readonly edges: readonly TypedSupportEdge[];
  readonly packets?: readonly PacketProposal[];
}): Omit<DecisionResult, "claims"> {
  input = detachInput(input);
  const phases = Object.fromEntries(["setup", "packetFormation", "scanBaseline", "decision", "replacement", "ordering", "finalQuality", "render"]
    .map((phase) => [phase, { rowVisits: 0, comparisons: 0, qualityCalls: 0, packetInspections: 0, utf8Bytes: 0 }])) as PhaseCounters;
  if (new Set(input.units.map((unit) => { phases.setup.rowVisits += 1; return unit.id; })).size !== input.units.length) {
    throw new Error("duplicate evidence identity");
  }
  for (const packet of input.packets ?? []) {
    phases.setup.rowVisits += 1;
    if (new Set(packet.unitIds).size !== packet.unitIds.length) throw new Error("duplicate packet member");
    if (packet.unitIds.length > input.spec.widthW) throw new Error("packet width exceeded");
  }
  if (input.spec.deliveryPath !== null) {
    return Object.freeze({
      ranking_authority: BUDGET_AWARE_Q_AUTHORITY,
      membership: Object.freeze([]),
      order: Object.freeze([]),
      chargedTokens: 0,
      actualBytes: 0,
      renderedEntries: Object.freeze([]),
      envelopeAllowance: 0,
      truncated: false,
      selectionCount: 0,
      querySpecDigest: input.digest,
      satisfiedObligations: 0,
      bindingCount: 0,
      usedPacketIds: Object.freeze([])
    });
  }
  const unitsById = unitIndex(input.units, phases.setup);
  const renderedById = new Map(input.units.map((unit) => {
    phases.setup.rowVisits += 1;
    const entry = preRenderEntry({ object_id: unit.id, content: unit.content,
      ...(unit.source ? { source: unit.source } : {}), ...(unit.sourceSpans ? { sourceSpans: unit.sourceSpans } : {}) });
    phases.setup.utf8Bytes += entry.framedBytes;
    return [unit.id, entry];
  }));
  const ranks = globalRanks(input.units, phases.setup);
  const support = new SelectionSupportIndex(input.spec.obligations, input.edges, phases.setup);
  const maxEvidenceRefs = input.edges.reduce((max, edge) => { phases.setup.rowVisits += 1; return Math.max(max, edge.evidenceRefs?.length ?? 0); }, 0);
  const packets = input.packets ?? emitPackets({ ...input.spec,
    packetM: Math.min(input.spec.packetM + 1, input.units.length + input.spec.obligations.length) }, input.units.map((unit) => {
      phases.packetFormation.rowVisits += 1; return unit.id;
    }), input.edges, phases.packetFormation);
  const packetTruncated = packets.length > input.spec.packetM;
  const orderedPackets = packets.slice(0, input.spec.packetM).sort((left, right) => {
    phases.packetFormation.comparisons += 1; return compareIdentity(left.id, right.id);
  });
  const greedy = greedyFrom(
    input.spec, unitsById, ranks, orderedPackets, support, new Set(), 0, 0, null, phases
  );
  let selected = greedy.selected;
  let tokens = greedy.tokens;
  let truncated = greedy.truncated;
  let used = [...greedy.used];
  let workUsed = greedy.workUsed;
  const bestSingle = greedy.firstScanComplete ? greedy.bestSingle : null;
  if (bestSingle !== null) {
    const greedyQ = qualityOf(input.spec, unitsById, ranks, selected, support, phases.replacement);
    const singleSet = new Set(bestSingle.added);
    const singleQ = qualityOf(input.spec, unitsById, ranks, singleSet, support, phases.replacement);
    phases.replacement.comparisons += 1;
    const qDelta = compareQuality(singleQ, greedyQ);
    const replace = qDelta > 0 || (qDelta === 0 && (bestSingle.cost < tokens ||
      (bestSingle.cost === tokens && compareIdentitySequence(
        [...singleSet].sort(compareIdentity),
        [...selected].sort(compareIdentity)
      ) < 0)));
    if (replace) {
      const refill = greedyFrom(
        input.spec, unitsById, ranks, orderedPackets, support,
        singleSet, bestSingle.cost, greedy.workUsed, null, phases
      );
      workUsed = refill.workUsed;
      selected = refill.selected;
      tokens = refill.tokens;
      truncated = refill.truncated;
      used = [bestSingle.packet.id, ...refill.used];
    }
  }
  const membership = Object.freeze([...selected].sort((a, b) => { phases.ordering.comparisons += 1; return compareIdentity(a, b); }));
  const order = orderSelected(membership, ranks, input.spec.obligations, support, phases.ordering);
  const q = qualityOf(input.spec, unitsById, ranks, selected, support, phases.finalQuality);
  const renderedEntries = Object.freeze(order.map((id) => {
    phases.render.rowVisits += 1;
    const entry = renderedById.get(id)!;
    phases.render.utf8Bytes += entry.framedBytes;
    return entry;
  }));
  return Object.freeze({
    ranking_authority: BUDGET_AWARE_Q_AUTHORITY,
    membership,
    order,
    chargedTokens: selected.size === 0 ? 0 : tokens,
    actualBytes: phases.render.utf8Bytes,
    renderedEntries,
    envelopeAllowance: selected.size ? input.spec.envelopeBytes : 0,
    truncated: truncated || packetTruncated,
    selectionCount: 1,
    workUsed,
    formationWork: support.formationWork,
    phaseWork: Object.freeze({ unit: "instrumented_logical_operations" as const,
      phases: Object.freeze(Object.fromEntries(Object.entries(phases).map(([name, counts]) => [name, Object.freeze(counts)]))) as PhaseCounters,
      bounds: Object.freeze({ captureNodes: 8192, supportEdges: 512, obligations: 64, supportWidth: 4,
        selectedUnits: Math.min(input.spec.k, input.units.length),
        inspectedPackets: 2 * (Math.min(input.spec.k, input.units.length) + 1) * orderedPackets.length,
        qualityCalls: 2 * (Math.min(input.spec.k, input.units.length) + 1) * (3 * orderedPackets.length + 1) + 3,
        maxSortEntries: Math.max(input.units.length, input.edges.length, input.spec.obligations.length, packets.length, maxEvidenceRefs),
        supportRowVisitsPerQuality: input.spec.obligations.length * (1 + 13 * input.edges.length) }) }),
    querySpecDigest: input.digest,
    satisfiedObligations: q.c1,
    bindingCount: q.c2,
    usedPacketIds: Object.freeze(used)
  });
}
