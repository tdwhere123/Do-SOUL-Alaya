type MembershipCandidate = Readonly<{ readonly candidateKey: string }>;

export function projectAuthorizedMembershipOrder<T extends MembershipCandidate>(
  params: Readonly<{
    readonly fallbackHead: readonly T[];
    readonly proposedHead: readonly T[];
    readonly preProjectionKeys: ReadonlySet<string>;
    readonly authorizedIntroductionKeys: ReadonlySet<string>;
  }>
): readonly T[] | null {
  if (params.fallbackHead.length !== params.proposedHead.length) return null;
  const fallbackKeys = new Set(
    params.fallbackHead.map((candidate) => candidate.candidateKey)
  );
  const selected = params.proposedHead.filter((candidate) =>
    params.preProjectionKeys.has(candidate.candidateKey) ||
    params.authorizedIntroductionKeys.has(candidate.candidateKey)
  );
  const selectedKeys = new Set(selected.map((candidate) => candidate.candidateKey));
  for (const candidate of params.fallbackHead) {
    if (selected.length >= params.fallbackHead.length) break;
    if (selectedKeys.has(candidate.candidateKey)) continue;
    selected.push(candidate);
    selectedKeys.add(candidate.candidateKey);
  }
  if (selected.length !== params.fallbackHead.length || selectedKeys.size !== selected.length) {
    return null;
  }
  const introduced = selected.filter(
    (candidate) => !fallbackKeys.has(candidate.candidateKey)
  );
  let introducedIndex = 0;
  const projected = params.fallbackHead.map((candidate) => {
    if (selectedKeys.has(candidate.candidateKey)) return candidate;
    return introduced[introducedIndex++];
  });
  if (projected.some((candidate) => candidate === undefined) ||
      introducedIndex !== introduced.length) {
    return null;
  }
  return Object.freeze(projected as T[]);
}
