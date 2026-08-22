import { describe, expect, it, vi } from "vitest";

const { runRecallEval, resolveSnapshotIdentity, capturedOptions } = vi.hoisted(() => {
  const options: {
    current?: {
      readonly snapshotConsumeAuthority?: string;
      readonly snapshotDbPath?: string;
      readonly embeddingCacheOverlayReceiptPath?: string;
    };
  } = {};
  return {
    capturedOptions: options,
    resolveSnapshotIdentity: vi.fn(async (path: string) => ({
      identity_digest: `identity:${path}`,
      question_ids: ["q-1"]
    })),
    runRecallEval: vi.fn(async (value: { readonly snapshotConsumeAuthority?: string }) => {
      options.current = value;
      return {
        completion: { status: "complete" },
        slug: "diagnostic-recall",
        kpiPath: "/tmp/kpi.json",
        reportPath: "/tmp/report.md",
        payload: {
          recall_eval_attribution: {
            evaluation_slice: {
              offset: 0,
              limit: null,
              evaluated_count: 1,
              question_id_digest:
                "8a3e90ba8a519e1e3e3da22b26bf3d8db2a56b4ae77f42e60b2eda9173930f92"
            }
          }
        }
      };
    })
  };
});

vi.mock("../../../bench/lifecycle/recall-eval/recall-eval-impl.js", () => ({
  runRecallEval
}));
vi.mock("../../../bench/diagnostic-loop/authority/identity.js", () => ({
  resolveSnapshotIdentity
}));
vi.mock("../../../bench/snapshot/integrity.js", () => ({
  sha256File: vi.fn(async (path: string) => `sha256:${path}`)
}));

describe("diagnostic-loop production recall consume authority", () => {
  it("threads diagnostic consume authority into recall-eval", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    await runProductionRecallPhase({
      request: {
        variant: "longmemeval_s",
        snapshotPath: "/tmp/request-snapshot.db",
        historyRoot: "/tmp/history"
      },
      checkpoints: new Map([
        ["extraction", {
          artifact_paths: {},
          content_identity: "cache"
        }],
        ["snapshot", {
          artifact_paths: { snapshot: "/tmp/checkpoint-snapshot.db" },
          content_identity: "identity:/tmp/checkpoint-snapshot.db"
        }]
      ]),
      workRoot: "/tmp/work"
    } as never, "control");

    expect(capturedOptions.current?.snapshotConsumeAuthority).toBe("diagnostic");
    expect(capturedOptions.current?.snapshotDbPath).toBe("/tmp/checkpoint-snapshot.db");
  });

  it("revalidates the checkpoint-bound snapshot before recall", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    runRecallEval.mockClear();

    await expect(runProductionRecallPhase({
      request: {
        variant: "longmemeval_s",
        snapshotPath: "/tmp/request-snapshot.db",
        historyRoot: "/tmp/history"
      },
      checkpoints: new Map([
        ["extraction", { artifact_paths: {}, content_identity: "cache" }],
        ["snapshot", {
          artifact_paths: { snapshot: "/tmp/checkpoint-snapshot.db" },
          content_identity: "tampered-identity"
        }]
      ]),
      workRoot: "/tmp/work"
    } as never, "control")).rejects.toThrow(/checkpoint drifted/u);

    expect(runRecallEval).not.toHaveBeenCalled();
  });

  it("rejects a requested window larger than the checkpoint-bound snapshot", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    runRecallEval.mockClear();

    await expect(runProductionRecallPhase({
      request: {
        variant: "longmemeval_s",
        snapshotPath: "/tmp/request-snapshot.db",
        historyRoot: "/tmp/history",
        limit: 2
      },
      checkpoints: new Map([
        ["extraction", { artifact_paths: {}, content_identity: "cache" }],
        ["snapshot", {
          artifact_paths: { snapshot: "/tmp/checkpoint-snapshot.db" },
          content_identity: "identity:/tmp/checkpoint-snapshot.db"
        }]
      ]),
      workRoot: "/tmp/work"
    } as never, "control")).rejects.toThrow(/not contained in the snapshot/u);

    expect(runRecallEval).not.toHaveBeenCalled();
  });

  it("threads a source-bound embedding overlay into recall-eval", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../bench/diagnostic-loop/production-recall.js"
    );
    runRecallEval.mockClear();

    await runProductionRecallPhase({
      request: {
        variant: "longmemeval_s",
        snapshotPath: "/tmp/request-snapshot.db",
        historyRoot: "/tmp/history",
        embeddingCacheOverlayReceiptPath: "/tmp/overlay-receipt.json"
      },
      checkpoints: new Map([
        ["extraction", { artifact_paths: {}, content_identity: "cache" }],
        ["snapshot", {
          artifact_paths: { snapshot: "/tmp/checkpoint-snapshot.db" },
          content_identity: "identity:/tmp/checkpoint-snapshot.db"
        }]
      ]),
      workRoot: "/tmp/work"
    } as never, "control");

    expect(capturedOptions.current?.embeddingCacheOverlayReceiptPath)
      .toBe("/tmp/overlay-receipt.json");
  });
});
