import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupPostTurnExtractHarnesses,
  createPostTurnPayload,
  createRoutingHarness
} from "../mcp-memory/post-turn-extract-task-fixture.js";

afterEach(() => {
  cleanupPostTurnExtractHarnesses();
});

describe("post-turn Garden source observation", () => {
  it("passes the task source time to the compile context", async () => {
    const compile = vi.fn(async () => []);
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: compile
    });
    harness.enqueuePostTurnTask({
      created_at: "2026-08-01T12:00:01.000Z",
      payload: createPostTurnPayload({
        created_at: "2026-08-01T12:00:00.000Z"
      })
    });

    await harness.runScheduler();

    expect(compile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        source_observed_at: "2026-08-01T12:00:00.000Z"
      })
    );
  });

  it("falls back to the task row time when payload time is absent", async () => {
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
});
