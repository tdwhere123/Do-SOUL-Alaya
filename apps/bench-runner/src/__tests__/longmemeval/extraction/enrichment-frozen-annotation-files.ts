import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Gitignored local corpus. Skip the real-annotation cases when this checkout
// does not have the files; do not bind them to a developer home path.
const WORKTREE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../");

export const FROZEN_ENRICHMENT_REGRESSION_PATH = join(
  WORKTREE_ROOT,
  ".do-it/bench-runs/associative-field-gemini-source-scope-20260914/regression-source-review.json"
);
export const FROZEN_ENRICHMENT_CANONICAL_PATH = join(
  WORKTREE_ROOT,
  ".do-it/bench-runs/associative-field-gemini-source-scope-20260914/canonical-source-review.json"
);
export const FROZEN_ENRICHMENT_ANNOTATIONS_AVAILABLE =
  existsSync(FROZEN_ENRICHMENT_REGRESSION_PATH) && existsSync(FROZEN_ENRICHMENT_CANONICAL_PATH);
