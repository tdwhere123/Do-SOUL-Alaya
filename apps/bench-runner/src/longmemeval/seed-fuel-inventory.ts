import {
  FACET_VOCABULARY,
  isPathRecallEligible,
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";

const ANSWER_FLOOD_RELATION_KINDS: ReadonlySet<string> = new Set(["answers_with"]);
const FACET_KEYWORD_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["occupation_work", /\b(job|work|career|profession|occupation|employer|company|工作|职业|公司)\b/iu],
  ["education", /\b(school|college|university|degree|study|studied|major|学校|大学|学位|专业)\b/iu],
  ["location_place", /\b(where|live|lives?|location|city|country|address|住|地点|城市|国家)\b/iu],
  ["event_activity", /\b(event|activity|attend|meeting|party|conference|活动|会议|聚会)\b/iu],
  ["time_date", /\b(when|date|time|year|month|day|yesterday|today|时间|日期|什么时候)\b/iu],
  ["preference_like", /\b(prefer|preference|like|likes?|favorite|enjoy|偏好|喜欢|最爱)\b/iu],
  ["possession_item", /\b(own|owns?|has|have|possess|belongings?|拥有|有)\b/iu],
  ["relationship_person", /\b(friend|family|partner|spouse|colleague|relationship|朋友|家人|同事|关系)\b/iu],
  ["health", /\b(health|sick|illness|doctor|medical|condition|健康|生病|医生)\b/iu],
  ["finance_money", /\b(money|salary|income|finance|budget|cost|price|钱|收入|预算|价格)\b/iu],
  ["travel", /\b(travel|trip|flight|vacation|visit|abroad|旅行|出差|旅游)\b/iu],
  ["food_dining", /\b(food|eat|ate|restaurant|meal|cuisine|dining|食物|吃|餐厅)\b/iu],
  ["hobby_skill", /\b(hobby|skill|play|sport|instrument|practice|爱好|技能|运动)\b/iu],
  ["purchase", /\b(buy|bought|purchase|order|ordered|shopping|买|购买|下单)\b/iu],
  ["media_entertainment", /\b(movie|film|show|music|book|game|watch|read|电影|音乐|书|游戏)\b/iu],
  ["life_event", /\b(born|married|moved|graduated|retired|divorce|出生|结婚|搬家|毕业)\b/iu],
  ["communication_tool", /\b(email|phone|message|chat|call|slack|whatsapp|邮件|电话|消息)\b/iu]
];
const ACTIVE_FACET_KEYWORD_PATTERNS = FACET_KEYWORD_PATTERNS.filter(([facet]) =>
  FACET_VOCABULARY.includes(facet)
);

export interface SeedFuelInventory {
  readonly objects_total: number;
  readonly evidence_refs_total: number;
  readonly facet_anchors_total: number;
  readonly path_candidates_total: number;
  readonly support_bearing_candidates: number;
}

export function deriveSeedFuelInventory(input: {
  readonly entries: readonly Readonly<MemoryEntry>[];
  readonly paths?: readonly Readonly<PathRelation>[];
}): SeedFuelInventory {
  const entries = input.entries;
  const candidateIds = new Set(entries.map((entry) => entry.object_id));
  const evidenceRefs = collectEvidenceRefs(entries);
  const facetAnchors = collectFacetAnchors(entries, input.paths ?? []);
  const pathCandidates = countPathFuelCandidates(input.paths ?? [], candidateIds);
  const supportBearing = entries.filter((entry) => (entry.evidence_refs ?? []).length > 0).length;
  return Object.freeze({
    objects_total: entries.length,
    evidence_refs_total: evidenceRefs.size,
    facet_anchors_total: facetAnchors.size,
    path_candidates_total: pathCandidates,
    support_bearing_candidates: supportBearing
  });
}

export function mergeSeedFuelInventories(
  inventories: readonly SeedFuelInventory[]
): SeedFuelInventory {
  return inventories.reduce<SeedFuelInventory>(
    (merged, row) =>
      Object.freeze({
        objects_total: merged.objects_total + row.objects_total,
        evidence_refs_total: merged.evidence_refs_total + row.evidence_refs_total,
        facet_anchors_total: Math.max(
          merged.facet_anchors_total,
          row.facet_anchors_total
        ),
        path_candidates_total: merged.path_candidates_total + row.path_candidates_total,
        support_bearing_candidates:
          merged.support_bearing_candidates + row.support_bearing_candidates
      }),
    emptySeedFuelInventory()
  );
}

export function emptySeedFuelInventory(): SeedFuelInventory {
  return Object.freeze({
    objects_total: 0,
    evidence_refs_total: 0,
    facet_anchors_total: 0,
    path_candidates_total: 0,
    support_bearing_candidates: 0
  });
}

function collectEvidenceRefs(entries: readonly Readonly<MemoryEntry>[]): Set<string> {
  const refs = new Set<string>();
  for (const entry of entries) {
    for (const ref of entry.evidence_refs ?? []) {
      refs.add(ref);
    }
  }
  return refs;
}

function collectFacetAnchors(
  entries: readonly Readonly<MemoryEntry>[],
  paths: readonly Readonly<PathRelation>[]
): Set<string> {
  const facets = new Set<string>();
  for (const entry of entries) {
    for (const tag of entry.facet_tags ?? []) {
      facets.add(tag.facet);
    }
    for (const facet of deriveFacetsFromText(entry.content)) {
      facets.add(facet);
    }
    for (const domainTag of entry.domain_tags ?? []) {
      for (const facet of deriveFacetsFromText(domainTag)) {
        facets.add(facet);
      }
    }
  }
  for (const path of paths) {
    const facetKey = pathAnchorFacetKey(path);
    if (facetKey !== null) {
      facets.add(facetKey);
    }
  }
  return facets;
}

function countPathFuelCandidates(
  paths: readonly Readonly<PathRelation>[],
  candidateIds: ReadonlySet<string>
): number {
  if (candidateIds.size === 0 || paths.length === 0) {
    return 0;
  }
  let count = 0;
  for (const path of paths) {
    if (!isPathRecallEligible(path)) {
      continue;
    }
    if (!ANSWER_FLOOD_RELATION_KINDS.has(path.constitution.relation_kind)) {
      continue;
    }
    const sourceId = anchorMemoryId(path.anchors.source_anchor);
    const targetId = anchorMemoryId(path.anchors.target_anchor);
    if (
      sourceId === undefined ||
      targetId === undefined ||
      !candidateIds.has(sourceId) ||
      !candidateIds.has(targetId)
    ) {
      continue;
    }
    if (directionEligiblePathExpansionTargets(path, candidateIds).length === 0) {
      continue;
    }
    count += 1;
  }
  return count;
}

function directionEligiblePathExpansionTargets(
  path: Readonly<PathRelation>,
  seedIds: ReadonlySet<string>
): readonly string[] {
  const sourceId = anchorMemoryId(path.anchors.source_anchor);
  const targetId = anchorMemoryId(path.anchors.target_anchor);
  if (sourceId === undefined || targetId === undefined || sourceId === targetId) {
    return [];
  }
  const targets = new Set<string>();
  if (
    seedIds.has(sourceId) &&
    (path.plasticity_state.direction_bias === "source_to_target" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric")
  ) {
    targets.add(targetId);
  }
  if (
    seedIds.has(targetId) &&
    (path.plasticity_state.direction_bias === "target_to_source" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric")
  ) {
    targets.add(sourceId);
  }
  return [...targets];
}

function pathAnchorFacetKey(path: Readonly<PathRelation>): string | null {
  const { source_anchor, target_anchor } = path.anchors;
  if (source_anchor.kind === "object_facet") {
    return source_anchor.facet_key;
  }
  if (target_anchor.kind === "object_facet") {
    return target_anchor.facet_key;
  }
  return null;
}

function anchorMemoryId(anchor: Readonly<PathAnchorRef> | unknown): string | undefined {
  if (anchor === null || typeof anchor !== "object") {
    return undefined;
  }
  const record = anchor as {
    readonly kind?: unknown;
    readonly object_kind?: unknown;
    readonly object_id?: unknown;
  };
  if ((record.kind === "object" || record.kind === "object_facet") && typeof record.object_id === "string") {
    return record.object_id;
  }
  return record.object_kind === "memory_entry" && typeof record.object_id === "string"
    ? record.object_id
    : undefined;
}

function deriveFacetsFromText(value: string): readonly string[] {
  if (value.length === 0) {
    return Object.freeze([]);
  }
  return Object.freeze(
    ACTIVE_FACET_KEYWORD_PATTERNS.filter(([, pattern]) => pattern.test(value)).map(([facet]) => facet)
  );
}
