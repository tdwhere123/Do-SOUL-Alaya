import { afterEach, describe, expect, it } from "vitest";
import { STATEMENT_SESSION_IDLE_MS } from "../../garden/statement-session/statement-session-closure.js";
import {
  cleanupPostTurnExtractHarnesses,
  createPostTurnPayload,
  createRoutingHarness,
  gardenTaskSignalId,
  recordedStatementExtract
} from "../mcp-memory/garden/post-turn-extract-task-fixture.js";

afterEach(() => {
  cleanupPostTurnExtractHarnesses();
});

describe("post-turn Garden source observation", () => {
  const processTime = "2026-07-27T12:10:00.000Z";
  const statement = { text: "  用户确认了发布 🚀  ", relation: "release" };

  async function settle(payload: ReturnType<typeof createPostTurnPayload>, createdAt?: string) {
    const extract = recordedStatementExtract(message => message.role === "user" ? [statement] : []);
    const harness = await createRoutingHarness({ provider_kind: "local_heuristics", now: () => processTime, localExtract: extract });
    harness.enqueuePostTurnTask({ payload, ...(createdAt === undefined ? {} : { created_at: createdAt }) });
    await harness.runScheduler();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();
    const [session] = harness.sessionTasks();
    return { extract, stored: await harness.signalRepo.getById(gardenTaskSignalId(session!.id, 0)) };
  }

  it("does not assign delivery time to a statement or to the model's message time", async () => {
    const { extract, stored } = await settle(createPostTurnPayload({ source_observation: {
      observed_at: "2026-07-27T12:00:00.000Z",
      authority: "verified_delivery_observation",
      source_event_id: "delivery-event-一-🚀"
    } }));

    expect(extract.mock.calls[0]![0].messages.every(message => message.recorded_at === null)).toBe(true);
    expect(stored?.source_observation).toBeNull();
    expect(stored?.raw_payload).toMatchObject({ source_statement: { statement } });
  });

  it("keeps each turn's trusted host receipt time on its statements after delayed processing", async () => {
    const enqueuedAt = "2026-07-27T12:09:00.000Z";
    const { extract, stored } = await settle(createPostTurnPayload({ created_at: enqueuedAt, source_observed_at: enqueuedAt }),
      enqueuedAt);

    expect(extract.mock.calls[0]![0].messages.every(message => message.recorded_at === null)).toBe(true);
    expect(stored?.source_observation).toMatchObject({ observed_at: enqueuedAt, authority: "trusted_host_event" });
    expect(Date.parse(stored!.source_observation!.observed_at)).toBeLessThan(Date.parse(processTime));
  });
});
