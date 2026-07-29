import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../.."
);

/** Staging root for the closed selection-boundary capture (on-disk dir name kept). */
export const CLOSED_CAPTURE_STAGING_ROOT = join(
  REPO_ROOT,
  ".do-it/bench-runs/recall-any5-evidence-first/p81-500q-f0-baseline-9e58d32/staging"
);

export const CLOSED_CAPTURE_SELECTION_BOUNDARY_A = join(
  CLOSED_CAPTURE_STAGING_ROOT,
  "A/public/2026-07-29T024722Z-9e58d32-policy-stress-recall-eval-snapshot/selection-boundaries.ndjson.gz"
);

export const CLOSED_CAPTURE_SELECTION_BOUNDARY_B = join(
  CLOSED_CAPTURE_STAGING_ROOT,
  "B/public/2026-07-29T025954Z-9e58d32-policy-stress-recall-eval-snapshot/selection-boundaries.ndjson.gz"
);

export const CLOSED_CAPTURE_DIAGNOSTICS_A = join(
  CLOSED_CAPTURE_STAGING_ROOT,
  "A/public/2026-07-29T024722Z-9e58d32-policy-stress-recall-eval-snapshot/recall-eval-diagnostics.json.gz"
);

export const CLOSED_CAPTURE_DIAGNOSTICS_B = join(
  CLOSED_CAPTURE_STAGING_ROOT,
  "B/public/2026-07-29T025954Z-9e58d32-policy-stress-recall-eval-snapshot/recall-eval-diagnostics.json.gz"
);

export const CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_A = join(
  CLOSED_CAPTURE_STAGING_ROOT,
  "A/public/2026-07-29T024722Z-9e58d32-policy-stress-recall-eval-snapshot/selection-counterfactual-gold.json"
);

export const CLOSED_CAPTURE_COUNTERFACTUAL_GOLD_B = join(
  CLOSED_CAPTURE_STAGING_ROOT,
  "B/public/2026-07-29T025954Z-9e58d32-policy-stress-recall-eval-snapshot/selection-counterfactual-gold.json"
);

export const CLOSED_CAPTURE_CF_TOKEN_ROOT = join(
  REPO_ROOT,
  ".do-it/bench-runs/recall-any5-evidence-first/p81-500q-f0-baseline-9e58d32/gate2-cf-token"
);

export const CLOSED_CAPTURE_CF_TOKEN_COMPANION_A_GZIP = join(
  CLOSED_CAPTURE_CF_TOKEN_ROOT,
  "companion-a.ndjson.gz"
);

export const CLOSED_CAPTURE_CF_TOKEN_COMPANION_A_MANIFEST = join(
  CLOSED_CAPTURE_CF_TOKEN_ROOT,
  "companion-a.manifest.json"
);

export const CLOSED_CAPTURE_CF_TOKEN_COMPANION_B_GZIP = join(
  CLOSED_CAPTURE_CF_TOKEN_ROOT,
  "companion-b.ndjson.gz"
);

export const CLOSED_CAPTURE_CF_TOKEN_COMPANION_B_MANIFEST = join(
  CLOSED_CAPTURE_CF_TOKEN_ROOT,
  "companion-b.manifest.json"
);

export async function selectionBoundaryArtifactPresent(
  path: string
): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
