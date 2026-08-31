import {
  renderReport,
  type KpiDiffResult,
  type KpiPayload
} from "@do-soul/alaya-eval";

export function renderRecallEvalReport(
  current: KpiPayload,
  previous: KpiPayload | null,
  diff: KpiDiffResult
): string {
  const report = renderReport(current, previous, diff);
  const attribution = current.recall_eval_attribution;
  if (attribution === undefined ||
      (attribution.gate_eligible && attribution.recall_config?.schema_version === 2)) {
    return report;
  }
  const binding = attribution.snapshot_binding;
  const banner = [
    "> [!WARNING]",
    "> Diagnostic only: measurement-ineligible and not release evidence.",
    `> Materialization producer: ${binding.producer_recall_pipeline_version ?? "unbound"}.`,
    `> Recall consumer: ${binding.consumer_recall_pipeline_version ?? current.recall_pipeline_version ?? "unbound"}.`,
    ""
  ].join("\n");
  return banner + report.replace(
    /Worst verdict: \*\*[A-Z]+\*\*[^\n]*/u,
    "Worst verdict: **INELIGIBLE** (diagnostic only; not a release verdict)"
  );
}
