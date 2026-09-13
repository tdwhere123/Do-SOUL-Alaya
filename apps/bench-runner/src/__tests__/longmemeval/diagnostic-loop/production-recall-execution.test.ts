import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConditionalFieldRecallWithReceipt } from "@do-soul/alaya-core";
import { computeLongMemEvalQuestionIdDigest } from "@do-soul/alaya-eval";

const LIVE_QUESTION_IDS = ["live-window-alpha", "live-window-beta"] as const;

const { runRecallEval, resolveSnapshotIdentity } = vi.hoisted(() => {
  const budget = {
    schema_version: 1 as const,
    work_units: 10_000,
    memory_bytes: 1_000_000,
    page_budget: 2,
    finalization_reserve: 100,
    min_envelope: 10
  };
  return {
    resolveSnapshotIdentity: vi.fn(async (path: string) => ({
      identity_digest: `identity:${path}`,
      question_ids: [...LIVE_QUESTION_IDS]
    })),
    runRecallEval: vi.fn(async () => {
      const executed = runConditionalFieldRecallWithReceipt({
        workspace_id: "workspace",
        query_text: "needle",
        budget,
        snapshot_id: `sha256:${"a".repeat(64)}`,
        interpretation_clock: "2026-09-06T00:00:00.000Z",
        as_of: "2026-09-06T00:00:00.000Z",
        expires_at: "2099-01-01T00:00:00.000Z",
        readers: {}
      });
      return {
        completion: { status: "complete" as const },
        slug: "diagnostic-recall",
        kpiPath: "/tmp/production-recall-execution-kpi.json",
        reportPath: "/tmp/production-recall-execution-report.md",
        payload: {
          recall_eval_attribution: {
            evaluation_slice: {
              offset: 0,
              limit: null,
              evaluated_count: LIVE_QUESTION_IDS.length,
              question_id_digest: computeLongMemEvalQuestionIdDigest([...LIVE_QUESTION_IDS])
            }
          }
        },
        executedQueryId: executed.execution_receipt.query_id
      };
    })
  };
});

vi.mock("../../../runs/lifecycle/recall-eval/recall-eval-impl.js", () => ({
  runRecallEval
}));
vi.mock("../../../runs/diagnostic-loop/authority/identity.js", () => ({
  resolveSnapshotIdentity
}));
vi.mock("../../../runs/snapshot/integrity.js", () => ({
  sha256File: vi.fn(async (path: string) => `sha256:${path}`)
}));

const overlayRoots: string[] = [];

afterEach(async () => {
  await Promise.all(overlayRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("diagnostic-loop production recall execution", () => {
  it("executes recall against a live question-window identity", async () => {
    const { runProductionRecallPhase } = await import(
      "../../../runs/diagnostic-loop/production-recall.js"
    );
    const root = await mkdtemp(join(tmpdir(), "production-recall-exec-"));
    overlayRoots.push(root);
    const snapshotPath = join(root, "checkpoint-snapshot.db");
    await writeFile(snapshotPath, "snapshot\n", "utf8");
    runRecallEval.mockClear();

    const result = await runProductionRecallPhase({
      request: {
        variant: "longmemeval_s",
        snapshotPath,
        historyRoot: join(root, "history")
      },
      checkpoints: new Map([
        ["extraction", { artifact_paths: {}, content_identity: "cache" }],
        ["snapshot", {
          artifact_paths: { snapshot: snapshotPath },
          content_identity: `identity:${snapshotPath}`
        }]
      ]),
      workRoot: join(root, "work")
    } as never, "control");

    expect(runRecallEval).toHaveBeenCalledOnce();
    const evalResult = await runRecallEval.mock.results[0]?.value;
    expect(evalResult?.executedQueryId).toEqual(expect.any(String));
    expect(result.details?.evaluation_slice).toEqual({
      offset: 0,
      limit: null,
      evaluated_count: 2,
      question_id_digest: computeLongMemEvalQuestionIdDigest([...LIVE_QUESTION_IDS])
    });
    expect(result.details?.evaluation_slice).not.toEqual(expect.objectContaining({
      question_id_digest: "8a3e90ba8a519e1e3e3da22b26bf3d8db2a56b4ae77f42e60b2eda9173930f92"
    }));
  });
});
