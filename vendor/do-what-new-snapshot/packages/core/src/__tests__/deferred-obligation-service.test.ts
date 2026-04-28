import { describe, expect, it, vi } from "vitest";
import { PhaseBEventType, type DeferredObligation, type EventLogEntry } from "@do-what/protocol";
import { CoreError } from "../errors.js";
import {
  DeferredObligationService,
  type DeferredObligationRepoPort
} from "../deferred-obligation-service.js";
import type { EventPublisher } from "../event-publisher.js";

const FIXED_NOW = "2026-04-15T12:00:00.000Z";

interface Harness {
  readonly repo: DeferredObligationRepoPort & {
    readonly getById: ReturnType<typeof vi.fn>;
    readonly create: ReturnType<typeof vi.fn>;
    readonly updateState: ReturnType<typeof vi.fn>;
    readonly findActiveByRun: ReturnType<typeof vi.fn>;
    readonly findActiveByWorkspace: ReturnType<typeof vi.fn>;
    readonly findExpired: ReturnType<typeof vi.fn>;
  };
  readonly events: Array<Omit<EventLogEntry, "event_id" | "created_at">>;
  readonly publishWithMutation: ReturnType<typeof vi.fn>;
  readonly service: DeferredObligationService;
  getById(obligationId: string): Readonly<DeferredObligation> | null;
}

describe("DeferredObligationService", () => {
  it("creates a pending obligation and emits obligation.created", async () => {
    const harness = createHarness();

    const created = await harness.service.create({
      kind: "safety_finding",
      description: "Address the blocking safety finding.",
      sourceRunId: "run-1",
      workspaceId: "workspace-1",
      targetEntityId: "claim-1",
      expiresAt: "2026-04-16T12:00:00.000Z"
    });

    expect(created).toEqual({
      obligation_id: "obligation-1",
      kind: "safety_finding",
      state: "pending",
      description: "Address the blocking safety finding.",
      source_run_id: "run-1",
      workspace_id: "workspace-1",
      target_entity_id: "claim-1",
      created_at: FIXED_NOW,
      expires_at: "2026-04-16T12:00:00.000Z"
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      event_type: PhaseBEventType.OBLIGATION_CREATED,
      entity_type: "deferred_obligation",
      entity_id: "obligation-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "deferred_obligation_service",
      payload_json: {
        obligation_id: "obligation-1",
        kind: "safety_finding",
        state: "pending"
      }
    });
  });

  it("fulfills a pending obligation and emits obligation.fulfilled", async () => {
    const harness = createHarness([
      createObligation({
        obligation_id: "obligation-1",
        expires_at: "2026-04-16T12:00:00.000Z"
      })
    ]);

    const fulfilled = await harness.service.fulfill("obligation-1");

    expect(fulfilled.state).toBe("fulfilled");
    expect(fulfilled.fulfilled_at).toBe(FIXED_NOW);
    expect(harness.repo.updateState).toHaveBeenCalledWith("obligation-1", "pending", "fulfilled", {
      fulfilledAt: FIXED_NOW
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      event_type: PhaseBEventType.OBLIGATION_FULFILLED,
      entity_type: "deferred_obligation",
      entity_id: "obligation-1",
      payload_json: {
        obligation_id: "obligation-1",
        fulfilled_at: FIXED_NOW
      }
    });
  });

  it("expires a past-due pending obligation and emits obligation.expired", async () => {
    const harness = createHarness([
      createObligation({
        obligation_id: "obligation-1",
        expires_at: "2026-04-15T11:59:00.000Z"
      })
    ]);

    const expired = await harness.service.expire("obligation-1");

    expect(expired.state).toBe("expired");
    expect(expired.fulfilled_at).toBeUndefined();
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      event_type: PhaseBEventType.OBLIGATION_EXPIRED,
      entity_type: "deferred_obligation",
      entity_id: "obligation-1",
      payload_json: {
        obligation_id: "obligation-1",
        expired_at: FIXED_NOW
      }
    });
  });

  it("rejects expiring a not-yet-due obligation", async () => {
    const harness = createHarness([
      createObligation({
        obligation_id: "obligation-1",
        expires_at: "2026-04-16T12:00:00.000Z"
      })
    ]);

    await expect(harness.service.expire("obligation-1")).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT"
    });
    expect(harness.events).toHaveLength(0);
  });

  it("returns active pending obligations for the run", async () => {
    const harness = createHarness([
      createObligation({ obligation_id: "pending-1", state: "pending", source_run_id: "run-1" }),
      createObligation({ obligation_id: "fulfilled-1", state: "fulfilled", source_run_id: "run-1", fulfilled_at: FIXED_NOW }),
      createObligation({ obligation_id: "other-run", state: "pending", source_run_id: "run-2" })
    ]);

    const active = await harness.service.findActiveByRun("run-1");

    expect(active).toEqual([
      createObligation({ obligation_id: "pending-1", state: "pending", source_run_id: "run-1" })
    ]);
  });
});

function createHarness(seed: readonly DeferredObligation[] = []): Harness {
  const store = new Map<string, DeferredObligation>(
    seed.map((obligation) => [obligation.obligation_id, Object.freeze({ ...obligation })])
  );
  const events: Array<Omit<EventLogEntry, "event_id" | "created_at">> = [];

  const repo = {
    getById: vi.fn(async (obligationId: string) => store.get(obligationId) ?? null),
    create: vi.fn(async (obligation: DeferredObligation) => {
      const created = Object.freeze({ ...obligation });
      store.set(created.obligation_id, created);
      return created;
    }),
    updateState: vi.fn(
      async (
        obligationId: string,
        expectedState: DeferredObligation["state"],
        nextState: DeferredObligation["state"],
        options?: {
          readonly fulfilledAt?: string;
        }
      ) => {
        const existing = store.get(obligationId);

        if (existing === undefined) {
          throw new CoreError("NOT_FOUND", `Deferred obligation ${obligationId} not found`);
        }

        if (existing.state !== expectedState) {
          throw new CoreError(
            "CONFLICT",
            `Deferred obligation ${obligationId} state mismatch: expected ${expectedState}, found ${existing.state}`
          );
        }

        const updated = Object.freeze({
          ...existing,
          state: nextState,
          fulfilled_at:
            nextState === "fulfilled" ? options?.fulfilledAt ?? FIXED_NOW : undefined
        });
        store.set(obligationId, updated);
        return updated;
      }
    ),
    findActiveByRun: vi.fn(async (runId: string) =>
      [...store.values()].filter((obligation) => {
        return obligation.source_run_id === runId && obligation.state === "pending";
      })
    ),
    findActiveByWorkspace: vi.fn(async (workspaceId: string) =>
      [...store.values()].filter((obligation) => {
        return obligation.workspace_id === workspaceId && obligation.state === "pending";
      })
    ),
    findExpired: vi.fn(async (now: string) =>
      [...store.values()].filter((obligation) => {
        return obligation.state === "pending" && obligation.expires_at < now;
      })
    )
  } satisfies DeferredObligationRepoPort;

  const publishWithMutation = vi.fn(
    async (
      eventInput: Omit<EventLogEntry, "event_id" | "created_at">,
      mutate: () => Promise<DeferredObligation>
    ) => {
      events.push(eventInput);
      return await mutate();
    }
  );

  const service = new DeferredObligationService({
    repo,
    eventPublisher: {
      publishWithMutation
    } as unknown as EventPublisher,
    now: () => FIXED_NOW,
    generateObligationId: () => "obligation-1"
  });

  return {
    repo,
    events,
    publishWithMutation,
    service,
    getById: (obligationId: string) => store.get(obligationId) ?? null
  };
}

function createObligation(overrides: Partial<DeferredObligation> = {}): DeferredObligation {
  return {
    obligation_id: overrides.obligation_id ?? "obligation-1",
    kind: overrides.kind ?? "safety_finding",
    state: overrides.state ?? "pending",
    description: overrides.description ?? "Address pending safety finding.",
    source_run_id: overrides.source_run_id ?? "run-1",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    target_entity_id: overrides.target_entity_id,
    created_at: overrides.created_at ?? FIXED_NOW,
    expires_at: overrides.expires_at ?? "2026-04-16T12:00:00.000Z",
    fulfilled_at: overrides.fulfilled_at
  };
}
