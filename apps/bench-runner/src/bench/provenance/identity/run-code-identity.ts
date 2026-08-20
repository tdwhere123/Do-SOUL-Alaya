import {
  WORKTREE_STATE_ALGORITHM_HEAD_LF,
  WORKTREE_STATE_ALGORITHM_V3,
  type WorktreeStateAlgorithm
} from "@do-soul/alaya-eval";
import {
  measureGitState,
  type FrozenCodeIdentity,
  type MeasuredGitState
} from "../contract/frozen-code-contract.js";

export type RunExecutedDistIdentity = {
  readonly algorithm: "sha256-reachable-path-file-sha256-v1";
  readonly sha256: string;
  readonly file_count: number;
};

export async function resolveMeasuredRunGitState(input: {
  readonly frozen: FrozenCodeIdentity | null;
  readonly checkoutRoot: string;
  readonly recordedGitState?: MeasuredGitState;
  readonly measureGitState?: (checkoutRoot: string) => Promise<MeasuredGitState>;
}): Promise<MeasuredGitState> {
  if (input.recordedGitState !== undefined) return input.recordedGitState;
  if (input.frozen !== null) {
    return {
      commitSha: input.frozen.commitSha,
      commitSha7: input.frozen.commitSha7,
      worktreeStateSha256: input.frozen.worktreeStateSha256,
      worktreeStateAlgorithm: input.frozen.worktreeStateAlgorithm,
      worktreeClean: input.frozen.worktreeClean
    };
  }
  const measure = input.measureGitState ??
    // Dirty identity binds nonignored untracked files; executed-dist is what ran.
    ((checkoutRoot: string) => measureGitState(checkoutRoot, { allowDirty: true }));
  return measure(input.checkoutRoot);
}

export function buildRecordedRunCodeIdentity(input: {
  readonly commitSha7: string;
  readonly executedDist: RunExecutedDistIdentity;
  readonly frozen: FrozenCodeIdentity | null;
  readonly measured: MeasuredGitState;
}) {
  const { frozen, measured } = input;
  assertFrozenIdentityMatchesMeasurement(frozen, measured);
  assertMeasuredGitCommit(input.commitSha7, measured);
  const code = {
    commit_sha7: measured.commitSha7,
    ...(frozen === null ? {} : {
      commit_sha: frozen.commitSha,
      gate_contract_path: frozen.gateContractPath
    }),
    gate_sha256: frozen?.gateSha256 ?? null,
    worktree_state_sha256: measured.worktreeStateSha256,
    worktree_state_algorithm: measured.worktreeStateAlgorithm,
    worktree_clean: measured.worktreeClean,
    executed_dist: input.executedDist
  };
  assertRecordedRunCodeIdentity(code);
  return code;
}

export function assertMeasuredGitCommit(
  expectedCommitSha7: string,
  measured: MeasuredGitState
): void {
  if (measured.commitSha.slice(0, 7) !== measured.commitSha7 ||
      expectedCommitSha7 !== measured.commitSha7) {
    throw new Error("archive commit label does not match measured HEAD");
  }
}

function assertFrozenIdentityMatchesMeasurement(
  frozen: FrozenCodeIdentity | null,
  measured: MeasuredGitState
): void {
  if (frozen === null) return;
  if (frozen.commitSha !== measured.commitSha ||
      frozen.commitSha7 !== measured.commitSha7 ||
      frozen.worktreeStateSha256 !== measured.worktreeStateSha256 ||
      frozen.worktreeStateAlgorithm !== measured.worktreeStateAlgorithm ||
      frozen.worktreeClean !== measured.worktreeClean) {
    throw new Error("frozen code identity does not match measured git state");
  }
}

export function assertRecordedRunCodeIdentity(code: {
  readonly worktree_state_sha256: string | null;
  readonly worktree_state_algorithm?: WorktreeStateAlgorithm;
  readonly worktree_clean?: boolean;
  readonly executed_dist: unknown;
}): void {
  if (code.worktree_state_sha256 === null ||
      typeof code.worktree_clean !== "boolean" ||
      code.executed_dist === null) {
    throw new Error("run provenance must record worktree and executed-dist identity");
  }
  const expected = code.worktree_clean
    ? WORKTREE_STATE_ALGORITHM_HEAD_LF
    : WORKTREE_STATE_ALGORITHM_V3;
  if (code.worktree_state_algorithm !== expected) {
    throw new Error("run provenance worktree algorithm does not match clean/dirty identity");
  }
}
