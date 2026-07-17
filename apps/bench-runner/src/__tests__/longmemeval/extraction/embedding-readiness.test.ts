import { describe, expect, it, vi } from "vitest";
import {
  EmbeddingReadinessTracker,
  runEmbeddingReadinessPass
} from "../../../longmemeval/provenance/embedding/embedding-readiness.js";

describe("runEmbeddingReadinessPass", () => {
  it("returns ready and warns nothing when the pass resolves", async () => {
    const warn = vi.fn();
    const result = await runEmbeddingReadinessPass({
      runPass: async () => undefined,
      workspaceId: "ws-1",
      questionId: "q-1",
      warn
    });
    expect(result).toEqual({ outcome: "ready", reason: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    "embedding_backfill_skipped:provider_unavailable",
    "embedding_backfill_skipped:no_hot_memories"
  ])("tolerates the benign skip %s quietly (does not rethrow)", async (reason) => {
    const warn = vi.fn();
    // Must resolve, not throw — a throwing helper would abort the question loop.
    const result = await runEmbeddingReadinessPass({
      runPass: async () => {
        throw new Error(reason);
      },
      workspaceId: "ws-1",
      questionId: "q-1",
      warn
    });
    expect(result).toEqual({ outcome: "benign_skip", reason });
    expect(warn).not.toHaveBeenCalled();
  });

  it("tolerates a genuine failure but emits a VISIBLE warning naming question + workspace", async () => {
    const warn = vi.fn();
    const result = await runEmbeddingReadinessPass({
      runPass: async () => {
        throw new Error("embedding_failed:provider:memory-x:provider rejected");
      },
      workspaceId: "ws-degraded",
      questionId: "q-degraded",
      warn
    });
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("embedding_failed:provider");
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain("WARNING");
    expect(message).toContain("question=q-degraded");
    expect(message).toContain("workspace=ws-degraded");
    expect(message).toContain("embedding_failed:provider");
  });

  it("treats a non-skip, non-failed-prefix error as a genuine failure (visible)", async () => {
    const warn = vi.fn();
    const result = await runEmbeddingReadinessPass({
      runPass: async () => {
        throw new Error("unexpected daemon crash");
      },
      workspaceId: "ws-1",
      questionId: "q-1",
      warn
    });
    expect(result.outcome).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // invariant: "throw in -> loop continues" at the call-site shape. A question
  // loop driven through the helper with an always-rejecting pass must still
  // visit every question; a non-tolerant helper would let the first rejection
  // escape and abort the loop (completed < total), failing this assertion.
  it("keeps a question loop running to completion despite every pass throwing", async () => {
    const tracker = new EmbeddingReadinessTracker(vi.fn());
    const questions = ["q-1", "q-2", "q-3", "q-4"];
    const completed: string[] = [];
    for (const questionId of questions) {
      tracker.record(
        await runEmbeddingReadinessPass({
          runPass: async () => {
            throw new Error("embedding_backfill_skipped:no_hot_memories");
          },
          workspaceId: "ws-shared",
          questionId,
          warn: vi.fn()
        })
      );
      // Reaching here per question proves the throw did not abort the loop.
      completed.push(questionId);
    }
    expect(completed).toEqual(questions);
    expect(tracker.unresolvedCount).toBe(questions.length);
  });
});

describe("EmbeddingReadinessTracker.finalize", () => {
  it("stays silent when every pass was ready", () => {
    const warn = vi.fn();
    const tracker = new EmbeddingReadinessTracker(warn);
    tracker.record({ outcome: "ready", reason: null });
    tracker.record({ outcome: "ready", reason: null });
    tracker.finalize();
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits a prominent INTEGRITY WARNING when any pass was unresolved", () => {
    const warn = vi.fn();
    const tracker = new EmbeddingReadinessTracker(warn);
    tracker.record({ outcome: "ready", reason: null });
    tracker.record({
      outcome: "benign_skip",
      reason: "embedding_backfill_skipped:provider_unavailable"
    });
    tracker.record({
      outcome: "failed",
      reason: "embedding_failed:provider:memory-x:boom"
    });
    expect(tracker.unresolvedCount).toBe(2);
    expect(tracker.failedCount).toBe(1);
    expect(tracker.benignSkipCount).toBe(1);

    tracker.finalize();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain("INTEGRITY WARNING");
    expect(message).toContain("2/3");
    expect(message).toContain("1 genuine failure");
    expect(message).toContain("1 benign/transient skip");
  });
});
