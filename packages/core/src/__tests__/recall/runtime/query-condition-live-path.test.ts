import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import {
  captureEffectiveAsOf,
  captureQueryCondition
} from "../../../recall/query/condition/query-condition-capture.js";
import { queryConditionParityView } from
  "../../../recall/runtime/query-condition-parity.js";
import {
  createSeededTestOnlyInMemoryFieldQuerySession
} from "../../../recall/runtime/query/field-query-session.js";
import { captureRecallRequestTime } from
  "../../../recall/runtime/query/recall-request-time.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import {
  CLOCK_AS_OF,
  countingClock,
  EXPLICIT_AS_OF,
  frozenClock
} from "../query/query-condition-test-fixtures.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "../recall-service-test-fixtures.js";

describe("live query condition capture", () => {
  it("stamps field snapshot and as-of without pinning a query-session generation", async () => {
    const { dependencies } = createDependencies([]);
    const service = new RecallService({
      ...dependencies,
      now: frozenClock()
    });

    const result = await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: createTaskSurface()
    });

    expect(result.index.snapshot_id).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.index.as_of).toBe(CLOCK_AS_OF);
    expect(result.ranking_authority).not.toBe("prefix_sk");
    expect(result.capture_execution).toBeUndefined();
    expect(result.provider_calls).toBe(0);
    expect(result.garden_enqueue).toBe(0);
  });

  it("does not require path expansion for ordinary live recall", async () => {
    const findByAnchors = vi.fn(async () => []);
    const { dependencies } = createDependencies([
      createMemoryEntry({ object_id: "memory-1", content: "Implement recall" })
    ]);
    const service = new RecallService({
      ...dependencies,
      now: frozenClock(),
      pathExpansionPort: { findByAnchors }
    });

    const result = await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: createTaskSurface()
    });

    expect(findByAnchors).not.toHaveBeenCalled();
    expect(result.index.snapshot_id).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.index.as_of).toBe(CLOCK_AS_OF);
    expect(result.provider_calls).toBe(0);
  });

  it("stamps Zulu as-of on the field snapshot", async () => {
    const { dependencies } = createDependencies([
      createMemoryEntry({ object_id: "memory-1", content: "Implement recall" })
    ]);
    const service = new RecallService({
      ...dependencies,
      now: frozenClock()
    });

    const result = await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: createTaskSurface(),
      referenceTime: CLOCK_AS_OF
    });

    expect(result.index.as_of).toBe(CLOCK_AS_OF);
    expect(result.index.snapshot_id).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.ranking_authority).not.toBe("prefix_sk");
  });

  it("separates explicit semantic as-of from operational capture time", () => {
    const clock = countingClock("2026-08-16T23:59:59.000Z");
    const session = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = session.pinActiveGeneration("workspace-1", EXPLICIT_AS_OF);
    const time = captureRecallRequestTime({
      explicitAsOf: EXPLICIT_AS_OF,
      now: clock.now
    });
    const receipt = captureQueryCondition({
      principal: "workspace-1",
      workspace_id: "workspace-1",
      authorized_scopes: ["workspace-1"],
      explicit_bridges: [],
      workspace_project: "workspace-1",
      query_task_factors: ["Ada"],
      governance_state: "open",
      activation_budget: 8,
      token_budget: 400,
      effective_as_of: time.effectiveAsOf
    }, {
      sha256: fieldContractSha256,
      now: () => time.effectiveAsOf,
      recordedAt: time.capturedAt,
      pin
    });

    expect(receipt.condition.effective_as_of).toBe(EXPLICIT_AS_OF);
    expect(receipt.recorded_at).toBe("2026-08-16T23:59:59.000Z");
    expect(clock.calls()).toBe(1);
    expect(captureEffectiveAsOf(EXPLICIT_AS_OF, clock.now)).toBe(EXPLICIT_AS_OF);
    expect(queryConditionParityView(receipt).generation_id).toBe(pin.generation_id);
  });

  it("keeps direct and worker receipts on the same captured condition", () => {
    const session = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = session.pinActiveGeneration("workspace-1", CLOCK_AS_OF);
    const deps = { sha256: fieldContractSha256, now: frozenClock(), pin };
    const draft = {
      principal: "workspace-1",
      workspace_id: "workspace-1",
      authorized_scopes: ["workspace-1"],
      explicit_bridges: [] as const,
      workspace_project: "workspace-1",
      query_task_factors: ["Implement recall"],
      governance_state: "open",
      activation_budget: 8,
      token_budget: 400
    };
    const direct = captureQueryCondition(draft, deps);
    const worker = captureQueryCondition(draft, deps);
    expect(queryConditionParityView(direct)).toEqual(queryConditionParityView(worker));
  });
});
