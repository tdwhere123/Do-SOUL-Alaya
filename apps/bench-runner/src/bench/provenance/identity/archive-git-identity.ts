import {
  measureGitState,
  type MeasuredGitState
} from "../contract/frozen-code-contract.js";
import { resolveBenchCheckoutRoot } from "./checkout-root.js";
import { composeBenchHistorySlug } from "./history-code-slug.js";

export type ArchiveGitIdentityInput = {
  readonly recordedGitState?: MeasuredGitState;
  readonly measureGitState?: (checkoutRoot: string) => Promise<MeasuredGitState>;
};

export async function resolveArchiveGitState(
  input: ArchiveGitIdentityInput = {}
): Promise<MeasuredGitState> {
  if (input.recordedGitState !== undefined) return input.recordedGitState;
  const measure = input.measureGitState ??
    ((checkoutRoot: string) => measureGitState(checkoutRoot, { allowDirty: true }));
  return measure(resolveBenchCheckoutRoot());
}

export function freezeGitStateMeasurement(
  recorded: MeasuredGitState
): (checkoutRoot: string) => Promise<MeasuredGitState> {
  return async () => recorded;
}

export function composeArchiveHistorySlug(input: {
  readonly runAt: Date;
  readonly commitSha7: string;
  readonly policyDiscriminator?: string;
  readonly recorded: MeasuredGitState;
}): string {
  return composeBenchHistorySlug({
    runAt: input.runAt,
    commitSha7: input.commitSha7,
    ...(input.policyDiscriminator === undefined
      ? {}
      : { policyDiscriminator: input.policyDiscriminator }),
    worktreeClean: input.recorded.worktreeClean,
    worktreeStateSha256: input.recorded.worktreeStateSha256
  });
}
