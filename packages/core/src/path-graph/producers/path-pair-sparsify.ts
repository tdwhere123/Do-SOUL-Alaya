export type PathPair = readonly [sourceObjectId: string, targetObjectId: string];

export interface PathPairObject {
  readonly objectId: string;
  readonly sessionId?: string | null;
  readonly formationKey: string;
}

export function buildSessionMap(
  objects: readonly Pick<PathPairObject, "objectId" | "sessionId">[]
): ReadonlyMap<string, string | null> {
  return new Map(objects.map((object) => [object.objectId, object.sessionId ?? null] as const));
}

// invariant: persisted-provenance formation keys select bounded graph neighbors.
// Object identity only total-orders indistinguishable evidence ties so one
// duplicate cannot abort the entire formation batch.
export function buildObjectFormationOrder(
  objects: readonly Pick<PathPairObject, "objectId" | "formationKey">[]
): ReadonlyMap<string, number> {
  const objectIds = new Set<string>();
  for (const object of objects) {
    if (object.objectId.length === 0 || object.formationKey.length === 0) {
      throw new Error("object id and formation key must not be empty");
    }
    if (objectIds.has(object.objectId)) {
      throw new Error(`duplicate object id '${object.objectId}'`);
    }
    objectIds.add(object.objectId);
  }
  return new Map([...objects]
    .sort((left, right) =>
      compareText(left.formationKey, right.formationKey) ||
      compareText(left.objectId, right.objectId)
    )
    .map((object, index) => [object.objectId, index] as const));
}

export function parsePathPairKeys(pairKeys: ReadonlySet<string>): readonly PathPair[] {
  return Object.freeze([...pairKeys].map(parsePathPairKey));
}

function parsePathPairKey(pairKey: string): PathPair {
  const separator = pairKey.indexOf("|");
  if (
    separator <= 0 ||
    separator !== pairKey.lastIndexOf("|") ||
    separator === pairKey.length - 1
  ) {
    throw new Error(`pair key '${pairKey}' must contain exactly two non-empty endpoints`);
  }
  return Object.freeze([pairKey.slice(0, separator), pairKey.slice(separator + 1)]);
}

export function sparsifyPairs(
  pairs: readonly PathPair[],
  sessionById: ReadonlyMap<string, string | null>,
  objectOrder: ReadonlyMap<string, number>,
  capPerNode: number,
  crossSessionOnly: boolean
): readonly PathPair[] {
  const kept: PathPair[] = [];
  const cap = Number.isFinite(capPerNode)
    ? Math.max(0, Math.floor(capPerNode))
    : 0;
  const degree = new Map<string, number>();
  for (const [source, target] of eligiblePairs(
    pairs,
    sessionById,
    objectOrder,
    crossSessionOnly
  )) {
    if ((degree.get(source) ?? 0) >= cap || (degree.get(target) ?? 0) >= cap) {
      continue;
    }
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
    kept.push(Object.freeze([source, target]));
  }
  return Object.freeze(kept);
}

function eligiblePairs(
  pairs: readonly PathPair[],
  sessionById: ReadonlyMap<string, string | null>,
  objectOrder: ReadonlyMap<string, number>,
  crossSessionOnly: boolean
): readonly PathPair[] {
  const unique = new Map<string, PathPair>();
  for (const [left, right] of pairs) {
    if (left === right || !objectOrder.has(left) || !objectOrder.has(right)) continue;
    if (crossSessionOnly && sessionById.get(left) === sessionById.get(right)) continue;
    const oriented = compareByFormation(left, right, objectOrder) <= 0
      ? Object.freeze([left, right] as const)
      : Object.freeze([right, left] as const);
    unique.set(JSON.stringify(oriented), oriented);
  }
  return Object.freeze([...unique.values()].sort(compareOrientedPairs(objectOrder)));
}

function compareOrientedPairs(objectOrder: ReadonlyMap<string, number>) {
  return (left: PathPair, right: PathPair): number =>
    compareByFormation(left[0], right[0], objectOrder) ||
    compareByFormation(left[1], right[1], objectOrder);
}

function compareByFormation(
  left: string,
  right: string,
  objectOrder: ReadonlyMap<string, number>
): number {
  return (objectOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
    (objectOrder.get(right) ?? Number.MAX_SAFE_INTEGER);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
