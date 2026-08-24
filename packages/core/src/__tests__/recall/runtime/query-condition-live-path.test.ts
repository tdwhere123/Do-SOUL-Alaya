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
import { prepareRecallQueryCondition } from
  "../../../recall/runtime/query/prepare-recall-query-condition.js";
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
  it("captures default as-of once and pins a real generation", async () => {
    const operationalAt = "2026-08-16T00:00:01.000Z";
    const now = entranceThenOperationalClock(CLOCK_AS_OF, operationalAt);
    const { dependencies, appendSpy } = createDependencies([]);
    const baseSession = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const session = {
      pinActiveGeneration: vi.fn(baseSession.pinActiveGeneration),
      selectCandidates: vi.fn(baseSession.selectCandidates),
      renew: vi.fn(baseSession.renew),
      release: vi.fn(baseSession.release)
    };
    const service = new RecallService({
      testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      now,
      fieldQuerySession: session,
      sha256: fieldContractSha256
    });

    const result = await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: createTaskSurface()
    });
    const view = result.diagnostics?.query_condition;

    expect(view?.effective_as_of).toBe(CLOCK_AS_OF);
    expect(view?.generation_id).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(view?.condition_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(view?.query_cache_key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(view?.generation_id).not.toBe(`sha256:${"a".repeat(64)}`);
    expect(view?.condition_digest).not.toBe(`sha256:${"b".repeat(64)}`);
    expect(session.pinActiveGeneration).toHaveBeenCalledWith("workspace-1", operationalAt);
    expect(session.selectCandidates).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      operationalAt
    );
    expect(new Set(session.renew.mock.calls.map(([, renewedAt]) => renewedAt))).toEqual(
      new Set([operationalAt])
    );
    expect(session.release).toHaveBeenCalledWith(expect.anything(), operationalAt);
    expect(appendSpy).toHaveBeenCalledWith(expect.objectContaining({
      payload_json: expect.objectContaining({ occurred_at: operationalAt })
    }));
  });

  it("passes captured as-of into path reads when the caller omits referenceTime", async () => {
    const findByAnchors = vi.fn(async (
      _workspaceId: string,
      _anchors: readonly unknown[],
      _options?: Readonly<{ asOf?: string }>
    ) => []);
    const { dependencies } = createDependencies([
      createMemoryEntry({ object_id: "memory-1", content: "Implement recall" })
    ]);
    const service = new RecallService({
      testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      now: frozenClock(),
      fieldQuerySession: createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1"),
      sha256: fieldContractSha256,
      pathExpansionPort: { findByAnchors }
    });

    await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: createTaskSurface()
    });

    expect(findByAnchors).toHaveBeenCalled();
    expect(findByAnchors.mock.calls[0]?.[2]).toEqual({ asOf: CLOCK_AS_OF });
  });

  it("canonicalizes receipts while preserving the path calendar offset", async () => {
    const findByAnchors = vi.fn(async (
      _workspaceId: string,
      _anchors: readonly unknown[],
      _options?: Readonly<{ asOf?: string }>
    ) => []);
    const { dependencies } = createDependencies([
      createMemoryEntry({ object_id: "memory-1", content: "Implement recall" })
    ]);
    const service = new RecallService({
      testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      now: frozenClock(),
      fieldQuerySession: createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1"),
      sha256: fieldContractSha256,
      pathExpansionPort: { findByAnchors }
    });

    const result = await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: createTaskSurface(),
      referenceTime: "2026-08-16T01:00:00.000+01:00"
    });

    expect(result.diagnostics?.query_condition?.effective_as_of).toBe(
      "2026-08-16T00:00:00.000Z"
    );
    expect(findByAnchors.mock.calls[0]?.[2]).toEqual({
      asOf: "2026-08-16T01:00:00.000+01:00"
    });
  });

  it("separates explicit semantic as-of from operational capture time", () => {
    const clock = countingClock("2026-08-16T23:59:59.000Z");
    const session = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = session.pinActiveGeneration("workspace-1", EXPLICIT_AS_OF);
    const receipt = prepareRecallQueryCondition({
      workspaceId: "workspace-1",
      explicitAsOf: EXPLICIT_AS_OF,
      queryText: "Ada",
      tokenBudget: 400,
      activationBudget: 8,
      sha256: fieldContractSha256,
      time: captureRecallRequestTime({ explicitAsOf: EXPLICIT_AS_OF, now: clock.now }),
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

function entranceThenOperationalClock(
  entranceAt: string,
  operationalAt: string
): () => string {
  let entrancePending = true;
  return () => {
    if (!entrancePending) return operationalAt;
    entrancePending = false;
    return entranceAt;
  };
}
