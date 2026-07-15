import { afterEach, describe, expect, it, vi } from "vitest";
import type { GardenComputeProvider } from "@do-soul/alaya-soul";
import {
  cleanupPostTurnExtractHarnesses,
  createPostTurnPayload,
  createRoutingHarness
} from "../mcp-memory/post-turn-extract-task-fixture.js";

afterEach(() => {
  cleanupPostTurnExtractHarnesses();
});

describe("post-turn Garden source observation", () => {
  it("lets a host-supplied source_observed_at win over the enqueue clock", async () => {
    const compile = vi.fn(async () => []);
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: compile
    });
    harness.enqueuePostTurnTask({
      created_at: "2026-08-01T12:00:01.000Z",
      payload: createPostTurnPayload({
        created_at: "2026-08-01T12:00:01.000Z",
        source_observed_at: "2026-08-01T11:59:00.000Z"
      })
    });

    await harness.runScheduler();

    expect(compile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        source_observed_at: "2026-08-01T11:59:00.000Z"
      })
    );
  });

  it("falls back to the enqueue clock when source_observed_at is absent", async () => {
    const compile = vi.fn(async () => []);
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: compile
    });
    harness.enqueuePostTurnTask({
      created_at: "2026-08-01T12:00:01.000Z",
      payload: createPostTurnPayload({ created_at: undefined })
    });

    await harness.runScheduler();

    expect(compile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        source_observed_at: "2026-08-01T12:00:01.000Z"
      })
    );
  });

  it("does not shift source_observed_at to worker process time after delay", async () => {
    const compile = vi.fn<GardenComputeProvider["compile"]>(async () => []);
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: compile
    });
    const enqueuedAt = "2026-07-13T10:00:00.000Z";
    harness.enqueuePostTurnTask({
      created_at: enqueuedAt,
      payload: createPostTurnPayload({ created_at: enqueuedAt })
    });

    const processStartedAt = new Date().toISOString();
    await harness.runScheduler();

    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        source_observed_at: enqueuedAt
      })
    );
    const observedAt = (compile.mock.calls[0]?.[1] as { source_observed_at: string }).source_observed_at;
    expect(observedAt).toBe(enqueuedAt);
    expect(observedAt).not.toBe(processStartedAt);
    expect(Date.parse(observedAt)).toBeLessThan(Date.parse(processStartedAt));
  });
});
