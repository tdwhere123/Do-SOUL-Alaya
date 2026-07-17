import { diffKpis, type KpiPayload } from "@do-soul/alaya-eval";
import { describe, expect, it } from "vitest";
import { makeShardKpi } from "../../cli/merge/cli-merge-validations-fixture.js";
import { renderRecallEvalReport } from "../../../longmemeval/kpi/recall-eval-report.js";

function diagnosticPayload(): KpiPayload {
  return {
    ...makeShardKpi(),
    evaluated_count: 1,
    answerable_evaluated_count: 1,
    recall_eval_attribution: {
      status: "legacy_unattributed",
      gate_eligible: false,
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      embedding_mode: "disabled",
      embedding_provider_kind: "openai",
      embedding_provider_label: "none",
      onnx_threads: null,
      onnx_model_artifact_sha256: null,
      answer_rerank: { enabled: false },
      hydration_binding: {
        dataset_sha256: "b".repeat(64),
        source: "external_expected_sha256"
      },
      snapshot_binding: {
        commit_sha7: "d7266aa",
        gate_sha256: null,
        worktree_state_sha256: null,
        extraction_cache_manifest_sha256: "a".repeat(64),
        extraction_cache_requested_turns: 1284,
        extraction_cache_cached_turns: 96084,
        extraction_cache_coverage: 1,
        dataset_sha256: null,
        question_id_digest: "c".repeat(64),
        snapshot_manifest_sha256: "d".repeat(64),
        producer_recall_pipeline_version: "fusion-rrf-synthesis-v2",
        consumer_recall_pipeline_version: "fusion-evidence-first-v3",
        producer_schema_migration_version: 103
      }
    }
  };
}

function withRecallIdentity(payload: KpiPayload, schemaVersion: 1 | 2): KpiPayload {
  return {
    ...payload,
    recall_eval_attribution: {
      ...payload.recall_eval_attribution!,
      status: "attributed",
      gate_eligible: true,
      recall_config: {
        schema_version: schemaVersion,
        max_results: 10,
        conflict_awareness: true,
        effective_config_sha256: "e".repeat(64)
      }
    }
  };
}

describe("legacy recall-eval report", () => {
  it("cannot present a measurement-ineligible short diagnostic as OK", () => {
    const payload = diagnosticPayload();
    const report = renderRecallEvalReport(payload, null, diffKpis(payload, null));
    expect(report).toContain("Diagnostic only: measurement-ineligible");
    expect(report).toContain("Materialization producer: fusion-rrf-synthesis-v2");
    expect(report).toContain("Recall consumer: fusion-evidence-first-v3");
    expect(report).toContain("Worst verdict: **INELIGIBLE**");
    expect(report).not.toContain("Worst verdict: **OK**");
  });

  it("keeps a parsed v1 recall identity diagnostic-only", () => {
    const payload = withRecallIdentity(diagnosticPayload(), 1);
    const report = renderRecallEvalReport(payload, null, diffKpis(payload, null));
    expect(report).toContain("Diagnostic only: measurement-ineligible");
    expect(report).toContain("Worst verdict: **INELIGIBLE**");
  });

  it("allows an explicitly eligible v2 recall identity to render normally", () => {
    const payload = withRecallIdentity(diagnosticPayload(), 2);
    const report = renderRecallEvalReport(payload, null, diffKpis(payload, null));
    expect(report).not.toContain("Diagnostic only: measurement-ineligible");
    expect(report).not.toContain("Worst verdict: **INELIGIBLE**");
  });
});
