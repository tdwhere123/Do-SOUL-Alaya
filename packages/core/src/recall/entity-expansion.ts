// Read-side entity expansion: query-time inverted index + grouping over candidate
// canonical_entities. Pure helpers consumed by Card D's compose-then-rank assembly;
// not wired into the live recall path yet. Canonical entity is the only answer-selective
// grouping key (4.56x lift, design §4.5) — surface tokens disperse, the subject is stable.

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

function firstEntity(entities: readonly string[] | null | undefined): string | null {
  if (!entities) return null;
  for (const raw of entities) {
    const entity = normalizeEntity(raw);
    if (entity.length > 0) return entity;
  }
  return null;
}

// canonical entity → objectIds carrying it (per-candidate de-duped, input order preserved).
export function buildEntityIndex(candidates: readonly EntityCandidate[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const candidate of candidates) {
    const entities = candidate.canonicalEntities;
    if (!entities) continue;
    const seen = new Set<string>();
    for (const raw of entities) {
      const entity = normalizeEntity(raw);
      if (entity.length === 0 || seen.has(entity)) continue;
      seen.add(entity);
      const members = index.get(entity);
      if (members) members.push(candidate.objectId);
      else index.set(entity, [candidate.objectId]);
    }
  }
  return index;
}

// Group candidates by their first (strongest) canonical entity so each candidate lands in
// exactly one group — no double-delivery. No-entity candidates become singleton (key=null)
// groups. Group order follows first-member order (input assumed pre-sorted by object score).
export function groupCandidatesByEntity(
  candidates: readonly EntityCandidate[],
  options?: { readonly cap?: number }
): EntityGroup[] {
  const cap = options?.cap ?? DEFAULT_ENTITY_GROUP_CAP;
  const groups: EntityGroup[] = [];
  const groupByKey = new Map<string, EntityGroup>();
  for (const candidate of candidates) {
    const key = firstEntity(candidate.canonicalEntities);
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

// Same-entity co-members of the seeds drawn from the pool (seeds excluded, total bounded by cap).
export function expandByEntity(
  seedObjectIds: readonly string[],
  candidates: readonly EntityCandidate[],
  cap: number = DEFAULT_ENTITY_GROUP_CAP
): string[] {
  if (seedObjectIds.length === 0 || cap <= 0) return [];
  const seedSet = new Set(seedObjectIds);
  const index = buildEntityIndex(candidates);
  const seedEntities = new Set<string>();
  for (const candidate of candidates) {
    if (!seedSet.has(candidate.objectId)) continue;
    const entities = candidate.canonicalEntities;
    if (!entities) continue;
    for (const raw of entities) {
      const entity = normalizeEntity(raw);
      if (entity.length > 0) seedEntities.add(entity);
    }
  }
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const entity of seedEntities) {
    const members = index.get(entity);
    if (!members) continue;
    for (const objectId of members) {
      if (seedSet.has(objectId) || seen.has(objectId)) continue;
      seen.add(objectId);
      expanded.push(objectId);
      if (expanded.length >= cap) return expanded;
    }
  }
  return expanded;
}
