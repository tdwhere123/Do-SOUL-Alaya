export interface NestedSetCandidate {
  readonly key: string;
  readonly scenarioRanks: Readonly<Record<string, number | null>>;
  readonly coreDemandIds: readonly string[];
  readonly conjunctiveCoreDemandIds: readonly string[];
  readonly supportingDemandIds: readonly string[];
  readonly applicabilityDemandIds: readonly string[];
  readonly demandCoverage: Readonly<Record<string, number>>;
  readonly evidenceGroup: string | null;
  readonly proposalSupport: number;
  readonly risk: number;
  readonly tokenCost: number;
}

export interface NestedSetSelectionOptions {
  readonly headSize: number;
  readonly packSize: number;
}

export interface NestedSetSelectionResult {
  readonly headKeys: readonly string[];
  readonly packKeys: readonly string[];
  readonly scenarios: readonly string[];
  readonly headObjective: readonly number[];
  readonly packObjective: readonly number[];
}

export interface IncumbentNestedSetInput {
  readonly headKeys: readonly string[];
  readonly packKeys: readonly string[];
}

interface SelectionState {
  readonly selected: readonly NestedSetCandidate[];
  readonly objective: readonly number[];
}

interface NestedExchange {
  readonly head: readonly NestedSetCandidate[];
  readonly pack: readonly NestedSetCandidate[];
  readonly objective: readonly number[];
  readonly challengerKey: string;
}

const UTILITY_EPSILON = 1e-12;

export function selectLexicographicNestedSet(
  candidates: readonly Readonly<NestedSetCandidate>[],
  options: Readonly<NestedSetSelectionOptions>
): Readonly<NestedSetSelectionResult> {
  const normalized = normalizeCandidates(candidates);
  const scenarios = selectObservedScenarios(normalized, options.headSize);
  const head = selectGreedySet(normalized, [], options.headSize, scenarios, "head");
  const pack = selectGreedySet(
    normalized, head.selected, options.packSize, scenarios, "pack"
  );
  return Object.freeze({
    headKeys: Object.freeze(head.selected.map(({ key }) => key)),
    packKeys: Object.freeze(pack.selected.map(({ key }) => key)),
    scenarios: Object.freeze(scenarios),
    headObjective: head.objective,
    packObjective: pack.objective
  });
}

export function refineIncumbentNestedSet(
  candidates: readonly Readonly<NestedSetCandidate>[],
  incumbent: Readonly<IncumbentNestedSetInput>,
  options: Readonly<NestedSetSelectionOptions>
): Readonly<NestedSetSelectionResult> {
  const normalized = normalizeCandidates(candidates);
  const byKey = new Map(normalized.map((candidate) => [candidate.key, candidate]));
  const scenarios = selectObservedScenarios(normalized, options.headSize);
  const head = incumbent.headKeys.flatMap((key) => byKey.get(key) ?? []);
  const pack = incumbent.packKeys.flatMap((key) => byKey.get(key) ?? []);
  const improved = bestSafeNestedExchange(
    normalized, head, pack, scenarios, options
  );
  return Object.freeze({
    headKeys: Object.freeze(improved.head.map(({ key }) => key)),
    packKeys: Object.freeze(improved.pack.map(({ key }) => key)),
    scenarios: Object.freeze(scenarios),
    headObjective: Object.freeze(objectiveVector(improved.head, scenarios, "head")),
    packObjective: Object.freeze(objectiveVector(improved.pack, scenarios, "pack"))
  });
}

function bestSafeNestedExchange(
  candidates: readonly NestedSetCandidate[],
  incumbentHead: readonly NestedSetCandidate[],
  incumbentPack: readonly NestedSetCandidate[],
  scenarios: readonly string[],
  options: Readonly<NestedSetSelectionOptions>
): Readonly<{ head: readonly NestedSetCandidate[]; pack: readonly NestedSetCandidate[] }> {
  const safetyScenarios = scenarios.filter((scenario) => scenario !== "delivery");
  const proposalScenarios = observedCandidateScenarios(candidates)
    .filter((scenario) => scenario !== "delivery");
  const incumbentKeys = new Set(incumbentHead.map(({ key }) => key));
  const proposals = candidates
    .filter((candidate) => !incumbentKeys.has(candidate.key) &&
      isActivationOpportunity(candidate, proposalScenarios, options.packSize))
    .flatMap((challenger) => incumbentHead.flatMap((_, index) => buildSafeExchange({
      challenger,
      evicteeIndex: index,
      incumbentHead,
      incumbentPack,
      scenarios: safetyScenarios,
      dominanceScenarios: proposalScenarios,
      packSize: options.packSize
    })));
  const best = proposals.sort((left, right) =>
    compareObjective(right.objective, left.objective) ||
    left.challengerKey.localeCompare(right.challengerKey)
  )[0];
  return Object.freeze(best === undefined
    ? { head: incumbentHead, pack: incumbentPack }
    : { head: best.head, pack: best.pack });
}

function buildSafeExchange(params: Readonly<{
  challenger: NestedSetCandidate;
  evicteeIndex: number;
  incumbentHead: readonly NestedSetCandidate[];
  incumbentPack: readonly NestedSetCandidate[];
  scenarios: readonly string[];
  dominanceScenarios: readonly string[];
  packSize: number;
}>): readonly NestedExchange[] {
  const evictee = params.incumbentHead[params.evicteeIndex];
  if (evictee === undefined) return [];
  const certifiedCoreGain = params.challenger.coreDemandIds.some((id) =>
    !evictee.coreDemandIds.includes(id)
  );
  if (!certifiedCoreGain && !preservesObservedActivation(
    params.challenger, evictee, params.dominanceScenarios
  )) return [];
  const head = params.incumbentHead.map((candidate, index) =>
    index === params.evicteeIndex ? params.challenger : candidate
  );
  if (!safeSetReplacement(params.incumbentHead, head, params.scenarios, true)) return [];
  const pack = composeRefinedPack(params.incumbentPack, head, params.packSize);
  if (!safeSetReplacement(params.incumbentPack, pack, params.scenarios, false)) return [];
  return [Object.freeze({
    head: Object.freeze(head),
    pack,
    objective: Object.freeze(objectiveVector(head, params.scenarios, "head")),
    challengerKey: params.challenger.key
  })];
}

function preservesObservedActivation(
  challenger: NestedSetCandidate,
  evictee: NestedSetCandidate,
  scenarios: readonly string[]
): boolean {
  return scenarios.every((scenario) => {
    const incumbentRank = evictee.scenarioRanks[scenario];
    if (!finiteRank(incumbentRank)) return true;
    const challengerRank = challenger.scenarioRanks[scenario];
    return finiteRank(challengerRank) && challengerRank <= incumbentRank;
  });
}

function isActivationOpportunity(
  candidate: NestedSetCandidate,
  scenarios: readonly string[],
  headSize: number
): boolean {
  return scenarios.some((scenario) =>
    rankWithin(candidate.scenarioRanks[scenario], headSize)
  );
}

function safeSetReplacement(
  incumbent: readonly NestedSetCandidate[],
  proposed: readonly NestedSetCandidate[],
  scenarios: readonly string[],
  requireStrict: boolean
): boolean {
  const incumbentUtility = scenarioUtilityVector(incumbent, scenarios);
  const proposedUtility = scenarioUtilityVector(proposed, scenarios);
  const incumbentDemand = facilityCoverageByDemand(incumbent, "core");
  const proposedDemand = facilityCoverageByDemand(proposed, "core");
  const incumbentSupporting = facilityCoverageByDemand(incumbent, "supporting");
  const proposedSupporting = facilityCoverageByDemand(proposed, "supporting");
  if (!preservesCoverage(proposedDemand, incumbentDemand)) return false;
  if (!preservesCoverage(proposedSupporting, incumbentSupporting)) return false;
  if (!preservesCandidateApplicability(incumbent, proposed)) return false;
  if (totalRisk(proposed) > totalRisk(incumbent)) return false;
  const demandGain = totalCoverage(proposedDemand) >
    totalCoverage(incumbentDemand) + UTILITY_EPSILON;
  const supportingGain = totalCoverage(proposedSupporting) >
    totalCoverage(incumbentSupporting) + UTILITY_EPSILON;
  const activationLoss = proposedUtility.some((value, index) =>
    value + UTILITY_EPSILON < incumbentUtility[index]!
  );
  if (!demandGain && !supportingGain && activationLoss) return false;
  if (!requireStrict) return true;
  return demandGain || supportingGain || totalRisk(proposed) < totalRisk(incumbent);
}

function preservesCandidateApplicability(
  incumbent: readonly NestedSetCandidate[],
  proposed: readonly NestedSetCandidate[]
): boolean {
  const proposedKeys = new Set(proposed.map(({ key }) => key));
  return incumbent.every((candidate) => proposedKeys.has(candidate.key) ||
    proposed.some((replacement) => setContainsAll(
      new Set(replacement.applicabilityDemandIds),
      new Set(candidate.applicabilityDemandIds)
    ))
  );
}

function scenarioUtilityVector(
  candidates: readonly NestedSetCandidate[],
  scenarios: readonly string[]
): readonly number[] {
  return scenarios.map((scenario) => candidates.reduce(
    (sum, candidate) => sum + rankUtility(candidate.scenarioRanks[scenario]), 0
  ));
}

function setContainsAll(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...right].every((value) => left.has(value));
}

function totalRisk(candidates: readonly NestedSetCandidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidate.risk, 0);
}

function composeRefinedPack(
  incumbentPack: readonly NestedSetCandidate[],
  head: readonly NestedSetCandidate[],
  packSize: number
): readonly NestedSetCandidate[] {
  const headKeys = new Set(head.map(({ key }) => key));
  const tail = incumbentPack.filter(({ key }) => !headKeys.has(key));
  const pack = [...head, ...tail].slice(0, packSize);
  if (pack.length >= Math.min(packSize, incumbentPack.length)) return Object.freeze(pack);
  const packKeys = new Set(pack.map(({ key }) => key));
  const added = head.find(({ key }) => !incumbentPack.some((item) => item.key === key));
  if (added !== undefined && !packKeys.has(added.key)) pack.push(added);
  return Object.freeze(pack.slice(0, packSize));
}

function selectGreedySet(
  candidates: readonly NestedSetCandidate[],
  initial: readonly NestedSetCandidate[],
  targetSize: number,
  scenarios: readonly string[],
  phase: "head" | "pack"
): SelectionState {
  let selected = [...initial];
  const selectedKeys = new Set(selected.map(({ key }) => key));
  while (selected.length < Math.min(targetSize, candidates.length)) {
    const best = candidates
      .filter(({ key }) => !selectedKeys.has(key))
      .map((candidate) => evaluateChoice([...selected, candidate], scenarios, phase))
      .sort(compareChoices)[0];
    if (best === undefined) break;
    selected = [...best.selected];
    selectedKeys.add(best.selected[best.selected.length - 1]!.key);
  }
  return Object.freeze({
    selected: Object.freeze(selected),
    objective: Object.freeze(objectiveVector(selected, scenarios, phase))
  });
}

function evaluateChoice(
  selected: readonly NestedSetCandidate[],
  scenarios: readonly string[],
  phase: "head" | "pack"
): SelectionState {
  return Object.freeze({
    selected,
    objective: objectiveVector(selected, scenarios, phase)
  });
}

function objectiveVector(
  selected: readonly NestedSetCandidate[],
  scenarios: readonly string[],
  phase: "head" | "pack"
): readonly number[] {
  const scenarioUtilities = scenarios.map((scenario) => selected.reduce(
    (sum, candidate) => sum + rankUtility(candidate.scenarioRanks[scenario]), 0
  ));
  const robustUtility = Math.min(...scenarioUtilities);
  const nominalUtility = scenarioUtilities.reduce((sum, value) => sum + value, 0) /
    Math.max(1, scenarioUtilities.length);
  const coreCoverage = totalCoverage(facilityCoverageByDemand(selected, "core"));
  const supportingCoverage = totalCoverage(
    facilityCoverageByDemand(selected, "supporting")
  );
  const evidenceCoverage = uniqueCount(selected.flatMap((item) =>
    item.evidenceGroup === null ? [] : [item.evidenceGroup]
  ));
  const proposalSupport = selected.reduce((sum, item) => sum + item.proposalSupport, 0);
  const risk = selected.reduce((sum, item) => sum + item.risk, 0);
  const tokens = selected.reduce((sum, item) => sum + item.tokenCost, 0);
  return phase === "head"
    ? [coreCoverage, supportingCoverage, robustUtility, nominalUtility,
      proposalSupport, -risk, -tokens]
    : [coreCoverage, supportingCoverage, evidenceCoverage, robustUtility,
      nominalUtility, proposalSupport, -risk, -tokens];
}

function selectObservedScenarios(
  candidates: readonly NestedSetCandidate[],
  headSize: number
): readonly string[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const [scenario, rank] of Object.entries(candidate.scenarioRanks)) {
      if (finiteRank(rank)) counts.set(scenario, (counts.get(scenario) ?? 0) + 1);
    }
  }
  const scenarios = [...counts.entries()]
    .filter(([, count]) => count >= Math.min(headSize, candidates.length))
    .map(([scenario]) => scenario)
    .sort();
  return scenarios.length === 0 ? Object.freeze(["delivery"]) : Object.freeze(scenarios);
}

function observedCandidateScenarios(
  candidates: readonly NestedSetCandidate[]
): readonly string[] {
  return Object.freeze([...new Set(candidates.flatMap((candidate) =>
    Object.entries(candidate.scenarioRanks)
      .filter(([, rank]) => finiteRank(rank))
      .map(([scenario]) => scenario)
  ))].sort());
}

function normalizeCandidates(
  candidates: readonly Readonly<NestedSetCandidate>[]
): readonly NestedSetCandidate[] {
  const byKey = new Map<string, NestedSetCandidate>();
  for (const candidate of candidates) {
    if (candidate.key.trim().length === 0 || byKey.has(candidate.key)) continue;
    byKey.set(candidate.key, Object.freeze({
      ...candidate,
      scenarioRanks: Object.freeze({ ...candidate.scenarioRanks }),
      coreDemandIds: Object.freeze([...new Set(candidate.coreDemandIds)]),
      conjunctiveCoreDemandIds: Object.freeze([
        ...new Set(candidate.conjunctiveCoreDemandIds)
      ]),
      supportingDemandIds: Object.freeze([...new Set(candidate.supportingDemandIds)]),
      applicabilityDemandIds: Object.freeze([
        ...new Set(candidate.applicabilityDemandIds)
      ]),
      demandCoverage: Object.freeze({ ...candidate.demandCoverage }),
      proposalSupport: finiteNonNegative(candidate.proposalSupport),
      risk: finiteNonNegative(candidate.risk),
      tokenCost: finiteNonNegative(candidate.tokenCost)
    }));
  }
  return Object.freeze([...byKey.values()].sort((left, right) =>
    left.key.localeCompare(right.key)
  ));
}

function compareChoices(left: SelectionState, right: SelectionState): number {
  const objective = compareObjective(right.objective, left.objective);
  if (objective !== 0) return objective;
  return lastKey(left).localeCompare(lastKey(right));
}

function compareObjective(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (Math.abs(delta) > Number.EPSILON) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function lastKey(state: SelectionState): string {
  return state.selected[state.selected.length - 1]?.key ?? "";
}

function rankUtility(rank: number | null | undefined): number {
  return finiteRank(rank) ? 1 / Math.log2(rank + 1) : 0;
}

function finiteRank(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

function rankWithin(value: number | null | undefined, limit: number): boolean {
  return finiteRank(value) && value <= limit;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function facilityCoverageByDemand(
  candidates: readonly NestedSetCandidate[],
  priority: "core" | "supporting"
): ReadonlyMap<string, number> {
  const evidenceByDemand = new Map<string, Map<string, number>>();
  for (const candidate of candidates) {
    const ids = priority === "core" ? candidate.coreDemandIds : candidate.supportingDemandIds;
    const group = candidate.evidenceGroup ?? `candidate:${candidate.key}`;
    for (const id of ids) {
      const strength = bounded(candidate.demandCoverage[id] ?? 0);
      const byEvidence = evidenceByDemand.get(id) ?? new Map<string, number>();
      byEvidence.set(group, Math.max(byEvidence.get(group) ?? 0, strength));
      evidenceByDemand.set(id, byEvidence);
    }
  }
  return new Map([...evidenceByDemand].map(([id, byEvidence]) => [
    id,
    1 - [...byEvidence.values()].reduce((remaining, value) => remaining * (1 - value), 1)
  ]));
}

function preservesCoverage(
  proposed: ReadonlyMap<string, number>,
  incumbent: ReadonlyMap<string, number>
): boolean {
  return [...incumbent].every(([id, value]) =>
    (proposed.get(id) ?? 0) + UTILITY_EPSILON >= value
  );
}

function totalCoverage(coverage: ReadonlyMap<string, number>): number {
  return [...coverage.values()].reduce((sum, value) => sum + value, 0);
}

function bounded(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function uniqueCount(values: readonly string[]): number {
  return new Set(values).size;
}
