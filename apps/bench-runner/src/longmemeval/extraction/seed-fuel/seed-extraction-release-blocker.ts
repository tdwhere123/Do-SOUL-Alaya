// @anchor seed-extraction-release-blocker
// Bench-runner CLI surface for the seed-extraction release blocker.
// Source of truth lives in packages/eval/src/gates/seed-extraction-blocker.ts
// so both the CLI exit and latest_passing gate share one rule.
// see also: packages/eval/src/gates/release-gates.ts — releaseHardGateAllowsLatestPassing
// see also: packages/eval/src/gates/seed-extraction-blocker.ts — shared judgment
import {
  evaluateSeedExtractionReleaseBlocker,
  hasSeedExtractionReleaseBlocker as hasSharedSeedExtractionReleaseBlocker,
  type KpiPayload
} from "@do-soul/alaya-eval";

interface SeedExtractionReleaseBlocker {
  readonly id: string;
  readonly detail: string;
}

export function seedExtractionReleaseBlockerExitCode(
  payload: KpiPayload
): number {
  return hasSharedSeedExtractionReleaseBlocker(payload) ? 1 : 0;
}

export function hasSeedExtractionReleaseBlocker(payload: KpiPayload): boolean {
  return hasSharedSeedExtractionReleaseBlocker(payload);
}

export function appendSeedExtractionReleaseBlockerToReport(
  report: string,
  payload: KpiPayload
): string {
  const blocker = evaluateSeedExtractionReleaseBlocker(payload);
  if (blocker === null) {
    return report;
  }
  return (
    report.trimEnd() +
    "\n\n## Release evidence blockers\n\n" +
    renderSeedExtractionBlockerBullet(blocker)
  );
}

export function appendSeedExtractionReleaseBlockerToFindings(
  findings: string | null,
  payload: KpiPayload
): string | null {
  const blocker = evaluateSeedExtractionReleaseBlocker(payload);
  if (blocker === null) {
    return findings;
  }
  const section =
    "## Release evidence blockers\n\n" +
    renderSeedExtractionBlockerBullet(blocker);
  if (findings === null) {
    return `# Bench Findings — ${payload.bench_name} / ${payload.split}\n\n${section}`;
  }
  return `${findings.trimEnd()}\n\n${section}`;
}

function renderSeedExtractionBlockerBullet(
  blocker: SeedExtractionReleaseBlocker
): string {
  return `- **${blocker.id}**: ${blocker.detail}\n`;
}
