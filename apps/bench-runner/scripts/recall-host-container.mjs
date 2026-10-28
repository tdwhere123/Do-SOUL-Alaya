// A root can belong to several host containers; scoped references must not be collapsed to ids.
export function projectHostContainer(occurrences) {
  if (occurrences.length === 0) return { status: "unavailable", key: null, reference: null, position: null };
  const refs = new Map();
  for (const occurrence of occurrences) {
    const ref = occurrence.container_ref;
    if (typeof ref?.scope !== "string" || typeof ref?.id !== "string") {
      return { status: "unavailable", key: null, reference: null, position: null };
    }
    refs.set(JSON.stringify([ref.scope, ref.id]), ref);
  }
  if (refs.size !== 1) return { status: "ambiguous", key: null, reference: null, position: null };
  const [key, reference] = [...refs][0];
  const positions = occurrences.map(row => row.upstream_position);
  return { status: "available", key, reference,
    position: positions.every(Number.isSafeInteger) ? Math.min(...positions) : null };
}
