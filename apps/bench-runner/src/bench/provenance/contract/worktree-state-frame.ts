import { createHash } from "node:crypto";
import {
  WORKTREE_STATE_ALGORITHM_HEAD_LF,
  WORKTREE_STATE_ALGORITHM_V2,
  WORKTREE_STATE_ALGORITHM_V3,
  type WorktreeStateAlgorithm
} from "@do-soul/alaya-eval";
import { encodeLabeledPayload } from "./worktree-binary.js";

export {
  WORKTREE_STATE_ALGORITHM_HEAD_LF,
  WORKTREE_STATE_ALGORITHM_V2,
  WORKTREE_STATE_ALGORITHM_V3,
  type WorktreeStateAlgorithm
};

export const WORKTREE_STATE_FRAME_TAG = Buffer.from(
  "alaya.bench.worktree-state.v3\0",
  "utf8"
);

export function hashCleanWorktreeState(headStdout: Buffer): string {
  return createHash("sha256").update(headStdout).digest("hex");
}

export function hashDirtyWorktreeState(input: {
  readonly head: Buffer;
  readonly porcelain: Buffer;
  readonly trackedDiff: Buffer;
  readonly untrackedFrame: Buffer;
}): string {
  return createHash("sha256").update(Buffer.concat([
    WORKTREE_STATE_FRAME_TAG,
    encodeLabeledPayload("head", input.head),
    encodeLabeledPayload("porcelain", input.porcelain),
    encodeLabeledPayload("tracked-diff", input.trackedDiff),
    encodeLabeledPayload("untracked", input.untrackedFrame)
  ])).digest("hex");
}

export function worktreeStateAlgorithmFor(clean: boolean): WorktreeStateAlgorithm {
  return clean ? WORKTREE_STATE_ALGORITHM_HEAD_LF : WORKTREE_STATE_ALGORITHM_V3;
}
