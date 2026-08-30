import {
  RecallCandidateObjectKindSchema
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import type { ShadowGammaTuple, ShadowObligationKey, ShadowSetUtilityInput } from "./capture.js";
import { freezeShadow, ShadowContractError } from "../contract-primitives.js";
import {
  createPsiCycleFailure,
  type PsiQuery,
  type ShadowPsiCycleFailure
} from "../dominance-contract.js";
import {
  acceptCandidate,
  compareGammaTuple,
  computeGammaTuple,
  emptySelectedSet,
  evaluateOtherwiseUnavailableNovelty,
  obligationUniverseFrom,
  type ShadowNoveltyAdmit,
  type ShadowSelectedSet
} from "./gamma-tuple.js";
import { SHADOW_CAPTURE_OPERATOR_ID, SHADOW_DETERMINISTIC_TAIL } from "./identity.js";
import {
  parseCaptureDecisionReceipt,
  type ShadowCaptureDecisionReceipt
} from "./receipts.js";

export type ShadowCaptureWalkCandidate = Readonly<{
  readonly candidate_key: string;
  readonly object_key: string;
  readonly token_cost: number;
  readonly dimension: string;
  readonly h_eligible: boolean;
  readonly utility: ShadowSetUtilityInput;
  readonly static_frontier_index: number | null;
}>;

export type ShadowCaptureWalkInput = Readonly<{
  readonly candidates: readonly ShadowCaptureWalkCandidate[];
  readonly psi: PsiQuery;
  readonly token_budget: number;
  readonly per_dimension_limits: Readonly<Record<string, number>> | null;
  readonly unresolved_tradeoff?: (left: string, right: string) => boolean;
  readonly obligation_universe?: readonly ShadowObligationKey[];
}>;

export type ShadowWalkConstraintReject = Readonly<{
  readonly candidate_key: string;
  readonly walk_reject: Exclude<ShadowCaptureDecisionReceipt["walk_reject"], "none">;
}>;

export type ShadowCapturedWalk = Readonly<{
  readonly kind: "captured";
  readonly operator_id: typeof SHADOW_CAPTURE_OPERATOR_ID;
  readonly S_infty: readonly string[];
  readonly decisions: readonly ShadowCaptureDecisionReceipt[];
  readonly walk_rejects: readonly ShadowWalkConstraintReject[];
}>;

export type ShadowCaptureWalkResult = ShadowCapturedWalk | ShadowPsiCycleFailure;

type WalkState = {
  readonly psi: PsiQuery;
  readonly unresolved_tradeoff: ((left: string, right: string) => boolean) | undefined;
  readonly token_budget: number;
  readonly per_dimension_limits: Readonly<Record<string, number>> | null;
  readonly universe: readonly ShadowObligationKey[];
  readonly startEligibleCount: number;
  remaining: Map<string, ShadowCaptureWalkCandidate>;
  selected_keys: string[];
  object_keys: Set<string>;
  used_tokens: number;
  dim_count: Map<string, number>;
  set: ShadowSelectedSet;
  decisions: ShadowCaptureDecisionReceipt[];
  walk_rejects: ShadowWalkConstraintReject[];
};

type ScoredCandidate = Readonly<{
  readonly candidate: ShadowCaptureWalkCandidate;
  readonly G: ShadowGammaTuple;
}>;

const CYCLE: ShadowPsiCycleFailure = createPsiCycleFailure();

export function walkShadowCapture(
  input: ShadowCaptureWalkInput
): ShadowCaptureWalkResult {
  const state = createWalkState(input);
  while (state.remaining.size > 0) {
    applyInfeasibleDrops(state);
    if (state.remaining.size === 0) break;
    const picked = computePick(state);
    if (isCycleFailure(picked)) return picked;
    applyPick(state, picked);
  }
  const captured: ShadowCapturedWalk = {
    kind: "captured",
    operator_id: SHADOW_CAPTURE_OPERATOR_ID,
    S_infty: Object.freeze([...state.selected_keys]),
    decisions: Object.freeze([...state.decisions]),
    walk_rejects: Object.freeze([...state.walk_rejects])
  };
  return freezeShadow(captured);
}

function isCycleFailure(
  value: ShadowCaptureWalkCandidate | ShadowPsiCycleFailure
): value is ShadowPsiCycleFailure {
  return "kind" in value && value.kind === "psi_cycle_contract_failure";
}

export function prefixSK(
  S_infty: readonly string[],
  k: number
): readonly string[] {
  if (!Number.isInteger(k) || k <= 0) return Object.freeze([]);
  return Object.freeze(S_infty.slice(0, Math.min(k, S_infty.length)));
}

export function isCapturedWalk(
  result: ShadowCaptureWalkResult
): result is ShadowCapturedWalk {
  return result.kind === "captured";
}

export type DeterministicTailPickEvidence = Pick<
  ShadowCaptureDecisionReceipt,
  "max_g_cohort" | "equal_g_dominance_rejects"
>;

export function deterministicTailDecidedThisPick(
  receipt: DeterministicTailPickEvidence
): boolean {
  return receipt.max_g_cohort.length > 1 &&
    receipt.equal_g_dominance_rejects.length === 0;
}

function createWalkState(input: ShadowCaptureWalkInput): WalkState {
  const remaining = new Map<string, ShadowCaptureWalkCandidate>();
  for (const candidate of input.candidates) {
    if (!candidate.h_eligible) continue;
    validateCandidate(candidate);
    if (remaining.has(candidate.candidate_key)) {
      throw new ShadowContractError("duplicate candidate_key in walk input");
    }
    remaining.set(candidate.candidate_key, candidate);
  }
  const utilities = [...remaining.values()].map((candidate) => candidate.utility);
  return {
    psi: input.psi,
    unresolved_tradeoff: input.unresolved_tradeoff,
    token_budget: input.token_budget,
    per_dimension_limits: input.per_dimension_limits,
    universe: input.obligation_universe ?? obligationUniverseFrom(utilities),
    remaining,
    selected_keys: [],
    object_keys: new Set(),
    used_tokens: 0,
    dim_count: new Map(),
    set: emptySelectedSet(),
    decisions: [],
    walk_rejects: [],
    startEligibleCount: remaining.size
  };
}

function validateCandidate(candidate: ShadowCaptureWalkCandidate): void {
  if (candidate.candidate_key !== candidate.utility.candidate_key ||
      candidate.object_key !== candidate.utility.object_key) {
    throw new ShadowContractError("walk candidate identity must match set-utility");
  }
  if (!Number.isFinite(candidate.token_cost) || candidate.token_cost <= 0) {
    throw new ShadowContractError("token_cost must be finite and positive");
  }
  if (candidate.dimension.length === 0) {
    throw new ShadowContractError("dimension is required");
  }
  const index = candidate.static_frontier_index;
  if (index !== null && (!Number.isInteger(index) || index < 1)) {
    throw new ShadowContractError("static_frontier_index is structure only");
  }
}

function applyInfeasibleDrops(state: WalkState): void {
  const keys = [...state.remaining.keys()].sort(compareText);
  for (const key of keys) {
    const candidate = state.remaining.get(key);
    if (candidate === undefined) continue;
    const reason = infeasibleReason(candidate, state);
    if (reason === null) continue;
    state.remaining.delete(key);
    state.walk_rejects.push(freezeShadow({
      candidate_key: key,
      walk_reject: reason
    }));
  }
}

function infeasibleReason(
  candidate: ShadowCaptureWalkCandidate,
  state: WalkState
): ShadowWalkConstraintReject["walk_reject"] | null {
  if (state.object_keys.has(candidate.object_key)) return "duplicate_object";
  if (state.used_tokens + candidate.token_cost > state.token_budget) {
    return "max_total_tokens";
  }
  if (dimensionExhausted(candidate, state)) return "dimension_limit";
  return null;
}

function dimensionExhausted(
  candidate: ShadowCaptureWalkCandidate,
  state: WalkState
): boolean {
  if (state.per_dimension_limits === null) return false;
  const limit = state.per_dimension_limits[candidate.dimension];
  if (limit === undefined) return false;
  return (state.dim_count.get(candidate.dimension) ?? 0) >= limit;
}

function computePick(
  state: WalkState
): ShadowCaptureWalkCandidate | ShadowPsiCycleFailure {
  const feasible = [...state.remaining.values()];
  const core = firstLayerOrUndominated(feasible, state);
  if (core.length === 0) return CYCLE;
  const choice = choiceSet(feasible, core, state);
  const scored = choice.map((candidate) => freezeShadow({
    candidate,
    G: computeGammaTuple(candidate.utility, state.set, state.universe)
  }));
  const maxG = maxCohort(scored);
  const tPsi = undominated(maxG.map((row) => row.candidate), state.psi);
  if (tPsi.length === 0) return CYCLE;
  const winner = smallestCandidate(tPsi);
  state.decisions.push(buildDecision(winner, core, maxG, tPsi, state));
  return winner;
}

function firstLayerOrUndominated(
  feasible: readonly ShadowCaptureWalkCandidate[],
  state: WalkState
): ShadowCaptureWalkCandidate[] {
  // Peel already named F1 on this remaining set; another full-H scan repeats it.
  if (
    feasible.length === state.startEligibleCount &&
    feasible.every((candidate) => candidate.static_frontier_index !== null)
  ) {
    const first = feasible.filter((candidate) => candidate.static_frontier_index === 1);
    if (first.length > 0) return first;
  }
  return undominated(feasible, state.psi);
}

function choiceSet(
  feasible: readonly ShadowCaptureWalkCandidate[],
  core: readonly ShadowCaptureWalkCandidate[],
  state: WalkState
): readonly ShadowCaptureWalkCandidate[] {
  const coreKeys = new Set(core.map((candidate) => candidate.candidate_key));
  const extras = feasible.filter((candidate) =>
    !coreKeys.has(candidate.candidate_key) &&
    evaluateOtherwiseUnavailableNovelty(
      candidate.utility,
      core.map((member) => member.utility),
      state.set,
      state.universe
    ).admitted
  );
  return [...core, ...extras];
}

function maxCohort(scored: readonly ScoredCandidate[]): readonly ScoredCandidate[] {
  if (scored.length === 0) return [];
  let max = scored[0]!.G;
  for (const row of scored) {
    if (compareGammaTuple(row.G, max) > 0) max = row.G;
  }
  return scored.filter((row) => compareGammaTuple(row.G, max) === 0);
}

function undominated<T extends { readonly candidate_key: string }>(
  members: readonly T[],
  psi: PsiQuery
): T[] {
  return members.filter((member) =>
    !members.some((other) =>
      other.candidate_key !== member.candidate_key &&
      psi(other.candidate_key, member.candidate_key)
    )
  );
}

function smallestCandidate(
  members: readonly ShadowCaptureWalkCandidate[]
): ShadowCaptureWalkCandidate {
  assertUniqueEqualGTailKeys(members);
  let best = members[0]!;
  for (const member of members) {
    if (compareText(
      equalGTailKey(member.candidate_key),
      equalGTailKey(best.candidate_key)
    ) < 0) best = member;
  }
  return best;
}

function assertUniqueEqualGTailKeys(
  members: readonly ShadowCaptureWalkCandidate[]
): void {
  // Distinct membership keys can share origin+object_id; input order is not a tail.
  const owners = new Map<string, string>();
  for (const member of members) {
    const tail = equalGTailKey(member.candidate_key);
    const owner = owners.get(tail);
    if (owner !== undefined && owner !== member.candidate_key) {
      throw new ShadowContractError("equal-G tail key collision");
    }
    owners.set(tail, member.candidate_key);
  }
}

// Kind in origin:kind:id ranks evidence_capsule before memory_entry.
function equalGTailKey(candidateKey: string): string {
  const first = candidateKey.indexOf(":");
  if (first <= 0) return candidateKey;
  const second = candidateKey.indexOf(":", first + 1);
  if (second < 0 || second === candidateKey.length - 1) return candidateKey;
  const kind = candidateKey.slice(first + 1, second);
  if (RecallCandidateObjectKindSchema.safeParse(kind).success === false) {
    return candidateKey;
  }
  return `${candidateKey.slice(0, first)}:${candidateKey.slice(second + 1)}`;
}

function buildDecision(
  winner: ShadowCaptureWalkCandidate,
  core: readonly ShadowCaptureWalkCandidate[],
  maxG: readonly ScoredCandidate[],
  tPsi: readonly ShadowCaptureWalkCandidate[],
  state: WalkState
): ShadowCaptureDecisionReceipt {
  const inCore = core.some((member) => member.candidate_key === winner.candidate_key);
  const novelty = inCore
    ? emptyNovelty()
    : evaluateOtherwiseUnavailableNovelty(
      winner.utility,
      core.map((member) => member.utility),
      state.set,
      state.universe
    );
  const winnerG = maxG.find((row) => row.candidate.candidate_key === winner.candidate_key)?.G
    ?? computeGammaTuple(winner.utility, state.set, state.universe);
  const tPsiKeys = new Set(tPsi.map((member) => member.candidate_key));
  return parseCaptureDecisionReceipt({
    schema_version: 1,
    candidate_key: winner.candidate_key,
    capture_reason: inCore ? "core_undominated" : "cross_frontier_novelty",
    G: winnerG,
    G_status: winner.utility.availability,
    named_novelty: namedNovelty(novelty, inCore),
    novelty_core_known_absence: inCore ? [] : novelty.core_absence.map(toAbsenceReceipt),
    max_g_cohort: Object.freeze(
      maxG.map((row) => row.candidate.candidate_key).sort(compareText)
    ),
    equal_g_dominance_rejects: equalGRejects(maxG, tPsiKeys, state.psi),
    deterministic_tail: SHADOW_DETERMINISTIC_TAIL,
    unresolved_pointwise_tradeoff: unresolvedTradeoff(tPsi, state.unresolved_tradeoff),
    h_gate: "none",
    walk_reject: "none",
    static_frontier_index: winner.static_frontier_index
  });
}

function equalGRejects(
  maxG: readonly ScoredCandidate[],
  tPsiKeys: ReadonlySet<string>,
  psi: PsiQuery
): readonly { candidate_key: string; dominated_by: string }[] {
  const rejects = maxG
    .map((row) => row.candidate.candidate_key)
    .filter((key) => !tPsiKeys.has(key))
    .sort(compareText)
    .map((key) => ({
      candidate_key: key,
      dominated_by: smallestDominator(key, maxG, psi)
    }));
  return Object.freeze(rejects);
}

function smallestDominator(
  key: string,
  maxG: readonly ScoredCandidate[],
  psi: PsiQuery
): string {
  const dominators = maxG
    .map((row) => row.candidate.candidate_key)
    .filter((other) => other !== key && psi(other, key))
    .sort(compareText);
  const dominator = dominators[0];
  if (dominator === undefined) {
    throw new ShadowContractError("equal-G reject missing Psi dominator");
  }
  return dominator;
}

function unresolvedTradeoff(
  tPsi: readonly ShadowCaptureWalkCandidate[],
  query: ((left: string, right: string) => boolean) | undefined
): boolean {
  if (query === undefined || tPsi.length < 2) return false;
  for (let i = 0; i < tPsi.length; i += 1) {
    for (let j = i + 1; j < tPsi.length; j += 1) {
      const left = tPsi[i]!.candidate_key;
      const right = tPsi[j]!.candidate_key;
      if (query(left, right) || query(right, left)) return true;
    }
  }
  return false;
}

function applyPick(state: WalkState, picked: ShadowCaptureWalkCandidate): void {
  state.remaining.delete(picked.candidate_key);
  state.selected_keys.push(picked.candidate_key);
  state.object_keys.add(picked.object_key);
  state.used_tokens += picked.token_cost;
  state.dim_count.set(
    picked.dimension,
    (state.dim_count.get(picked.dimension) ?? 0) + 1
  );
  state.set = acceptCandidate(state.set, picked.utility, state.universe);
  const duplicates = [...state.remaining.values()]
    .filter((candidate) => candidate.object_key === picked.object_key)
    .map((candidate) => candidate.candidate_key)
    .sort(compareText);
  for (const key of duplicates) {
    state.remaining.delete(key);
    state.walk_rejects.push(freezeShadow({
      candidate_key: key,
      walk_reject: "duplicate_object" as const
    }));
  }
}

function namedNovelty(
  novelty: ShadowNoveltyAdmit,
  inCore: boolean
): ShadowCaptureDecisionReceipt["named_novelty"] {
  if (inCore) {
    return freezeShadow({
      facility_keys: Object.freeze([] as string[]),
      value_pairs: Object.freeze([] as string[]),
      content_ids: Object.freeze([] as string[])
    });
  }
  return freezeShadow({
    facility_keys: novelty.facility_keys,
    value_pairs: novelty.value_pairs,
    content_ids: novelty.content_ids
  });
}

function emptyNovelty(): ShadowNoveltyAdmit {
  return freezeShadow({
    admitted: false,
    facility_keys: Object.freeze([] as string[]),
    value_pairs: Object.freeze([] as string[]),
    content_ids: Object.freeze([] as string[]),
    core_absence: Object.freeze([] as ShadowNoveltyAdmit["core_absence"])
  });
}

function toAbsenceReceipt(
  absence: ShadowNoveltyAdmit["core_absence"][number]
): Readonly<{
  witness: "facility" | "values" | "evidence_identity";
  core_candidate_key: string;
  status: "available_known_absent";
  basis: string;
}> {
  return freezeShadow({
    witness: absence.witness,
    core_candidate_key: absence.core_candidate_key,
    status: "available_known_absent" as const,
    basis: absence.basis
  });
}
