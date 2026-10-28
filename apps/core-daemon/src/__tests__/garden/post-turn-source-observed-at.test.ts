import { afterEach, describe, expect, it, vi } from "vitest";
import type { GardenComputeProvider } from "@do-soul/alaya-soul";
import {
  cleanupPostTurnExtractHarnesses,
  createPostTurnPayload,
  createRoutingHarness,
  createSignal,
  gardenTaskSignalId
} from "../mcp-memory/garden/post-turn-extract-task-fixture.js";

afterEach(() => {
  cleanupPostTurnExtractHarnesses();
});

describe("post-turn Garden source observation", () => {
  const processTime = "2026-07-27T12:10:00.000Z";

  it("does not assign delivery time to candidate content from an older task", async () => {
    const gist = "  用户确认了发布 🚀  ";
    const sourceObservation = {
      observed_at: "2026-07-27T12:00:00.000Z",
      authority: "verified_delivery_observation" as const,
      source_event_id: "delivery-event-一-🚀"
    };
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: async () => [createSignal({
        raw_payload: { excerpt: null, gist },
        source_observation: null
      })]
    });
    harness.enqueuePostTurnTask({
      payload: createPostTurnPayload({ source_observation: sourceObservation })
    });

    await harness.runScheduler();

    const stored = await harness.signalRepo.getById(gardenTaskSignalId("post-turn-task-1", 0));
    expect(stored?.source_observation).toBeNull();
    expect(stored?.raw_payload.gist).toBe(gist);
  });

  it("does not pass delivery time to the provider as source time", async () => {
    const compile = vi.fn(async () => []);
    const createdAt = "2026-07-27T12:09:00.000Z";
    const observedAt = "2026-07-27T12:08:00.000Z";
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      now: () => processTime,
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
      expect.not.objectContaining({ source_observed_at: expect.anything() })
    );
  });

  it("omits source_observed_at when no verified delivery observation exists", async () => {
    const compile = vi.fn(async () => []);
    const createdAt = "2026-07-27T12:09:00.000Z";
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      now: () => processTime,
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

  it("preserves a trusted host event time after delayed processing", async () => {
    const compile = vi.fn<GardenComputeProvider["compile"]>(async () => []);
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      now: () => processTime,
      localCompile: compile
    });
    const enqueuedAt = "2026-07-27T12:09:00.000Z";
    harness.enqueuePostTurnTask({
      created_at: enqueuedAt,
      payload: createPostTurnPayload({
        created_at: enqueuedAt,
        source_observed_at: enqueuedAt
      })
    });

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
    expect(observedAt).not.toBe(processTime);
    expect(Date.parse(observedAt)).toBeLessThan(Date.parse(processTime));
  });
});
