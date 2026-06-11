import { describe, expect, it, vi } from "vitest";
import {
  RuntimeCapabilitiesSchema,
  type DelegatedWorkerRun,
  type EventLogEntry,
  type RuntimeCapabilities
} from "@do-soul/alaya-protocol";
import { EventPublisherPropagationError } from "../../event-publisher.js";
import {
  IntegrationGate,
  IntegrationGatePublicationError,
  VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
  WORKER_INTEGRATION_STATUS_EVENT_TYPE
} from "../../security/integration-gate.js";
import type { TestMock } from "../mock-types.js";

const FIXED_NOW = "2026-04-14T06:00:00.000Z";

describe("IntegrationGate", () => {
  it("returns ignore_drift and does not publish when actual capabilities match the expected baseline", async () => {
    const harness = createHarness();
    const gate = new IntegrationGate({
      expectedProfile: VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
      eventPublisher: harness.eventPublisher,
      now: () => FIXED_NOW
    });

    const result = await gate.check(
      createWorkerRun(),
      VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE.capabilities
    );

    expect(result.level).toBe("ignore_drift");
    expect(result.mismatches).toEqual([]);
    expect(result.reason).toContain("match");
    expect(harness.publishedEvents).toEqual([]);
  });

  it("returns soft_stale and publishes worker.integration_status for non-critical mismatches", async () => {
    const harness = createHarness();
    const gate = new IntegrationGate({
      expectedProfile: VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
      eventPublisher: harness.eventPublisher,
      now: () => FIXED_NOW
    });
    const actual = createCapabilities({
      supports_interrupt: false
    });

    const result = await gate.check(createWorkerRun(), actual);

    expect(result.level).toBe("soft_stale");
    expect(result.reason).toContain("supports_interrupt");
    expect(result.mismatches).toEqual([
      {
        flag: "supports_interrupt",
        expected: true,
        actual: false
      }
    ]);
    expect(harness.publishedEvents).toHaveLength(1);
    expect(String(harness.publishedEvents[0]?.event_type)).toBe(WORKER_INTEGRATION_STATUS_EVENT_TYPE);
    expect(harness.publishedEvents[0]?.payload_json).toMatchObject({
      workerRunId: "worker-run-1",
      level: "soft_stale",
      detectedAt: FIXED_NOW
    });
  });

  it("treats supports_streaming_updates as critical by default even when the injected profile omits it", async () => {
    const harness = createHarness();
    const gate = new IntegrationGate({
      expectedProfile: {
        ...VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
        criticalMismatches: []
      },
      eventPublisher: harness.eventPublisher,
      now: () => FIXED_NOW
    });
    const actual = createCapabilities({
      supports_streaming_updates: false
    });

    const result = await gate.check(createWorkerRun(), actual);

    expect(result.level).toBe("hard_stale");
    expect(result.reason).toContain("supports_streaming_updates");
    expect(harness.publishedEvents).toHaveLength(1);
    expect(harness.publishedEvents[0]?.payload_json).toMatchObject({
      level: "hard_stale",
      workerRunId: "worker-run-1",
      detectedAt: FIXED_NOW
    });
  });

  it("surfaces whether a durable integration decision event was already appended when publish propagation fails", async () => {
    const workerRun = createWorkerRun();
    const decisionPayload = {
      workerRunId: workerRun.worker_run_id,
      level: "soft_stale",
      reason: "supports_interrupt expected=true actual=false",
      detectedAt: FIXED_NOW
    } as const;
    const gate = new IntegrationGate({
      expectedProfile: VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
      eventPublisher: {
        publish: vi.fn(async () => {
          throw new EventPublisherPropagationError(
            {
              event_id: "event-1",
              created_at: FIXED_NOW,
              revision: 0,
              event_type: WORKER_INTEGRATION_STATUS_EVENT_TYPE,
              entity_type: "worker_run",
              entity_id: workerRun.worker_run_id,
              workspace_id: workerRun.workspace_id,
              run_id: workerRun.principal_run_id,
              caused_by: "system",
              payload_json: decisionPayload
            },
            new Error("broadcast exploded")
          );
        })
      },
      now: () => FIXED_NOW
    });

    await expect(
      gate.check(
        workerRun,
        createCapabilities({
          supports_interrupt: false
        })
      )
    ).rejects.toMatchObject({
      name: "IntegrationGatePublicationError",
      durableDecisionCommitted: true,
      decision: expect.objectContaining({
        workerRunId: workerRun.worker_run_id,
        level: "soft_stale",
        reason: "supports_interrupt expected=true actual=false",
        detectedAt: FIXED_NOW
      })
    });
  });
});

function createHarness(): {
  readonly eventPublisher: {
    readonly publish: TestMock;
  };
  readonly publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">>;
} {
  const publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
  const eventPublisher = {
    publish: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      publishedEvents.push(event);
      return {
        ...event,
        event_id: `event-${publishedEvents.length}`,
        created_at: FIXED_NOW,
      revision: 0
      } satisfies EventLogEntry;
    })
  };

  return {
    eventPublisher,
    publishedEvents
  };
}

function createCapabilities(overrides: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities {
  return RuntimeCapabilitiesSchema.parse({
    ...VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE.capabilities,
    ...overrides
  });
}

function createWorkerRun(overrides: Partial<DelegatedWorkerRun> = {}): DelegatedWorkerRun {
  return {
    worker_run_id: "worker-run-1",
    principal_run_id: "principal-run-1",
    workspace_id: "workspace-1",
    requesting_run_id: "principal-run-1",
    engine_class: "coding_engine",
    state: "init",
    subtask_description: "Investigate integration drift.",
    local_surface_ref: "surface://principal/1",
    local_evidence_pointer: "evidence://principal/1",
    restricted_tool_set: ["read_file"],
    local_budget: {
      max_worker_delegations: 1,
      max_tool_calls: 2,
      max_output_tokens: 1024,
      max_wall_time_ms: 30000
    },
    agreed_return_format: {
      allowed_return_kinds: ["analysis_note"],
      requires_structured_summary: true
    },
    principal_security_snapshot: {
      governance_lease_ref: "lease://principal/1",
      hard_constraint_refs: ["constraint://1"],
      denied_tool_categories: ["network"]
    },
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    ...overrides
  };
}
