import { describe, expect, it, vi } from "vitest";
import { ObligationTrustNarrativeEventType, type DeferredObligation, type EventLogEntry } from "@do-soul/alaya-protocol";
import { ConstraintProxy } from "../../security/constraint-proxy.js";
import type { EventPublisher } from "../../runtime/event-publisher.js";

const FIXED_NOW = "2026-04-15T12:00:00.000Z";

describe("ConstraintProxy", () => {
  it("passes silently when there are no active obligations", async () => {
    const publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
    const proxy = new ConstraintProxy({
      obligationLookup: {
        findActiveByRun: vi.fn(async () => [])
      },
      eventPublisher: {
        publish: vi.fn(async (eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
          publishedEvents.push(eventInput);
          return {
            ...eventInput,
            event_id: "event-1",
            created_at: FIXED_NOW
          };
        })
      } as unknown as EventPublisher,
      now: () => FIXED_NOW
    });

    await expect(
      proxy.assertNoViolation("workspace-1", "run-1", "worker_complete")
    ).resolves.toBeUndefined();
    expect(publishedEvents).toEqual([]);
  });

  it("publishes obligation.violation_blocked and throws OBLIGATION_VIOLATION", async () => {
    const activeObligations: readonly DeferredObligation[] = [
      {
        obligation_id: "obligation-1",
        kind: "safety_finding",
        state: "pending",
        description: "Resolve finding before completion.",
        source_run_id: "run-1",
        workspace_id: "workspace-1",
        created_at: FIXED_NOW,
        expires_at: "2026-04-16T12:00:00.000Z"
      }
    ];
    const publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
    const publish = vi.fn(async (eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      publishedEvents.push(eventInput);
      return {
        ...eventInput,
        event_id: "event-1",
        created_at: FIXED_NOW
      };
    });
    const proxy = new ConstraintProxy({
      obligationLookup: {
        findActiveByRun: vi.fn(async () => activeObligations)
      },
      eventPublisher: {
        publish
      } as unknown as EventPublisher,
      now: () => FIXED_NOW
    });

    await expect(proxy.assertNoViolation("workspace-1", "run-1", "worker_complete")).rejects.toMatchObject({
      name: "CoreError",
      code: "OBLIGATION_VIOLATION"
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publishedEvents[0]).toMatchObject({
      event_type: ObligationTrustNarrativeEventType.OBLIGATION_VIOLATION_BLOCKED,
      entity_type: "run",
      entity_id: "run-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "constraint_proxy",
      payload_json: {
        workspace_id: "workspace-1",
        run_id: "run-1",
        operation: "worker_complete",
        active_obligation_ids: ["obligation-1"],
        blocked_at: FIXED_NOW
      }
    });
  });

  it("rejects invalid operation names", async () => {
    const proxy = new ConstraintProxy({
      obligationLookup: {
        findActiveByRun: vi.fn(async () => [])
      },
      eventPublisher: {
        publish: vi.fn()
      } as unknown as EventPublisher,
      now: () => FIXED_NOW
    });

    await expect(
      proxy.assertNoViolation("workspace-1", "run-1", "invalid_operation" as never)
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });
  });
});
