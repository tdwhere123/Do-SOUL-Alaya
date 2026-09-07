import { describe, expect, it, vi } from "vitest";

import { RecallService } from "../../../recall/recall-service.js";
import { isActiveRecallReadCapability, withActiveRecallReadSnapshot } from
  "../../../recall/runtime/recall-read-snapshot.js";
import {
  createSeededTestOnlyInMemoryFieldQuerySession,
  createTestOnlyInMemoryFieldQuerySession
} from
  "../../../recall/runtime/query/field-query-session.js";
import { captureQueryCondition } from
  "../../../recall/query/condition/query-condition-capture.js";
import { finishProjectionPinCleanup, startProjectionPinLeaseGuard } from
  "../../../recall/runtime/query/projection-pin-lease.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import {
  createDependencies,
  createTaskSurface
} from "../recall-8factor-test-fixtures.js";

const CLOCK = "2026-08-16T00:00:00.000Z";

describe("conditional field read snapshot lifecycle", () => {
  it("rolls back a failed field read without committing or writing EventLog", async () => {
    const { dependencies } = createDependencies([]);
    const commit = vi.fn();
    const rollback = vi.fn();
    const append = vi.fn(dependencies.eventLogRepo.append);
    const failure = new Error("field read failed");
    const service = new RecallService({
      ...dependencies,
      readSnapshot: { beginDeferred: vi.fn(), commit, rollback },
      conditionalFieldPort: { recall: async () => { throw failure; } },
      eventLogRepo: { ...dependencies.eventLogRepo, append }
    });
    await expect(service.recall({
      taskSurface: createTaskSurface("Ada"), workspaceId: "workspace-1", strategy: "build"
    })).rejects.toBe(failure);
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it.each([false, true])("revokes the read capability after failed read=%s", async (fail) => {
    let captured: unknown;
    const commit = vi.fn();
    const rollback = vi.fn();
    const work = withActiveRecallReadSnapshot({ beginDeferred: vi.fn(), commit, rollback }, async (capability) => {
      captured = capability;
      expect(isActiveRecallReadCapability(capability)).toBe(true);
      if (fail) throw new Error("read failed");
      return "read";
    });
    if (fail) await expect(work).rejects.toThrow("read failed");
    else await expect(work).resolves.toBe("read");
    expect(isActiveRecallReadCapability(captured)).toBe(false);
    expect(commit).toHaveBeenCalledTimes(fail ? 0 : 1);
    expect(rollback).toHaveBeenCalledTimes(fail ? 1 : 0);
  });

  it("preserves the read failure when rollback also fails", async () => {
    const failure = new Error("read failed");
    await expect(withActiveRecallReadSnapshot({
      beginDeferred: vi.fn(), commit: vi.fn(),
      rollback: () => { throw new Error("rollback failed"); }
    }, async () => { throw failure; })).rejects.toBe(failure);
  });
});

describe("projection reader lifecycle", () => {
  it("requires an explicit production field session", () => {
    const fixture = createDependencies([]).dependencies;
    const {
      testOnlyAllowInMemoryFieldQuerySession: _testOnly,
      fieldQuerySession: _session,
      ...production
    } = fixture;
    expect(() => new RecallService(production)).toThrow(/production field query session/u);
  });

  it("refuses to pin when no generation was activated", () => {
    const session = createTestOnlyInMemoryFieldQuerySession(fieldContractSha256);
    expect(() => session.pinActiveGeneration("workspace-1", CLOCK))
      .toThrow(/active projection generation is missing/u);
  });



  it("binds selection to a live unreleased reader identity", () => {
    const session = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = session.pinActiveGeneration("workspace-1", CLOCK);
    const live = queryCondition(pin, "2026-08-16T00:01:00.000Z");
    expect(session.selectCandidates(live, pin, "2026-08-16T00:01:00.000Z").candidate_keys)
      .toEqual([]);
    session.release(pin, "2026-08-16T00:02:00.000Z");
    expect(() => session.selectCandidates(live, pin, "2026-08-16T00:03:00.000Z"))
      .toThrow(/released/u);

    const expiring = session.pinActiveGeneration("workspace-1", CLOCK);
    const expired = queryCondition(expiring, "2026-08-16T00:05:00.000Z");
    expect(() => session.selectCandidates(expired, expiring, "2026-08-16T00:05:00.000Z"))
      .toThrow(/not live/u);
  });

  it("selects with the original pin handle after renew", () => {
    const session = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = session.pinActiveGeneration("workspace-1", CLOCK);
    const renewed = session.renew(pin, "2026-08-16T00:01:00.000Z");
    expect(renewed.expires_at).not.toBe(pin.expires_at);
    expect(session.selectCandidates(
      queryCondition(pin, "2026-08-16T00:01:00.000Z"),
      pin,
      "2026-08-16T00:01:00.000Z"
    ).candidate_keys).toEqual([]);
  });

  it("treats equivalent ISO spellings as the same lease instant", () => {
    const session = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = session.pinActiveGeneration("workspace-1", "2026-08-16T00:00:00Z");
    expect(session.selectCandidates(
      queryCondition(pin, CLOCK),
      pin,
      CLOCK
    ).candidate_keys).toEqual([]);
  });


  it("keeps the reader live across awaits through an injected heartbeat", () => {
    const session = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = session.pinActiveGeneration("workspace-1", CLOCK);
    let operationalTime = "2026-08-16T00:04:00.000Z";
    const heartbeat: { fn: (() => void) | null } = { fn: null };
    const guard = startProjectionPinLeaseGuard({
      session,
      pin,
      captureOperationalTime: () => operationalTime,
      scheduler: {
        every: (_intervalMs, callback) => {
          heartbeat.fn = callback;
          return () => { heartbeat.fn = null; };
        }
      }
    });
    operationalTime = "2026-08-16T00:06:00.000Z";
    heartbeat.fn?.();
    guard.assertHealthy();
    expect(() => session.renew(pin, operationalTime)).not.toThrow();
    guard.stop();
    expect(heartbeat.fn).toBeNull();
    session.release(pin, operationalTime);
  });

  it("keeps the original pin live past five minutes only with heartbeat", () => {
    const session = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = session.pinActiveGeneration("workspace-1", CLOCK);
    let operationalTime = CLOCK;
    const heartbeat: { fn: (() => void) | null } = { fn: null };
    const guard = startProjectionPinLeaseGuard({
      session,
      pin,
      captureOperationalTime: () => operationalTime,
      scheduler: {
        every: (_intervalMs, callback) => {
          heartbeat.fn = callback;
          return () => { heartbeat.fn = null; };
        }
      }
    });
    operationalTime = "2026-08-16T00:04:00.000Z";
    heartbeat.fn?.();
    operationalTime = "2026-08-16T00:06:00.000Z";
    expect(session.selectCandidates(
      queryCondition(pin, operationalTime),
      pin,
      operationalTime
    ).candidate_keys).toEqual([]);
    guard.assertHealthy();
    guard.stop();

    const expired = session.pinActiveGeneration("workspace-1", CLOCK);
    expect(() => session.selectCandidates(
      queryCondition(expired, "2026-08-16T00:05:00.000Z"),
      expired,
      "2026-08-16T00:05:00.000Z"
    )).toThrow(/not live/u);
  });

  it("surfaces a stored heartbeat renewal failure only through health", () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = delegate.pinActiveGeneration("workspace-1", CLOCK);
    const heartbeat: { fn: (() => void) | null } = { fn: null };
    let renewalFails = false;
    const guard = startProjectionPinLeaseGuard({
      session: {
        ...delegate,
        renew(currentPin, renewedAt) {
          if (renewalFails) throw new Error("planted heartbeat renewal failure");
          return delegate.renew(currentPin, renewedAt);
        }
      },
      pin,
      captureOperationalTime: () => CLOCK,
      scheduler: {
        every: (_intervalMs, callback) => {
          heartbeat.fn = callback;
          return () => {
            heartbeat.fn = null;
          };
        }
      }
    });
    renewalFails = true;
    expect(() => heartbeat.fn?.()).not.toThrow();
    expect(() => guard.assertHealthy()).toThrow(/planted heartbeat renewal failure/u);
    expect(() => guard.stop()).not.toThrow();
    expect(heartbeat.fn).toBeNull();
    delegate.release(pin, CLOCK);
  });

  it("contains heartbeat clock failures until a health checkpoint", () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = delegate.pinActiveGeneration("workspace-1", CLOCK);
    const heartbeat: { fn: (() => void) | null } = { fn: null };
    let operationalTime = CLOCK;
    const guard = startProjectionPinLeaseGuard({
      session: delegate,
      pin,
      captureOperationalTime: () => operationalTime,
      scheduler: {
        every: (_intervalMs, callback) => {
          heartbeat.fn = callback;
          return () => {
            heartbeat.fn = null;
          };
        }
      }
    });
    operationalTime = "not-a-date";
    expect(() => heartbeat.fn?.()).not.toThrow();
    expect(() => guard.assertHealthy()).toThrow(/valid date-time/u);
    guard.stop();
    delegate.release(pin, CLOCK);
  });

  it("does not write a renewal at every healthy stage checkpoint", () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = delegate.pinActiveGeneration("workspace-1", CLOCK);
    const renew = vi.fn(delegate.renew.bind(delegate));
    const guard = startProjectionPinLeaseGuard({
      session: { ...delegate, renew },
      pin,
      captureOperationalTime: () => "2026-08-16T00:01:00.000Z",
      scheduler: { every: () => () => undefined }
    });
    const renewsAtStart = renew.mock.calls.length;
    guard.assertHealthy();
    expect(renew.mock.calls.length).toBe(renewsAtStart);
    guard.stop();
  });

  it("renews at a stage checkpoint when the lease enters its renewal window", () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = delegate.pinActiveGeneration("workspace-1", CLOCK);
    const renew = vi.fn(delegate.renew.bind(delegate));
    let operationalTime = "2026-08-16T00:01:00.000Z";
    const guard = startProjectionPinLeaseGuard({
      session: { ...delegate, renew },
      pin,
      captureOperationalTime: () => operationalTime,
      scheduler: { every: () => () => undefined }
    });
    const renewsAtStart = renew.mock.calls.length;
    operationalTime = "2026-08-16T00:04:00.000Z";
    guard.assertHealthy();
    expect(renew.mock.calls.length).toBe(renewsAtStart + 1);
    guard.stop();
  });


  it("keeps the in-flight heartbeat referenced on the event loop", () => {
    const session = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = session.pinActiveGeneration("workspace-1", CLOCK);
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    try {
      const guard = startProjectionPinLeaseGuard({
        session,
        pin,
        captureOperationalTime: () => CLOCK
      });
      expect(unref).not.toHaveBeenCalled();
      guard.stop();
    } finally {
      spy.mockRestore();
    }
  });





  it("attempts every cleanup step even when warning delivery fails", () => {
    const first = vi.fn(() => {
      throw new Error("first cleanup failure");
    });
    const second = vi.fn(() => {
      throw new Error("second cleanup failure");
    });

    expect(() => finishProjectionPinCleanup([first, second], () => {
      throw new Error("warning delivery failure");
    })).toThrow(/projection pin cleanup failed/u);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });




});

function queryCondition(
  pin: ReturnType<ReturnType<typeof createTestOnlyInMemoryFieldQuerySession>["pinActiveGeneration"]>,
  recordedAt: string
) {
  return captureQueryCondition({
    principal: "workspace-1",
    workspace_id: "workspace-1",
    authorized_scopes: ["workspace-1"],
    explicit_bridges: [],
    workspace_project: "workspace-1",
    effective_as_of: recordedAt,
    query_task_factors: [],
    governance_state: "open",
    activation_budget: 8,
    token_budget: 256
  }, {
    sha256: fieldContractSha256,
    now: () => recordedAt,
    pin
  });
}
