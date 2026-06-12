import type { KpiPayload } from "@do-soul/alaya-eval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../cli.js";
import { runLocomo } from "../../locomo/runner.js";

vi.mock("../../locomo/runner.js", () => ({
  runLocomo: vi.fn()
}));

const runLocomoMock = vi.mocked(runLocomo);

function buildLocomoPayload(): KpiPayload {
  return {
    bench_name: "public-locomo",
    split: "locomo10",
    run_at: "2026-05-19T10:00:00.000Z",
    alaya_commit: "abc1234",
    alaya_version: "0.3.9",
    embedding_provider: "none",
    chat_provider: "none",
    policy_shape: "chat",
    simulate_report: "none",
    dataset: {
      name: "locomo10",
      size: 1982,
      source: "fixture"
    },
    sample_size: 1982,
    evaluated_count: 1982,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0.2,
      r_at_5: 0.54,
      r_at_10: 0.45,
      latency_ms_p50: 90,
      latency_ms_p95: 180,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0,
      tier_distribution: { hot: 1982, warm: 0, cold: 0 },
      degradation_reasons: {
        none: 1982,
        warm_cascade_engaged: 0,
        cold_cascade_engaged: 0,
        recall_explainability_partial: 0
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      per_scenario: []
    },
    diff_vs_previous: null
  };
}

describe("LoCoMo CLI hard gates", () => {
  let originalStdoutWrite: typeof process.stdout.write;
  let stdoutBuf: string;

  beforeEach(() => {
    stdoutBuf = "";
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutBuf += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    runLocomoMock.mockReset();
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
  });

  it("exits non-zero when a full LoCoMo run misses the release hard gate", async () => {
    runLocomoMock.mockResolvedValue({
      slug: "2026-05-19T100000Z-abc1234",
      kpiPath: "/tmp/locomo/kpi.json",
      reportPath: "/tmp/locomo/report.md",
      findingsPath: "/tmp/locomo/findings.md",
      diagnosticsPath: "/tmp/locomo/locomo-diagnostics.json",
      payload: buildLocomoPayload()
    });

    const exitCode = await runCli(["locomo", "--history-root", "/tmp/locomo"]);

    expect(exitCode).toBe(1);
    expect(stdoutBuf).toContain("R@5=54.0%");
    expect(runLocomoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "locomo10",
        historyRoot: "/tmp/locomo"
      })
    );
  });
});
