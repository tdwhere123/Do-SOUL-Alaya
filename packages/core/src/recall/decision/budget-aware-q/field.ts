import {
  BASELINE_FAMILIES,
  C02_POLICY,
  compareIdentity,
  EXTENSION_FAMILIES,
  FAMILY_ORDER,
  type AdmittedField,
  type EvidenceUnit,
  type FamilyProbeResult,
  type PacketProposal,
  type QuerySpec,
  type RetrievalFamily,
  type TypedSupportEdge
} from "./types.js";

export function relevanceR(
  familyRanks: Readonly<Partial<Record<RetrievalFamily, number>>>
): number {
  let total = 0;
  for (const family of FAMILY_ORDER) {
    const rank = familyRanks[family];
    if (rank !== undefined && rank >= 1) total += 1 / rank;
  }
  return total;
}

export function globalRanks(
  units: readonly Pick<EvidenceUnit, "id" | "familyRanks">[]
): ReadonlyMap<string, number> {
  const ordered = [...units].sort((left, right) => {
    const delta = relevanceR(right.familyRanks) - relevanceR(left.familyRanks);
    return delta !== 0 ? delta : compareIdentity(left.id, right.id);
  });
  const ranks = new Map<string, number>();
  ordered.forEach((unit, index) => ranks.set(unit.id, index + 1));
  return ranks;
}

function isBaseline(family: RetrievalFamily): boolean {
  return (BASELINE_FAMILIES as readonly string[]).includes(family);
}

function isExtension(family: RetrievalFamily): boolean {
  return (EXTENSION_FAMILIES as readonly string[]).includes(family);
}

function probeOrderKey(probe: FamilyProbeResult): string {
  const familyIndex = FAMILY_ORDER.indexOf(probe.family);
  return `${String(familyIndex).padStart(2, "0")}\u0000${probe.probeId}`;
}

function freezeHits(hits: readonly FamilyProbeResult["hits"][number][]): FamilyProbeResult["hits"] {
  return Object.freeze([...hits].sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    return compareIdentity(left.id, right.id);
  }));
}

export function canonicalizeProbes(
  probes: readonly FamilyProbeResult[]
): readonly FamilyProbeResult[] {
  const byKey = new Map<string, FamilyProbeResult>();
  for (const probe of probes) {
    const key = `${probe.family}\u0000${probe.probeId}`;
    const hits = freezeHits(probe.hits);
    const current = byKey.get(key);
    byKey.set(key, current === undefined
      ? Object.freeze({ family: probe.family, probeId: probe.probeId, hits })
      : Object.freeze({ ...current, hits: freezeHits([...current.hits, ...hits]) }));
  }
  return Object.freeze([...byKey.values()].sort((left, right) =>
    probeOrderKey(left) < probeOrderKey(right) ? -1 : 1
  ));
}

function admitStage(
  probes: readonly FamilyProbeResult[],
  admitted: Map<string, Partial<Record<RetrievalFamily, number>>>,
  identityCap: number,
  rowCap: number,
  startVisits: number
): { readonly visits: number; readonly truncated: boolean } {
  let visits = startVisits;
  let truncated = false;
  const cursors = probes.map(() => 0);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let probeIndex = 0; probeIndex < probes.length; probeIndex += 1) {
      const probe = probes[probeIndex]!;
      const cursor = cursors[probeIndex]!;
      if (cursor >= probe.hits.length) continue;
      if (visits - startVisits >= rowCap) {
        truncated = true;
        return { visits, truncated };
      }
      const hit = probe.hits[cursor]!;
      visits += 1;
      cursors[probeIndex] = cursor + 1;
      progressed = true;
      const existing = admitted.get(hit.id);
      if (existing === undefined) {
        if (admitted.size >= identityCap) continue;
        admitted.set(hit.id, { [probe.family]: hit.rank });
        continue;
      }
      const previous = existing[probe.family];
      if (previous === undefined || hit.rank < previous) existing[probe.family] = hit.rank;
    }
  }
  return { visits, truncated };
}

export function admitField(
  spec: Pick<QuerySpec, "nBase" | "nExtension" | "rBase" | "rExtension" | "familyCaps">,
  probes: readonly FamilyProbeResult[]
): AdmittedField {
  const ordered = canonicalizeProbes(probes).filter((probe) =>
    spec.familyCaps[probe.family] === "ready"
  );
  const admitted = new Map<string, Partial<Record<RetrievalFamily, number>>>();
  const baseline = ordered.filter((probe) => isBaseline(probe.family));
  const baselineStage = admitStage(baseline, admitted, spec.nBase, spec.rBase, 0);
  const e0 = Object.freeze([...admitted.keys()].sort(compareIdentity));
  const embeddingReady = spec.familyCaps.embedding === "ready";
  const extension = embeddingReady
    ? ordered.filter((probe) => isExtension(probe.family))
    : [];
  const extensionCap = spec.nBase + spec.nExtension;
  const extensionStage = admitStage(
    extension,
    admitted,
    extensionCap,
    spec.rExtension,
    baselineStage.visits
  );
  const e1 = Object.freeze([...admitted.keys()].sort(compareIdentity));
  const ranks = new Map<string, Readonly<Partial<Record<RetrievalFamily, number>>>>();
  for (const [id, familyRanks] of admitted) ranks.set(id, Object.freeze({ ...familyRanks }));
  return Object.freeze({
    e0,
    e1,
    ranks,
    rowVisits: extensionStage.visits,
    truncated: baselineStage.truncated || extensionStage.truncated
  });
}

export function emitPackets(
  spec: Pick<QuerySpec, "packetM" | "widthW" | "obligations">,
  unitIds: readonly string[],
  edges: readonly TypedSupportEdge[]
): readonly PacketProposal[] {
  const proposals: PacketProposal[] = [];
  const identities = [...unitIds].sort(compareIdentity);
  for (const id of identities) {
    if (proposals.length >= spec.packetM) break;
    proposals.push(Object.freeze({ id: `singleton:${id}`, unitIds: Object.freeze([id]) }));
  }
  const joinWidth = Math.min(spec.widthW, C02_POLICY.joinWidth);
  const grouped = new Map<string, TypedSupportEdge[]>();
  for (const edge of edges) {
    const key = `${edge.assignmentKey}\u0000${edge.predicate}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(edge);
    grouped.set(key, bucket);
  }
  for (const obligation of spec.obligations) {
    if (proposals.length >= spec.packetM) break;
    const members: string[] = [];
    for (const predicate of obligation.requiredPredicates) {
      const bucket = grouped.get(`${obligation.assignmentKey}\u0000${predicate}`) ?? [];
      const edge = [...bucket].sort((left, right) =>
        compareIdentity(left.resultObjectId, right.resultObjectId)
      )[0];
      if (edge === undefined) {
        members.length = 0;
        break;
      }
      if (!members.includes(edge.resultObjectId)) members.push(edge.resultObjectId);
    }
    if (members.length < 2 || members.length > joinWidth) continue;
    const unitIdsSorted = Object.freeze([...members].sort(compareIdentity));
    if (unitIdsSorted.some((id) => !unitIds.includes(id))) continue;
    proposals.push(Object.freeze({
      id: `packet:${obligation.kind}:${obligation.bindingSlot}:${obligation.assignmentKey}:${unitIdsSorted.join(",")}`,
      unitIds: unitIdsSorted
    }));
    if (proposals.length >= spec.packetM) break;
  }
  return Object.freeze(proposals.slice(0, spec.packetM));
}
