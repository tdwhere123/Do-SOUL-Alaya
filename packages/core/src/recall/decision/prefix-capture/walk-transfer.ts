import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import { freezeShadow, ShadowContractError } from "../contract-primitives.js";
import type {
  ShadowGammaTuple,
  ShadowObligationKey,
  ShadowSetUtilityInput
} from "./capture.js";
import type { QueryCompiledWalkGamma } from "./receipts.js";
import {
  acceptCandidate,
  compareGammaTuple,
  computeGammaTuple,
  emptySelectedSet,
  evaluateOtherwiseUnavailableNovelty,
  type ShadowNoveltyAdmit,
  type ShadowSelectedSet
} from "./gamma-tuple.js";
import { SHADOW_CAPTURE_OPERATOR_ID } from "./identity.js";
import type { ShadowNamedNovelty } from "./receipts.js";

export type ShadowWalkTransferCandidate = Readonly<{
  readonly candidate_key: string;
  readonly object_key: string;
  readonly token_cost: number;
  readonly dimension: string;
  readonly utility: ShadowSetUtilityInput;
}>;

export type WalkGammaScore = ShadowGammaTuple | QueryCompiledWalkGamma;

export type ShadowWalkAdmit = Readonly<{
  readonly admitted: boolean;
  readonly status: "admitted" | "denied" | "unresolved";
  readonly named_novelty: ShadowNamedNovelty;
  readonly core_absence: ShadowNoveltyAdmit["core_absence"];
}>;

export type ShadowWalkUtilityTransfer = Readonly<{
  readonly kind: "live_facility" | "query_compiled_gamma";
  readonly contract_digest: RecallFieldDigest;
  readonly emptySet: (
    universe: readonly ShadowObligationKey[],
    candidates: readonly ShadowWalkTransferCandidate[]
  ) => unknown;
  readonly score: (
    candidate: ShadowWalkTransferCandidate,
    selected: unknown,
    universe: readonly ShadowObligationKey[]
  ) => WalkGammaScore;
  readonly compare: (left: WalkGammaScore, right: WalkGammaScore) => number;
  readonly gainAtomIds: (
    candidate: ShadowWalkTransferCandidate,
    selected: unknown
  ) => readonly string[];
  readonly admitLowerFrontier: (
    candidate: ShadowWalkTransferCandidate,
    core: readonly ShadowWalkTransferCandidate[],
    selected: unknown,
    universe: readonly ShadowObligationKey[]
  ) => ShadowWalkAdmit;
  readonly accept: (
    selected: unknown,
    candidate: ShadowWalkTransferCandidate,
    universe: readonly ShadowObligationKey[]
  ) => unknown;
}>;

const LIVE_CONTRACT = digestRecallFieldIdentity({
  operator_id: SHADOW_CAPTURE_OPERATOR_ID,
  kind: "live_facility"
});

export const LIVE_FACILITY_WALK_TRANSFER: ShadowWalkUtilityTransfer = Object.freeze({
  kind: "live_facility" as const,
  contract_digest: LIVE_CONTRACT,
  emptySet: () => emptySelectedSet(),
  score: (candidate, selected, universe) =>
    computeGammaTuple(candidate.utility, asLiveSet(selected), universe),
  compare: (left, right) => compareGammaTuple(asLiveTuple(left), asLiveTuple(right)),
  gainAtomIds: () => Object.freeze([]),
  admitLowerFrontier: (candidate, core, selected, universe) => {
    const novelty = evaluateOtherwiseUnavailableNovelty(
      candidate.utility,
      core.map((member) => member.utility),
      asLiveSet(selected),
      universe
    );
    return freezeShadow({
      admitted: novelty.admitted,
      status: novelty.admitted ? "admitted" as const : "denied" as const,
      named_novelty: freezeShadow({
        facility_keys: novelty.facility_keys,
        value_pairs: novelty.value_pairs,
        content_ids: novelty.content_ids
      }),
      core_absence: novelty.core_absence
    });
  },
  accept: (selected, candidate, universe) =>
    acceptCandidate(asLiveSet(selected), candidate.utility, universe)
});

export function assertUnmixedWalkTransfer(
  transfer: ShadowWalkUtilityTransfer,
  score: WalkGammaScore,
  novelty: ShadowNamedNovelty
): void {
  const liveNamed = novelty.facility_keys.length + novelty.value_pairs.length +
    novelty.content_ids.length;
  const compiledNamed = novelty.compiled_atom_ids?.length ?? 0;
  if (transfer.kind === "query_compiled_gamma") {
    if (!isCompiledTuple(score)) {
      throw new ShadowContractError("compiled Gamma transfer cannot keep live scoring");
    }
    if (liveNamed > 0) {
      throw new ShadowContractError("compiled Gamma transfer cannot keep live novelty admission");
    }
    return;
  }
  if (isCompiledTuple(score) || compiledNamed > 0) {
    throw new ShadowContractError("live facility transfer cannot mix compiled Gamma");
  }
}

function asLiveSet(selected: unknown): ShadowSelectedSet {
  if (typeof selected !== "object" || selected === null ||
      !("best_cover" in selected)) {
    throw new ShadowContractError(
      "live facility admission cannot read a compiled selected set"
    );
  }
  const cover = (selected as { readonly best_cover?: { readonly has?: unknown } }).best_cover;
  if (typeof cover?.has !== "function") {
    throw new ShadowContractError(
      "live facility admission cannot read a compiled selected set"
    );
  }
  return selected as ShadowSelectedSet;
}

function asLiveTuple(score: WalkGammaScore): ShadowGammaTuple {
  if (isCompiledTuple(score)) {
    throw new ShadowContractError("live facility compare received compiled Gamma");
  }
  return score;
}

export function isCompiledTuple(score: WalkGammaScore): score is QueryCompiledWalkGamma {
  return "answer_binding_position" in score;
}
