import { describe, expect, it, vi } from "vitest";
import {
  EmbeddingReadinessTracker,
  runEmbeddingReadinessPass,
  runEmbeddingReadinessPassWithResult
} from "../longmemeval/embedding-readiness.js";
import { warmLocomoConversationEmbeddings } from "../locomo/runner.js";

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

describe("runEmbeddingReadinessPassWithResult", () => {
  it("carries the pass value when the pass resolves", async () => {
    const warn = vi.fn();
    const result = await runEmbeddingReadinessPassWithResult({
      runPass: async () => ({ ready_count: 7 }),
      workspaceId: "ws-1",
      questionId: "conv-1:seed-warmup",
      warn
    });
    expect(result.outcome).toBe("ready");
    expect(result.value).toEqual({ ready_count: 7 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades value to null on a benign skip (quiet)", async () => {
    const warn = vi.fn();
    const result = await runEmbeddingReadinessPassWithResult<{ ready_count: number }>({
      runPass: async () => {
        throw new Error("embedding_backfill_skipped:provider_unavailable");
      },
      workspaceId: "ws-1",
      questionId: "conv-1:seed-warmup",
      warn
    });
    expect(result.outcome).toBe("benign_skip");
    expect(result.value).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades value to null on a genuine failure and warns visibly", async () => {
    const warn = vi.fn();
    const result = await runEmbeddingReadinessPassWithResult<{ ready_count: number }>({
      runPass: async () => {
        throw new Error("embedding_failed:provider:memory-x:Embedding request transport failed");
      },
      workspaceId: "locomo-conv-42",
      questionId: "conv-42:seed-warmup",
      warn
    });
    expect(result.outcome).toBe("failed");
    expect(result.value).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("workspace=locomo-conv-42");
  });

  // invariant: the LoCoMo conversation loop shape. A throwing per-conversation
  // embedding warmup must NOT abort the loop; every conversation must be visited
  // and the run-level tracker must count the degraded passes. Reverting Fix B
  // (awaiting workspace.warmEmbeddingCache directly) lets the first throw escape
  // the loop -> visited.length < conversations.length -> this fails.
  // see also: apps/bench-runner/src/locomo/runner.ts runOneConversation
  it("keeps the LoCoMo conversation loop running despite a throwing warmup and integrity-tracks it", async () => {
    const tracker = new EmbeddingReadinessTracker(vi.fn());
    const conversations = ["conv-26", "conv-30", "conv-41", "conv-42"];
    const visited: string[] = [];
    for (const conversationId of conversations) {
      // conv-42 models the sustained provider failure that exhausts retries.
      const pass = await runEmbeddingReadinessPassWithResult<{ ready_count: number }>({
        runPass: async () => {
          if (conversationId === "conv-42") {
            throw new Error(
              "embedding_failed:provider:memory-x:Embedding request transport failed for host yunwu.ai."
            );
          }
          return { ready_count: 3 };
        },
        workspaceId: `locomo-${conversationId}`,
        questionId: `${conversationId}:seed-warmup`,
        warn: vi.fn()
      });
      tracker.record(pass);
      // Reaching here for conv-42 proves the throw did not abort the loop.
      visited.push(conversationId);
    }
    expect(visited).toEqual(conversations);
    expect(tracker.failedCount).toBe(1);
    expect(tracker.unresolvedCount).toBe(1);
  });
});

describe("warmLocomoConversationEmbeddings (runner wiring seam)", () => {
  // invariant: this drives the REAL runner seam runOneConversation calls, not a
  // hand-rolled replica. A fake workspace whose warm methods throw must NOT
  // abort the caller and the run-level tracker must count the degradation.
  // Reverting the seam to a bare `await workspace.warm...(...)` lets the throw
  // escape -> this test rejects -> red. (Confirmed locally by that mutation.)
  // see also: apps/bench-runner/src/locomo/runner.ts warmLocomoConversationEmbeddings
  it("degrades + continues when warmEmbeddingCache throws a genuine failure", async () => {
    const tracker = new EmbeddingReadinessTracker(vi.fn());
    const warmEmbeddingCache = vi.fn(async () => {
      throw new Error(
        "embedding_failed:provider:memory-x:Embedding request transport failed for host yunwu.ai."
      );
    });
    const warmQueryEmbeddingCache = vi.fn(async () => {
      throw new Error(
        "embedding_failed:provider:query-x:Embedding request transport failed for host yunwu.ai."
      );
    });

    const result = await warmLocomoConversationEmbeddings({
      workspace: { warmEmbeddingCache, warmQueryEmbeddingCache },
      embeddingReadiness: tracker,
      embeddingMode: "env",
      workspaceId: "locomo-conv-42",
      conversationId: "conv-42",
      seedMemoryIds: ["mem-a", "mem-b"],
      queryTexts: ["who is bob?"]
    });

    // (a) the seam resolved (did NOT throw) and (b) the caller can keep going.
    expect(result.embeddingWarmup).toBeNull();
    expect(result.queryEmbeddingWarmup).toBeNull();
    // Both passes ran (the throw was tolerated, not short-circuited).
    expect(warmEmbeddingCache).toHaveBeenCalledTimes(1);
    expect(warmQueryEmbeddingCache).toHaveBeenCalledTimes(1);
    // (c) the run-level tracker recorded both degradations as genuine failures.
    expect(tracker.failedCount).toBe(2);
    expect(tracker.unresolvedCount).toBe(2);
  });

  it("tolerates a benign skip from warmEmbeddingCache quietly while continuing", async () => {
    const tracker = new EmbeddingReadinessTracker(vi.fn());
    const warmEmbeddingCache = vi.fn(async () => {
      throw new Error("embedding_backfill_skipped:no_hot_memories");
    });
    const warmQueryEmbeddingCache = vi.fn(async () => ({
      status: "ready" as const,
      requested_count: 1,
      ready_count: 1,
      cache_hit_count: 0,
      provider_requested_count: 1
    }));

    const result = await warmLocomoConversationEmbeddings({
      workspace: {
        warmEmbeddingCache,
        warmQueryEmbeddingCache: warmQueryEmbeddingCache as never
      },
      embeddingReadiness: tracker,
      embeddingMode: "env",
      workspaceId: "locomo-conv-26",
      conversationId: "conv-26",
      seedMemoryIds: ["mem-a"],
      queryTexts: ["where did alice travel?"]
    });

    expect(result.embeddingWarmup).toBeNull();
    expect(result.queryEmbeddingWarmup).not.toBeNull();
    expect(tracker.failedCount).toBe(0);
    expect(tracker.benignSkipCount).toBe(1);
    expect(tracker.unresolvedCount).toBe(1);
  });

  it("runs no warmup passes and records nothing when embeddingMode is not env", async () => {
    const tracker = new EmbeddingReadinessTracker(vi.fn());
    const warmEmbeddingCache = vi.fn();
    const warmQueryEmbeddingCache = vi.fn();

    const result = await warmLocomoConversationEmbeddings({
      workspace: {
        warmEmbeddingCache: warmEmbeddingCache as never,
        warmQueryEmbeddingCache: warmQueryEmbeddingCache as never
      },
      embeddingReadiness: tracker,
      embeddingMode: "disabled",
      workspaceId: "locomo-conv-1",
      conversationId: "conv-1",
      seedMemoryIds: ["mem-a"],
      queryTexts: ["q"]
    });

    expect(result.embeddingWarmup).toBeNull();
    expect(result.queryEmbeddingWarmup).toBeNull();
    expect(warmEmbeddingCache).not.toHaveBeenCalled();
    expect(warmQueryEmbeddingCache).not.toHaveBeenCalled();
    expect(tracker.unresolvedCount).toBe(0);
  });
});
