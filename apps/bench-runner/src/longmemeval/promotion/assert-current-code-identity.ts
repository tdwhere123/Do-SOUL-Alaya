import { isDeepStrictEqual } from "node:util";
import {
  resolveFrozenCodeIdentity,
  type FrozenCodeIdentity
} from "../provenance/contract/frozen-code-contract.js";
import { computeExecutedDistIdentityFresh } from "../provenance/run.js";
import type { LongMemEvalMatrixPromotionContract } from "./schema/contract.js";

export interface PromotionCodeIdentityInput {
  readonly checkoutRoot: string;
  readonly contractPath: string;
}

export interface PromotionCodeIdentityDependencies {
  readonly resolveFrozenCodeIdentity: typeof resolveFrozenCodeIdentity;
  readonly computeExecutedDistIdentity: () => Promise<unknown>;
}

export const DEFAULT_PROMOTION_CODE_IDENTITY_DEPENDENCIES:
  PromotionCodeIdentityDependencies = {
    resolveFrozenCodeIdentity,
    computeExecutedDistIdentity: computeExecutedDistIdentityFresh
  };

/** Live HEAD + executed_dist must match contract.code — not receipt-only. */
export async function assertCurrentPromotionCodeIdentity(
  input: PromotionCodeIdentityInput,
  parsed: {
    readonly sha256: string;
    readonly contract: {
      readonly code: LongMemEvalMatrixPromotionContract["code"];
    };
  },
  dependencies: PromotionCodeIdentityDependencies =
    DEFAULT_PROMOTION_CODE_IDENTITY_DEPENDENCIES
): Promise<void> {
  const frozen = await dependencies.resolveFrozenCodeIdentity({
    checkoutRoot: input.checkoutRoot,
    expectedCommitSha7: parsed.contract.code.commit_sha7,
    env: {
      ALAYA_BENCH_GATE_CONTRACT_PATH: input.contractPath,
      ALAYA_BENCH_GATE_SHA256: parsed.sha256,
      ALAYA_BENCH_WORKTREE_STATE_SHA256: parsed.contract.code.worktree_state_sha256
    }
  });
  assertFrozenCodeIdentity(frozen, parsed.contract.code, parsed.sha256);
  const executedDist = await dependencies.computeExecutedDistIdentity();
  if (!isDeepStrictEqual(executedDist, parsed.contract.code.executed_dist)) {
    throw new Error("current executed dist differs from promotion contract");
  }
}

function assertFrozenCodeIdentity(
  frozen: FrozenCodeIdentity | null,
  code: LongMemEvalMatrixPromotionContract["code"],
  contractSha256: string
): void {
  if (frozen === null) throw new Error("promotion contract did not verify current code");
  if (frozen.gateSha256 !== contractSha256) {
    throw new Error("live promotion contract digest differs from descriptor input");
  }
  if (frozen.commitSha !== code.commit_sha || frozen.commitSha7 !== code.commit_sha7 ||
      frozen.worktreeStateSha256 !== code.worktree_state_sha256) {
    throw new Error("current git identity differs from promotion contract");
  }
}
