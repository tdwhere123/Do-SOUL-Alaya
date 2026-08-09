import { afterEach, describe, expect, it, vi } from "vitest";
import type { GardenComputeProvider } from "@do-soul/alaya-soul";
import {
  cleanupPostTurnExtractHarnesses,
  createPostTurnPayload,
  createRoutingHarness
} from "../mcp-memory/garden/post-turn-extract-task-fixture.js";

afterEach(() => {
  cleanupPostTurnExtractHarnesses();
});

describe("post-turn Garden source observation", () => {
  it("passes the verified delivery observation time to the provider", async () => {
    const compile = vi.fn(async () => []);
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const observedAt = new Date(Date.now() - 120_000).toISOString();
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: compile
    });
    harness.enqueuePostTurnTask({
      created_at: createdAt,
      payload: createPostTurnPayload({
        created_at: createdAt,
        source_observation: {
          observed_at: observedAt,
          authority: "verified_delivery_observation",
          source_event_id: "event-delivery-1"
        }
      })
    });

    await harness.runScheduler();

    expect(compile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        source_observed_at: observedAt
      })
    );
  });

  it("omits source_observed_at when no verified delivery observation exists", async () => {
    const compile = vi.fn(async () => []);
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: compile
    });
    harness.enqueuePostTurnTask({
      created_at: createdAt,
      payload: createPostTurnPayload({ created_at: createdAt })
    });

    await harness.runScheduler();

    expect(compile).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.objectContaining({ source_observed_at: expect.anything() })
    );
  });

  it("does not shift a verified delivery observation to worker process time after delay", async () => {
    const compile = vi.fn<GardenComputeProvider["compile"]>(async () => []);
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: compile
    });
    const enqueuedAt = new Date(Date.now() - 60_000).toISOString();
    harness.enqueuePostTurnTask({
      created_at: enqueuedAt,
      payload: createPostTurnPayload({
        created_at: enqueuedAt,
        source_observation: {
          observed_at: enqueuedAt,
          authority: "verified_delivery_observation",
          source_event_id: "event-delivery-1"
        }
      })
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
