import {
  releaseMetricGateVerdict,
  type KpiPayload
} from "@do-soul/alaya-eval";
import {
  seedExtractionReleaseBlockerExitCode
} from "../longmemeval/seed-extraction-release-blocker.js";
import { exitCodeForVerdicts } from "./result-format.js";

export function exitCodeForReleaseHardGates(payload: KpiPayload): number {
  const seedExtractionExitCode = seedExtractionReleaseBlockerExitCode(payload);
  if (seedExtractionExitCode !== 0) return seedExtractionExitCode;
  if (releaseMetricGateVerdict(payload) === "fail") return 1;
  return exitCodeForVerdicts(payload.diff_vs_previous?.verdict_per_kpi);
}
