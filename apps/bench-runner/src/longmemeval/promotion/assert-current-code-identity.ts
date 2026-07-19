import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  measureGitState,
  type MeasuredGitState
} from "../provenance/contract/frozen-code-contract.js";
import { computeExecutedDistIdentityFresh } from "../provenance/run.js";
import {
  PromotionValidatorIdentitySchema,
  type PromotionValidatorIdentity
} from "./schema/authorization.js";

export interface PromotionCodeIdentityInput {
  readonly checkoutRoot: string;
  readonly contractPath: string;
}

export interface PromotionCodeIdentityDependencies {
  readonly measureValidatorGitState: (
    checkoutRoot: string
  ) => Promise<MeasuredGitState>;
  readonly readContractSha256: (contractPath: string) => Promise<string>;
  readonly computeExecutedDistIdentity: () => Promise<unknown>;
}

export const DEFAULT_PROMOTION_CODE_IDENTITY_DEPENDENCIES:
  PromotionCodeIdentityDependencies = {
    measureValidatorGitState: (checkoutRoot) =>
      measureGitState(checkoutRoot, { allowDirty: true }),
    readContractSha256,
    computeExecutedDistIdentity: computeExecutedDistIdentityFresh
  };

/** Record live validator checkout; do not require equality with producer code. */
export async function resolveCurrentPromotionValidatorIdentity(
  input: PromotionCodeIdentityInput,
  parsed: { readonly sha256: string },
  dependencies: PromotionCodeIdentityDependencies =
    DEFAULT_PROMOTION_CODE_IDENTITY_DEPENDENCIES
): Promise<PromotionValidatorIdentity> {
  const gateSha256 = await dependencies.readContractSha256(input.contractPath);
  if (gateSha256 !== parsed.sha256) {
    throw new Error("live promotion contract digest differs from descriptor input");
  }
  const git = await dependencies.measureValidatorGitState(input.checkoutRoot);
  const executedDist = await dependencies.computeExecutedDistIdentity();
  return PromotionValidatorIdentitySchema.parse({
    commit_sha: git.commitSha,
    commit_sha7: git.commitSha7,
    worktree_clean: git.worktreeClean,
    worktree_state_sha256: git.worktreeStateSha256,
    executed_dist: executedDist
  });
}

export function assertStablePromotionValidatorIdentity(
  before: PromotionValidatorIdentity,
  after: PromotionValidatorIdentity
): void {
  if (!isDeepStrictEqual(before, after)) {
    throw new Error("promotion validator identity drifted during authorization");
  }
}

async function readContractSha256(contractPath: string): Promise<string> {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("promotion contract no-follow validation is unavailable");
  }
  const handle = await open(contractPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const raw = await handle.readFile();
    return createHash("sha256").update(raw).digest("hex");
  } finally {
    await handle.close();
  }
}
