import type { KpiPayload } from "@do-soul/alaya-eval";

type SeedExtractionPathKpi = NonNullable<
  KpiPayload["kpi"]["seed_extraction_path"]
>;

interface SeedExtractionReleaseBlocker {
  readonly id: string;
  readonly detail: string;
}

export function seedExtractionReleaseBlockerExitCode(
  payload: KpiPayload
): number {
  return getSeedExtractionReleaseBlocker(payload) === null ? 0 : 1;
}

export function hasSeedExtractionReleaseBlocker(payload: KpiPayload): boolean {
  return getSeedExtractionReleaseBlocker(payload) !== null;
}

export function appendSeedExtractionReleaseBlockerToReport(
  report: string,
  payload: KpiPayload
): string {
  const blocker = getSeedExtractionReleaseBlocker(payload);
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
  const blocker = getSeedExtractionReleaseBlocker(payload);
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

function getSeedExtractionReleaseBlocker(
  payload: KpiPayload
): SeedExtractionReleaseBlocker | null {
  if (!isLongMemEvalBenchName(payload.bench_name)) {
    return null;
  }
  const path = payload.kpi.seed_extraction_path;
  if (path === undefined) {
    return null;
  }
  if (path.path === "no_credentials_fallback") {
    return {
      id: "seed_extraction_path no_credentials_fallback",
      detail:
        "LongMemEval evidence used degraded no-credential full-turn seeding " +
        `(${formatSeedExtractionCounters(path)}), so this archive is blocked ` +
        "even if numeric KPI gates pass."
    };
  }
  if (path.offline_fallbacks > 0) {
    return {
      id: "seed_extraction_path offline_fallbacks",
      detail:
        "LongMemEval official seed extraction fell back to offline extraction " +
        `(${formatSeedExtractionCounters(path)}), so this archive is blocked ` +
        "until official extraction is fully provider-backed."
    };
  }
  return null;
}

function isLongMemEvalBenchName(benchName: KpiPayload["bench_name"]): boolean {
  return (
    benchName === "public" ||
    benchName === "public-multiturn" ||
    benchName === "public-crossquestion"
  );
}

function renderSeedExtractionBlockerBullet(
  blocker: SeedExtractionReleaseBlocker
): string {
  return `- **${blocker.id}**: ${blocker.detail}\n`;
}

function formatSeedExtractionCounters(path: SeedExtractionPathKpi): string {
  return (
    `path=${path.path} cache_hits=${path.cache_hits} ` +
    `llm_calls=${path.llm_calls} offline_fallbacks=${path.offline_fallbacks} ` +
    `live_failures=${path.live_extraction_failures} ` +
    `cached_failures=${path.cached_extraction_failures} ` +
    `facts=${path.facts_produced} signals_dropped=${path.signals_dropped}`
  );
}
