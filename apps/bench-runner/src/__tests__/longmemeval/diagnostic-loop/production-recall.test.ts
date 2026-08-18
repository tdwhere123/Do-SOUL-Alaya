import { describe, expect, it, vi } from "vitest";

const { runRecallEval, capturedOptions } = vi.hoisted(() => {
  const options: { current?: { readonly snapshotConsumeAuthority?: string } } = {};
  return {
    capturedOptions: options,
    runRecallEval: vi.fn(async (value: { readonly snapshotConsumeAuthority?: string }) => {
      options.current = value;
      return {
        completion: { status: "complete" },
        slug: "diagnostic-recall",
        kpiPath: "/tmp/kpi.json",
        reportPath: "/tmp/report.md"
      };
    })
  };
});

vi.mock("../../../bench/lifecycle/recall-eval/recall-eval-impl.js", () => ({
  runRecallEval
}));

describe("diagnostic-loop production recall consume authority", () => {
  it("threads diagnostic consume authority into recall-eval", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    await runProductionRecallPhase({
      request: {
        variant: "longmemeval_s",
        snapshotPath: "/tmp/snapshot.db",
        historyRoot: "/tmp/history"
      },
      checkpoints: new Map([
        ["extraction", {
          artifact_paths: {},
          content_identity: "cache"
        }],
        ["snapshot", {
          artifact_paths: { snapshot: "/tmp/snapshot.db" },
          content_identity: "snapshot"
        }]
      ]),
      workRoot: "/tmp/work"
    } as never, "control");

    expect(capturedOptions.current?.snapshotConsumeAuthority).toBe("diagnostic");
  });
});
