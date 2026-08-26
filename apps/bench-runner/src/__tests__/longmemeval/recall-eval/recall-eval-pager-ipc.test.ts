import { accessSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { selectFineAssessmentCandidates } from
  "../../../../../../packages/core/src/recall/delivery/fine-assessment-selection.js";
import { materializeFineAssessmentSelectionBoundary } from
  "../../../../../../packages/core/src/recall/delivery/selection-boundary/selection-boundary-capture.js";
import {
  FIELD_PINS,
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from "../../../../../../packages/core/src/__tests__/recall/fine-assessment-selection-fixtures.js";
import type { FineAssessmentSelectionBoundaryCase } from "@do-soul/alaya-core";
import { computeLongMemEvalQuestionIdDigest } from "@do-soul/alaya-eval";
import {
  disposeRecallEvalSelectionBoundaryArtifact,
  type RecallEvalSelectionBoundaryArtifact
} from "../../../bench/lifecycle/recall-eval/recall-eval-selection-replay.js";
import { verifyLongMemEvalSelectionBoundaryArtifact } from
  "../../../bench/selection-replay/selection-boundary-spool.js";
import {
  RecallEvalPagerChildExitedError,
  createForkRecallEvalPagerHost,
  createRecallEvalPagerSession,
  type RecallEvalPagerIpcHost
} from "../../../bench/lifecycle/recall-eval/recall-eval-process/ipc-client.js";

const stubChildPath = fileURLToPath(
  new URL("./recall-eval-pager-ipc-stub-child.mjs", import.meta.url)
);

describe("recall-eval pager IPC isolation", () => {
  const sessions: ReturnType<typeof createRecallEvalPagerSession>[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    const pending = sessions.splice(0);
    await Promise.all(pending.map((session) => session.close().catch(() => undefined)));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("returns a pack from the child without mapping sqlite in the parent", async () => {
    const session = openSession();
    await session.open({});
    const pack = await session.recall({ questionId: "ok" }) as { readonly questionId: string };
    expect(pack.questionId).toBe("ok");
    expect(parentMapsAlayaDb()).toBe(false);
  });

  it("reuses the same child pid across questions", async () => {
    const counted = countingHost();
    const session = openSession(undefined, counted.host);
    await session.open({});
    expect(counted.pids).toHaveLength(1);
    await session.recall({ questionId: "q1" });
    await session.recall({ questionId: "q2" });
    expect(counted.pids).toHaveLength(1);
    expect(counted.pids[0]).toBe(session.pid);
  });

  it("fail-closes when the child exits mid-request", async () => {
    const counted = countingHost();
    const session = openSession(undefined, counted.host);
    await session.open({});
    await expect(session.recall({ questionId: "__crash__" })).rejects.toMatchObject({
      name: "RecallEvalPagerChildExitedError",
      code: 7
    });
    const spawnsAfterCrash = counted.pids.length;
    await expect(session.recall({ questionId: "ok" })).rejects.toBeInstanceOf(
      RecallEvalPagerChildExitedError
    );
    expect(counted.pids).toHaveLength(spawnsAfterCrash);
  });

  it("fail-closes when spawn throws and does not retry", async () => {
    let spawns = 0;
    const session = openSession(undefined, {
      spawn() {
        spawns += 1;
        throw new Error("synthetic spawn failure");
      }
    });
    await expect(session.open({})).rejects.toBeInstanceOf(RecallEvalPagerChildExitedError);
    await expect(session.recall({ questionId: "ok" })).rejects.toBeInstanceOf(
      RecallEvalPagerChildExitedError
    );
    expect(spawns).toBe(1);
  });

  it("fail-closes when the child never replies", async () => {
    const session = openSession(40);
    await session.open({}, 5_000);
    await expect(session.recall({ questionId: "__hang__" }, 40)).rejects.toThrow(/timed out/u);
  });

  it("fail-closes when the child returns an empty pack", async () => {
    const session = openSession();
    await session.open({});
    await expect(session.recall({ questionId: "__empty__" })).rejects.toThrow(/empty pack/u);
  });

  it("delivers a backpressured recall payload instead of treating a full IPC queue as death", async () => {
    const session = openSession();
    await session.open({});
    const pack = await session.recall({
      questionId: "ok",
      bulk: "x".repeat(4 * 1024 * 1024)
    }) as { readonly questionId: string };
    expect(pack.questionId).toBe("ok");
  });

  it("assembles every recalled question selection record in evaluated order", async () => {
    const root = mkdtempSync(join(tmpdir(), "pager-selection-test-"));
    roots.push(root);
    const selectionRootLogPath = join(root, "roots.log");
    const session = openSession();
    await session.open({
      selectionBoundaryFixture: capturedBoundary(),
      selectionRootLogPath
    });
    await session.recall({ questionId: "question-2" });
    await session.recall({ questionId: "question-1" });
    const artifact = await session.close() as RecallEvalSelectionBoundaryArtifact;
    const verified = await verifyLongMemEvalSelectionBoundaryArtifact(
      artifact.sourcePath
    );
    expect(verified).toEqual({
      recordCount: 2,
      questionCount: 2,
      questionIdDigest: computeLongMemEvalQuestionIdDigest([
        "question-2", "question-1"
      ])
    });
    const records = gunzipSync(readFileSync(artifact.sourcePath))
      .toString("utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { question_id: string });
    expect(records.map((record) => record.question_id)).toEqual([
      "question-2", "question-1"
    ]);
    expect(artifact.binding.record_count).toBe(2);
    const childRoots = readFileSync(selectionRootLogPath, "utf8").trim().split("\n");
    expect(childRoots).toHaveLength(1);
    for (const childRoot of childRoots) {
      expect(() => accessSync(childRoot)).toThrow();
    }
    await disposeRecallEvalSelectionBoundaryArtifact(artifact);
    expect(() => accessSync(artifact.rootPath)).toThrow();
  });

  it("rejects a child artifact outside the evaluated window and disposes every root", async () => {
    const root = mkdtempSync(join(tmpdir(), "pager-selection-failure-test-"));
    roots.push(root);
    const selectionRootLogPath = join(root, "roots.log");
    const session = openSession();
    await session.open({
      selectionBoundaryFixture: capturedBoundary(),
      selectionRootLogPath,
      selectionQuestionIdOverride: "wrong-question"
    });
    await session.recall({ questionId: "expected-question" });
    await expect(session.close()).rejects.toThrow(/expected question_id/u);

    const childRoots = readFileSync(selectionRootLogPath, "utf8").trim().split("\n");
    expect(childRoots).toHaveLength(1);
    for (const childRoot of childRoots) {
      expect(() => accessSync(childRoot)).toThrow();
    }
  });

  it("disposes the open selection spool when a child crashes before close", async () => {
    const root = mkdtempSync(join(tmpdir(), "pager-selection-crash-test-"));
    roots.push(root);
    const selectionRootLogPath = join(root, "roots.log");
    const session = openSession();
    await session.open({
      selectionBoundaryFixture: capturedBoundary(),
      selectionRootLogPath
    });
    await expect(session.recall({ questionId: "__crash__" })).rejects.toBeInstanceOf(
      RecallEvalPagerChildExitedError
    );
    await expect(session.close()).resolves.toBeNull();

    const [childRoot] = readFileSync(selectionRootLogPath, "utf8").trim().split("\n");
    expect(childRoot).toBeDefined();
    expect(() => accessSync(childRoot ?? "")).toThrow();
  });

  function openSession(timeoutMs?: number, host?: RecallEvalPagerIpcHost) {
    const session = createRecallEvalPagerSession({
      host: host ?? createForkRecallEvalPagerHost(stubChildPath),
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
    sessions.push(session);
    return session;
  }

  function countingHost(): {
    readonly pids: number[];
    readonly host: RecallEvalPagerIpcHost;
  } {
    const inner = createForkRecallEvalPagerHost(stubChildPath);
    const pids: number[] = [];
    return {
      pids,
      host: {
        spawn() {
          const child = inner.spawn();
          pids.push(child.pid ?? -1);
          return child;
        }
      }
    };
  }
});

function capturedBoundary(): FineAssessmentSelectionBoundaryCase {
  const candidates = [
    createRankedCandidate("candidate-1", 1, 0.9),
    createRankedCandidate("candidate-2", 2, 0.8)
  ];
  let captured: FineAssessmentSelectionBoundaryCase | undefined;
  selectFineAssessmentCandidates({
    ...FIELD_PINS,
    orderedCandidates: candidates,
    config: createConfig(),
    supplementaryData: createSupplementaryData(),
    tokenEstimator: { estimate: () => 5 },
    rankByCandidateKey: rankMap(candidates),
    finalRelevanceByCandidateKey: new Map(candidates.map((candidate) => [
      candidate.fusion.candidate_key,
      candidate.fusion.fused_score
    ])),
    captureAnswerFeatures: true,
    capturePacketPlanTrace: true,
    selectionBoundaryObserver: (pending) => {
      captured = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }
  });
  if (captured === undefined) throw new Error("selection boundary was not observed");
  return captured;
}

function parentMapsAlayaDb(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return /alaya\.db(?:-wal|-shm)?(?:\s|$)/u.test(readFileSync("/proc/self/maps", "utf8"));
  } catch {
    return false;
  }
}
