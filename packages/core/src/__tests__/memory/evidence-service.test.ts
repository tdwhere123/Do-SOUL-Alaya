import { describe, expect, it, vi } from "vitest";
import { expectFrozenPropertyWriteThrows } from "../support/frozen-mutation.js";
import {
  EvidenceHealthState,
  TransitionCausedBy,
  type EvidenceCapsule,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { EvidenceService } from "../../memory/evidence-service.js";
import { createEvidenceInput } from "./evidence-service-fixture.js";

describe("EvidenceService", () => {
  it("writes soul.evidence.created before persistence and runtime notification", async () => {
    const order: string[] = [];
    const appendedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
    const store = new Map<string, EvidenceCapsule>();
    const create = vi.fn((capsule: EvidenceCapsule) => {
      order.push("repo_create");
      store.set(capsule.object_id, Object.freeze({ ...capsule }));
      return store.get(capsule.object_id)!;
    });

    const service = new EvidenceService({
      now: () => "2026-03-20T01:00:00.000Z",
      generateObjectId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      eventLogRepo: {
        append: vi.fn((event) => {
          order.push("event_log");
          appendedEvents.push(event);
          return {
            event_id: "event-1",
            created_at: "2026-03-20T01:00:00.000Z",
            revision: 0,
            ...event
          };
        }),
        transactional: <T>(fn: () => T) => fn()
      },
      evidenceCapsuleRepo: {
        create,
        createInCurrentTransaction: create,
        deleteById: vi.fn(async () => {
          throw new Error("not used");
        }),
        findById: vi.fn(async (objectId) => store.get(objectId) ?? null),
        findByRunId: vi.fn(async () => []),
        findByWorkspaceId: vi.fn(async () => []),
        findByHealth: vi.fn(async () => []),
        updateHealth: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {
          order.push("notify");
        })
      }
    });

    const projection = {
      projection_id: 1,
      projection_kind: "user_assertion" as const,
      content: "I bought my bookshelf from IKEA."
    };
    const created = await service.create(createEvidenceInput(), [projection]);

    expect(order).toEqual(["event_log", "repo_create", "event_log", "notify"]);
    expect(created.object_id).toBe("85b3671a-d8d8-4848-9e5c-07d0a89f5ae9");
    expect(create).toHaveBeenCalledWith(
      expect.any(Object),
      [projection],
      expect.objectContaining({ status: "unavailable" }),
      expect.objectContaining({ status: "unavailable", graph: null }),
      expect.objectContaining({
        status: "not_applicable",
        reason_code: "upstream_not_formed"
      })
    );
    expect(appendedEvents[1]).toMatchObject({
      event_type: "soul.field.source_record.admitted",
      entity_type: "source_record"
    });
    expect(appendedEvents[0]).toMatchObject({
      event_type: "soul.evidence.created",
      entity_type: "evidence_capsule",
      entity_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      workspace_id: "workspace-1",
      run_id: "run-1",
      payload_json: {
        object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
        object_kind: "evidence_capsule",
        workspace_id: "workspace-1",
        run_id: "run-1"
      }
    });
  });

  it("rolls back the EventLog row when evidence create throws", async () => {
    const events: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
    const notify = vi.fn();
    const service = new EvidenceService({
      now: () => "2026-03-20T01:00:00.000Z",
      generateObjectId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      eventLogRepo: {
        append: vi.fn((event) => {
          events.push(event);
          return {
            event_id: "event-1",
            created_at: "2026-03-20T01:00:00.000Z",
            revision: 0,
            ...event
          };
        }),
        transactional: <T>(fn: () => T) => {
          const start = events.length;
          try {
            return fn();
          } catch (error) {
            events.length = start;
            throw error;
          }
        }
      },
      evidenceCapsuleRepo: {
        create: vi.fn(async () => {
          throw new Error("not used");
        }),
        createInCurrentTransaction: vi.fn(() => {
          throw new Error("row failed");
        }),
        deleteById: vi.fn(async () => {
          throw new Error("not used");
        }),
        findById: vi.fn(async () => null),
        findByRunId: vi.fn(async () => []),
        findByWorkspaceId: vi.fn(async () => []),
        findByHealth: vi.fn(async () => []),
        updateHealth: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      runtimeNotifier: { notifyEntry: notify }
    });

    await expect(service.create(createEvidenceInput())).rejects.toThrow("row failed");
    expect(events).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("writes soul.evidence.health_changed and updates repo health", async () => {
    const order: string[] = [];
    const appendedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];

    const existing: EvidenceCapsule = Object.freeze({
      object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      object_kind: "evidence_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-20T00:00:00.000Z",
      updated_at: "2026-03-20T00:00:00.000Z",
      created_by: "user_action",
      evidence_kind: "tool_output",
      semantic_anchor: {
        topic: "build",
        keywords: ["pnpm", "build"],
        summary: "Build output"
      },
      event_anchor: null,
      physical_anchor: null,
      evidence_health_state: EvidenceHealthState.VERIFIED,
      gist: "Evidence gist",
      excerpt: "Evidence excerpt",
      source_hash: "sha256:abc",
      run_id: "run-1",
      workspace_id: "workspace-1",
      surface_id: null
    });

    const service = new EvidenceService({
      now: () => "2026-03-20T02:00:00.000Z",
      eventLogRepo: {
        append: vi.fn(async (event) => {
          order.push("event_log");
          appendedEvents.push(event);
          return {
            event_id: "event-2",
            created_at: "2026-03-20T02:00:00.000Z",
            revision: 0,
            ...event
          };
        })
      },
      evidenceCapsuleRepo: {
        create: vi.fn(async () => {
          throw new Error("not used");
        }),
        deleteById: vi.fn(async () => {
          throw new Error("not used");
        }),
        findById: vi.fn(async () => existing),
        findByRunId: vi.fn(async () => []),
        findByWorkspaceId: vi.fn(async () => []),
        findByHealth: vi.fn(async () => []),
        updateHealth: vi.fn(async (_objectId, nextHealth, updatedAt) => {
          order.push("repo_update");
          return Object.freeze({
            ...existing,
            evidence_health_state: nextHealth,
            updated_at: updatedAt
          });
        })
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {
          order.push("notify");
        })
      }
    });

    const updated = await service.transitionHealth(
      existing.object_id,
      EvidenceHealthState.DEGRADED,
      "manual_review",
      TransitionCausedBy.REVIEW
    );

    expect(order).toEqual(["event_log", "repo_update", "notify"]);
    expect(updated.evidence_health_state).toBe(EvidenceHealthState.DEGRADED);

    expect(appendedEvents[0]).toMatchObject({
      event_type: "soul.evidence.health_changed",
      entity_type: "evidence_capsule",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      payload_json: {
        object_id: existing.object_id,
        object_kind: "evidence_capsule",
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: EvidenceHealthState.VERIFIED,
        to_state: EvidenceHealthState.DEGRADED,
        reason_code: "manual_review",
        caused_by: TransitionCausedBy.REVIEW,
        evidence_refs: null,
        occurred_at: "2026-03-20T02:00:00.000Z"
      }
    });
  });

  it("returns immutable evidence objects", async () => {
    const store = new Map<string, EvidenceCapsule>();

    const service = new EvidenceService({
      now: () => "2026-03-20T01:00:00.000Z",
      generateObjectId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      eventLogRepo: {
        append: vi.fn((event) => ({
          event_id: "event-immutable",
          created_at: "2026-03-20T01:00:00.000Z",
          revision: 0,
          ...event
        })),
        transactional: <T>(fn: () => T) => fn()
      },
      evidenceCapsuleRepo: {
        create: vi.fn((capsule) => {
          const frozen = Object.freeze({ ...capsule });
          store.set(capsule.object_id, frozen);
          return frozen;
        }),
        createInCurrentTransaction: vi.fn((capsule) => {
          const frozen = Object.freeze({ ...capsule });
          store.set(capsule.object_id, frozen);
          return frozen;
        }),
        deleteById: vi.fn(async () => {
          throw new Error("not used");
        }),
        findById: vi.fn(async (objectId) => store.get(objectId) ?? null),
        findByRunId: vi.fn(async () => []),
        findByWorkspaceId: vi.fn(async () => []),
        findByHealth: vi.fn(async () => []),
        updateHealth: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {})
      }
    });

    const created = await service.create(createEvidenceInput());

    expectFrozenPropertyWriteThrows(created, "gist", "mutated");
  });

  it("rejects invalid health transitions", async () => {
    const existing: EvidenceCapsule = Object.freeze({
      object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      object_kind: "evidence_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-20T00:00:00.000Z",
      updated_at: "2026-03-20T00:00:00.000Z",
      created_by: "user_action",
      evidence_kind: "tool_output",
      semantic_anchor: {
        topic: "build",
        keywords: ["pnpm", "build"],
        summary: "Build output"
      },
      event_anchor: null,
      physical_anchor: null,
      evidence_health_state: EvidenceHealthState.BROKEN,
      gist: "Evidence gist",
      excerpt: "Evidence excerpt",
      source_hash: "sha256:abc",
      run_id: "run-1",
      workspace_id: "workspace-1",
      surface_id: null
    });

    const service = new EvidenceService({
      eventLogRepo: {
        append: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      evidenceCapsuleRepo: {
        create: vi.fn(async () => {
          throw new Error("not used");
        }),
        deleteById: vi.fn(async () => {
          throw new Error("not used");
        }),
        findById: vi.fn(async () => existing),
        findByRunId: vi.fn(async () => []),
        findByWorkspaceId: vi.fn(async () => []),
        findByHealth: vi.fn(async () => []),
        updateHealth: vi.fn(async () => {
          throw new Error("not used");
        })
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {})
      }
    });

    await expect(
      service.transitionHealth(
        existing.object_id,
        EvidenceHealthState.VERIFIED,
        "invalid_transition",
        TransitionCausedBy.SYSTEM
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });
  });
});
