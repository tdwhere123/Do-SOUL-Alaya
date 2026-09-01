import { digestRecallFieldIdentity } from "../../../field/field-identity.js";
import { freezeShadow, ShadowContractError } from "../../contract-primitives.js";
import { SHADOW_CAPTURE_OPERATOR_ID } from "../../prefix-capture/identity.js";
import {
  isCompiledTuple,
  type ShadowWalkUtilityTransfer,
  type WalkGammaScore
} from "../../prefix-capture/walk-transfer.js";
import {
  compareQueryGammaTuple,
  type QueryCompiledGammaV1
} from "./contract.js";
import {
  acceptQueryGammaCandidate,
  admitCompiledLowerFrontier,
  emptyQueryGammaSelectedSet,
  evaluateQueryGammaTuple,
  novelQueryGammaAtomIds,
  type QueryGammaSelectedSetV1
} from "./evaluate.js";

export function createQueryCompiledWalkTransfer(
  compiled: QueryCompiledGammaV1
): ShadowWalkUtilityTransfer {
  if (compiled.compile_status !== "compiled") {
    throw new ShadowContractError("query-compiled Gamma transfer requires a compiled contract");
  }
  const contractDigest = digestRecallFieldIdentity({
    kind: "query_compiled_gamma",
    walk_operator_id: SHADOW_CAPTURE_OPERATOR_ID,
    gamma_digest: compiled.gamma_digest
  });
  return Object.freeze({
    kind: "query_compiled_gamma" as const,
    contract_digest: contractDigest,
    emptySet: () => emptyQueryGammaSelectedSet(),
    score: (candidate, selected) =>
      evaluateQueryGammaTuple(compiled, asCompiledSet(selected), candidate.candidate_key),
    compare: (left, right) => compareQueryGammaTuple(
      asCompiledTuple(left),
      asCompiledTuple(right)
    ),
    gainAtomIds: (candidate, selected) => novelQueryGammaAtomIds(
      compiled,
      asCompiledSet(selected),
      candidate.candidate_key
    ),
    admitLowerFrontier: (candidate, core, selected) => {
      const admission = admitCompiledLowerFrontier(
        compiled,
        asCompiledSet(selected),
        candidate.candidate_key,
        core.map((member) => member.candidate_key)
      );
      return freezeShadow({
        admitted: admission.admitted,
        status: admission.status,
        named_novelty: freezeShadow({
          facility_keys: Object.freeze([] as string[]),
          value_pairs: Object.freeze([] as string[]),
          content_ids: Object.freeze([] as string[]),
          compiled_atom_ids: admission.compiled_atom_ids
        }),
        core_absence: Object.freeze([] as const)
      });
    },
    accept: (selected, candidate) => acceptQueryGammaCandidate(
      asCompiledSet(selected),
      compiled,
      candidate.candidate_key,
      candidate.object_key,
      candidate.token_cost,
      candidate.dimension
    )
  });
}

function asCompiledSet(selected: unknown): QueryGammaSelectedSetV1 {
  if (typeof selected !== "object" || selected === null ||
      !("covered_atom_ids" in selected)) {
    throw new ShadowContractError("compiled Gamma transfer cannot read a live selected set");
  }
  const covered = (selected as { readonly covered_atom_ids?: { readonly has?: unknown } })
    .covered_atom_ids;
  if (typeof covered?.has !== "function") {
    throw new ShadowContractError("compiled Gamma transfer cannot read a live selected set");
  }
  return selected as QueryGammaSelectedSetV1;
}

function asCompiledTuple(score: object): ReturnType<typeof evaluateQueryGammaTuple> {
  if (!isCompiledTuple(score as WalkGammaScore)) {
    throw new ShadowContractError("compiled Gamma compare received live facility tuple");
  }
  return score as ReturnType<typeof evaluateQueryGammaTuple>;
}
