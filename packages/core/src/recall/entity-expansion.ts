// Read-side entity expansion: grouping over candidate canonical_entities.
// groupCandidatesByEntity is consumed by Card D's live compose path
// (activation-assembly); grouping over the FULL scored pool is the within-pool entity
// expansion. Broader coarse seed→pool expansion is a future card. Canonical entity is the
// only answer-selective grouping key (4.56x lift, design §4.5) — surface tokens disperse,
// the subject is stable.

// Generic input: Card D adapts FineAssessmentCandidate via entry.object_id / entry.canonical_entities.
export interface EntityCandidate {
  readonly objectId: string;
  readonly canonicalEntities: readonly string[] | null | undefined;
}

export interface EntityGroup {
  readonly key: string | null;
  readonly memberObjectIds: string[];
}

export const DEFAULT_ENTITY_GROUP_CAP = 25;

function normalizeEntity(raw: string): string {
  return raw.trim().toLowerCase();
}

// entity → index of its first (strongest) carrier; input is pre-sorted by score.
function buildAnchorIndex(candidates: readonly EntityCandidate[]): Map<string, number> {
  const anchor = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    const entities = candidate.canonicalEntities;
    if (!entities) return;
    for (const raw of entities) {
      const entity = normalizeEntity(raw);
      if (entity.length === 0 || anchor.has(entity)) continue;
      anchor.set(entity, index);
    }
  });
  return anchor;
}

// Strongest shared entity = lowest anchor index, tie-broken by smallest entity string (order-independent). Null = no entities.
function primaryEntity(
  candidate: EntityCandidate,
  anchorIndex: Map<string, number>
): string | null {
  const entities = candidate.canonicalEntities;
  if (!entities) return null;
  let best: string | null = null;
  let bestAnchor = Number.POSITIVE_INFINITY;
  for (const raw of entities) {
    const entity = normalizeEntity(raw);
    if (entity.length === 0) continue;
    const anchor = anchorIndex.get(entity) ?? Number.POSITIVE_INFINITY;
    if (anchor < bestAnchor || (anchor === bestAnchor && (best === null || entity < best))) {
      best = entity;
      bestAnchor = anchor;
    }
  }
  return best;
}

// One group per candidate (its strongest shared entity) so shared-entity candidates land together
// order-independently; no-entity → singleton (key=null). Members past cap are dropped here; the compose tail recovers them.
export function groupCandidatesByEntity(
  candidates: readonly EntityCandidate[],
  options?: { readonly cap?: number }
): EntityGroup[] {
  const cap = options?.cap ?? DEFAULT_ENTITY_GROUP_CAP;
  const anchorIndex = buildAnchorIndex(candidates);
  const groups: EntityGroup[] = [];
  const groupByKey = new Map<string, EntityGroup>();
  for (const candidate of candidates) {
    const key = primaryEntity(candidate, anchorIndex);
    if (key === null) {
      groups.push({ key: null, memberObjectIds: [candidate.objectId] });
      continue;
    }
    const existing = groupByKey.get(key);
    if (existing) {
      if (existing.memberObjectIds.length < cap) existing.memberObjectIds.push(candidate.objectId);
      continue;
    }
    const group: EntityGroup = { key, memberObjectIds: [candidate.objectId] };
    groups.push(group);
    groupByKey.set(key, group);
  }
  return groups;
}
