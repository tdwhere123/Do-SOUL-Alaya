export type AnswerHeadProtection = Readonly<{
  readonly candidateKey: string;
  readonly rankLimit: number;
}>;

export type AnswerHeadSelection<T> = Readonly<{
  readonly candidates: readonly T[];
  readonly protections: readonly AnswerHeadProtection[];
  readonly rejectedCandidateKeys: readonly string[];
}>;

export type SemanticHeadCandidate<T> = Readonly<{
  readonly candidate: T;
  readonly candidateKey: string;
  readonly index: number;
}>;

type SemanticRefinementCandidate = Readonly<{
  readonly fusion: Readonly<{ readonly fused_score: number }>;
}>;

type SemanticMemoryRefinementParams<T extends SemanticRefinementCandidate> = Readonly<{
  readonly evidenceSelection: AnswerHeadSelection<T>;
  readonly leader: SemanticHeadCandidate<T>;
  readonly headLimit: number;
  readonly replacementProtectedCandidateKeys?: readonly string[];
  readonly publicRelevanceByCandidateKey: ReadonlyMap<string, number>;
  readonly selectDelivered: (candidates: readonly T[]) => readonly T[];
  readonly keyOf: (candidate: T) => string;
  readonly evidencePermitsVictim: (
    selection: AnswerHeadSelection<T>,
    victim: T
  ) => boolean;
  readonly protectionsAreFeasible: (
    trial: readonly T[],
    protections: readonly AnswerHeadProtection[],
    sourceCandidates: readonly T[]
  ) => boolean;
  readonly resolveSingleReplacement: (
    baseline: readonly T[],
    trial: readonly T[],
    promotedKey: string
  ) => T | undefined;
}>;

export function selectSemanticMemoryRefinement<T extends SemanticRefinementCandidate>(
  params: SemanticMemoryRefinementParams<T>
): AnswerHeadSelection<T> {
  const baseline = params.selectDelivered(params.evidenceSelection.candidates);
  if (candidateKeys(baseline, params.keyOf).has(params.leader.candidateKey)) {
    const refined = addAnswerHeadProtection(
      params.evidenceSelection, params.leader, 1
    );
    return params.protectionsAreFeasible(
      baseline, refined.protections, refined.candidates
    )
      ? refined
      : params.evidenceSelection;
  }
  const protectedKeys = semanticReplacementProtectedKeys(params, baseline);
  const victim = weakestUnprotectedCandidate(params, baseline, protectedKeys);
  if (
    victim === undefined ||
    !params.evidencePermitsVictim(params.evidenceSelection, victim)
  ) return rejectSemanticLeader(params);
  const trialOrder = replaceCandidateOrder(
    params.evidenceSelection.candidates,
    params.leader.candidate,
    victim,
    params.keyOf
  );
  const trial = params.selectDelivered(trialOrder);
  const replacement = params.resolveSingleReplacement(
    baseline, trial, params.leader.candidateKey
  );
  if (replacement === undefined || params.keyOf(replacement) !== params.keyOf(victim)) {
    return rejectSemanticLeader(params);
  }
  const refined = addAnswerHeadProtection(
    Object.freeze({
      candidates: trialOrder,
      protections: params.evidenceSelection.protections,
      rejectedCandidateKeys: params.evidenceSelection.rejectedCandidateKeys
    }),
    params.leader,
    1
  );
  return params.protectionsAreFeasible(
    trial, refined.protections, refined.candidates
  )
    ? refined
    : rejectSemanticLeader(params);
}

export function addAnswerHeadProtection<T>(
  selection: AnswerHeadSelection<T>,
  protectedCandidate: Readonly<{ readonly candidateKey: string }>,
  rankLimit: number
): AnswerHeadSelection<T> {
  const retained = selection.protections.filter(
    (item) => item.candidateKey !== protectedCandidate.candidateKey
  );
  return Object.freeze({
    candidates: selection.candidates,
    protections: Object.freeze([
      ...retained,
      Object.freeze({ candidateKey: protectedCandidate.candidateKey, rankLimit })
    ]),
    rejectedCandidateKeys: selection.rejectedCandidateKeys
  });
}

function rejectSemanticLeader<T extends SemanticRefinementCandidate>(
  params: SemanticMemoryRefinementParams<T>
): AnswerHeadSelection<T> {
  if (
    params.evidenceSelection.rejectedCandidateKeys.includes(
      params.leader.candidateKey
    )
  ) return params.evidenceSelection;
  return Object.freeze({
    candidates: params.evidenceSelection.candidates,
    protections: params.evidenceSelection.protections,
    rejectedCandidateKeys: Object.freeze([
      ...params.evidenceSelection.rejectedCandidateKeys,
      params.leader.candidateKey
    ])
  });
}

function semanticReplacementProtectedKeys<T extends SemanticRefinementCandidate>(
  params: SemanticMemoryRefinementParams<T>,
  baseline: readonly T[]
): ReadonlySet<string> {
  const baselineKeys = candidateKeys(baseline, params.keyOf);
  const protectedKeys = new Set([
    ...params.evidenceSelection.protections.map((item) => item.candidateKey),
    ...(params.replacementProtectedCandidateKeys ?? [])
  ].filter((key) => baselineKeys.has(key)));
  const protectedTarget = Math.max(0, params.headLimit - 1);
  const publicOrder = [...baseline].sort((left, right) =>
    comparePublicRelevance(params, left, right)
  );
  for (const candidate of publicOrder) {
    if (protectedKeys.size >= protectedTarget) break;
    protectedKeys.add(params.keyOf(candidate));
  }
  return protectedKeys;
}

function weakestUnprotectedCandidate<T extends SemanticRefinementCandidate>(
  params: SemanticMemoryRefinementParams<T>,
  baseline: readonly T[],
  protectedKeys: ReadonlySet<string>
): T | undefined {
  return [...baseline]
    .filter((candidate) => !protectedKeys.has(params.keyOf(candidate)))
    .sort((left, right) => comparePublicRelevance(params, right, left))[0];
}

function comparePublicRelevance<T extends SemanticRefinementCandidate>(
  params: SemanticMemoryRefinementParams<T>,
  left: T,
  right: T
): number {
  const leftKey = params.keyOf(left);
  const rightKey = params.keyOf(right);
  const leftScore =
    params.publicRelevanceByCandidateKey.get(leftKey) ?? left.fusion.fused_score;
  const rightScore =
    params.publicRelevanceByCandidateKey.get(rightKey) ?? right.fusion.fused_score;
  return rightScore - leftScore || leftKey.localeCompare(rightKey);
}

function replaceCandidateOrder<T>(
  candidates: readonly T[],
  promoted: T,
  victim: T,
  keyOf: (candidate: T) => string
): readonly T[] {
  const promotedKey = keyOf(promoted);
  const victimKey = keyOf(victim);
  const remaining = candidates.filter((candidate) => {
    const key = keyOf(candidate);
    return key !== promotedKey && key !== victimKey;
  });
  return Object.freeze([promoted, ...remaining, victim]);
}

function candidateKeys<T>(
  candidates: readonly T[],
  keyOf: (candidate: T) => string
): ReadonlySet<string> {
  return new Set(candidates.map(keyOf));
}
