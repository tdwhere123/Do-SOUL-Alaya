import { describe, expect, it } from "vitest";
import { buildFullLongMemEvalPayload } from
  "../../../../../packages/eval/src/__tests__/history/history-fixture.js";
import { exitCodeForReleaseHardGates } from
  "../../cli/release-hard-gate-exit.js";

describe("exitCodeForReleaseHardGates", () => {
  it("includes the persisted baseline-diff verdict", () => {
    const payload = buildFullLongMemEvalPayload("public", "abc1234", 0.95);
    payload.diff_vs_previous = {
      previous_run: "previous-run",
      r_at_5_delta_pp: -5,
      verdict_per_kpi: { r_at_5: "fail" }
    };

    expect(exitCodeForReleaseHardGates(payload)).toBe(1);
  });

  it("passes when seed, metric, and baseline-diff gates are clean", () => {
    const payload = buildFullLongMemEvalPayload("public", "abc1234", 0.95);
    payload.diff_vs_previous = {
      previous_run: "previous-run",
      r_at_5_delta_pp: 0,
      verdict_per_kpi: { r_at_5: "ok" }
    };

    expect(exitCodeForReleaseHardGates(payload)).toBe(0);
  });
});
