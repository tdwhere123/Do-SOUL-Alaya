import { z } from "zod";

export const WORKTREE_STATE_ALGORITHM_HEAD_LF = "sha256-head-lf";
// Archive-only: never recompute or treat v2 bytes as v3.
export const WORKTREE_STATE_ALGORITHM_V2 = "sha256-worktree-state-v2";
export const WORKTREE_STATE_ALGORITHM_V3 = "sha256-worktree-state-v3";

export const WorktreeStateAlgorithmSchema = z.enum([
  WORKTREE_STATE_ALGORITHM_HEAD_LF,
  WORKTREE_STATE_ALGORITHM_V2,
  WORKTREE_STATE_ALGORITHM_V3
]);

export type WorktreeStateAlgorithm = z.infer<typeof WorktreeStateAlgorithmSchema>;
