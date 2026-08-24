import { describe, expect, it, vi } from "vitest";

import { RecallService } from "../../../recall/recall-service.js";
import {
  createSeededTestOnlyInMemoryFieldQuerySession,
  createTestOnlyInMemoryFieldQuerySession
} from
  "../../../recall/runtime/query/field-query-session.js";
import { captureQueryCondition } from
  "../../../recall/query/condition/query-condition-capture.js";
import { executeRecall } from "../../../recall/runtime/recall-service-runner.js";
import { finishProjectionPinCleanup, startProjectionPinLeaseGuard } from
  "../../../recall/runtime/query/projection-pin-lease.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import {
  createDependencies,
  createTaskSurface
} from "../recall-8factor-test-fixtures.js";

const CLOCK = "2026-08-16T00:00:00.000Z";

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

  it("does not mint a generation for a workspace the test never activated", async () => {
    const fixture = createDependencies([]).dependencies;
    const { fieldQuerySession: _seeded, ...unseeded } = fixture;
    const service = new RecallService({
      ...unseeded,
      testOnlyAllowInMemoryFieldQuerySession: true,
      now: () => CLOCK
    });
    await expect(runRecall(service, "workspace-other"))
      .rejects.toThrow(/active projection generation is missing/u);
  });

  it("releases the pin when candidate selection fails", async () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const release = vi.fn(delegate.release);
    const service = createService({
      ...delegate,
      selectCandidates: () => {
        throw new Error("planted selection failure");
      },
      release
    });

    await expect(runRecall(service)).rejects.toThrow(/planted selection failure/u);
    expect(release).toHaveBeenCalledTimes(1);
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

  it("does not use query as-of as the pin lease clock", async () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pinActiveGeneration = vi.fn(delegate.pinActiveGeneration.bind(delegate));
    const service = createService({ ...delegate, pinActiveGeneration });
    await expect(service.recall({
      taskSurface: createTaskSurface("Ada"),
      workspaceId: "workspace-1",
      strategy: "build",
      referenceTime: "2023-03-15T12:00:00.000Z"
    })).resolves.toMatchObject({ candidates: expect.any(Array) });
    expect(pinActiveGeneration).toHaveBeenCalledWith("workspace-1", CLOCK);
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

  it("fails preparation immediately when the initial renewal fails", async () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const selectCandidates = vi.fn(delegate.selectCandidates.bind(delegate));
    const release = vi.fn(delegate.release.bind(delegate));
    const service = createService({
      ...delegate,
      selectCandidates,
      renew: () => {
        throw new Error("planted initial renewal failure");
      },
      release
    });

    await expect(runRecall(service)).rejects.toThrow(/planted initial renewal failure/u);
    expect(selectCandidates).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
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

  it("fails a recall when lease stop throws and still releases the pin", async () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const release = vi.fn(delegate.release.bind(delegate));
    const warn = vi.fn();
    const cancel = vi.fn(() => {
      throw new Error("planted lease stop failure");
    });
    const onEventAppend = vi.fn();
    await expect(runExecuteRecall({ ...delegate, release }, {
      warn,
      projectionPinHeartbeatScheduler: {
        every: () => cancel
      },
      onEventAppend
    })).rejects.toThrow(/projection pin cleanup failed/u);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(onEventAppend).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "projection pin cleanup failed",
      expect.objectContaining({
        operation: "projection_pin_cleanup",
        error: "projection pin heartbeat cancellation failed"
      })
    );
  });

  it("fails a recall when pin release throws", async () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const warn = vi.fn();
    await expect(runExecuteRecall({
      ...delegate,
      release: () => {
        throw new Error("planted pin release failure");
      }
    }, { warn })).rejects.toThrow(/projection pin cleanup failed/u);
    expect(warn).toHaveBeenCalledWith(
      "projection pin cleanup failed",
      expect.objectContaining({
        operation: "projection_pin_cleanup",
        error: "planted pin release failure"
      })
    );
  });

  it("stops renewal when cancellation and release both fail", async () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const renew = vi.fn(delegate.renew.bind(delegate));
    const heartbeat: { fn: (() => void) | null } = { fn: null };
    const onEventAppend = vi.fn();
    await expect(runExecuteRecall({
      ...delegate,
      renew,
      release: () => {
        throw new Error("planted combined release failure");
      }
    }, {
      projectionPinHeartbeatScheduler: {
        every: (_intervalMs, callback) => {
          heartbeat.fn = callback;
          return () => {
            throw new Error("planted combined cancellation failure");
          };
        }
      },
      onEventAppend
    })).rejects.toThrow(/projection pin cleanup failed/u);
    const renewalsAfterFailure = renew.mock.calls.length;
    heartbeat.fn?.();
    expect(renew).toHaveBeenCalledTimes(renewalsAfterFailure);
    expect(onEventAppend).not.toHaveBeenCalled();
  });

  it("does not duplicate a heartbeat failure as cleanup failure", async () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    let renewCount = 0;
    const warn = vi.fn();
    await expect(runExecuteRecall({
      ...delegate,
      renew(pin, renewedAt) {
        renewCount += 1;
        if (renewCount > 1) throw new Error("planted late renewal failure");
        return delegate.renew(pin, renewedAt);
      }
    }, {
      warn,
      projectionPinHeartbeatScheduler: {
        every: (_intervalMs, callback) => {
          callback();
          return () => undefined;
        }
      }
    })).rejects.toThrow(/^planted late renewal failure$/u);
    expect(warn).not.toHaveBeenCalled();
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

  it("releases the pin when preparation input loading fails", async () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const release = vi.fn(delegate.release);
    const warn = vi.fn();
    const dependencies = createDependencies([]).dependencies;
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      now: () => CLOCK,
      warn,
      projectionPinHeartbeatScheduler: {
        every: () => () => {
          throw new Error("planted lease stop failure");
        }
      },
      slotRepo: {
        findByWorkspace: vi.fn(async () => {
          throw new Error("planted slot load failure");
        })
      },
      fieldQuerySession: { ...delegate, release }
    });

    const error = await runRecall(service).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(
      "recall preparation failed: planted slot load failure"
    );
    expect((error as AggregateError).errors.map(String).join(" ")).toMatch(
      /planted slot load failure.*projection pin cleanup failed/u
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "projection pin cleanup failed",
      expect.objectContaining({
        operation: "projection_pin_cleanup",
        error: "projection pin heartbeat cancellation failed"
      })
    );
  });

  it("releases the pin when evidence-bound memory loading fails", async () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const release = vi.fn(delegate.release);
    const dependencies = createDependencies([]).dependencies;
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      now: () => CLOCK,
      memoryRepo: {
        ...dependencies.memoryRepo,
        findByEvidenceRefs: vi.fn(async () => {
          throw new Error("planted evidence memory load failure");
        })
      },
      fieldQuerySession: {
        ...delegate,
        selectCandidates(condition, pin, selectedAt) {
          return Object.freeze({
            ...delegate.selectCandidates(condition, pin, selectedAt),
            candidate_keys: Object.freeze(["evidence-1"])
          });
        },
        release
      }
    });

    await expect(runRecall(service)).rejects.toThrow(/planted evidence memory load failure/u);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

function createService(
  fieldQuerySession: NonNullable<ConstructorParameters<typeof RecallService>[0]["fieldQuerySession"]>
): RecallService {
  return new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
    ...createDependencies([]).dependencies,
    now: () => CLOCK,
    fieldQuerySession
  });
}

async function runRecall(service: RecallService, workspaceId = "workspace-1") {
  return await service.recall({
    taskSurface: createTaskSurface("Ada"),
    workspaceId,
    strategy: "build"
  });
}

async function runExecuteRecall(
  fieldQuerySession: NonNullable<ConstructorParameters<typeof RecallService>[0]["fieldQuerySession"]>,
  extras: Readonly<{
    readonly warn?: ConstructorParameters<typeof RecallService>[0]["warn"];
    readonly projectionPinHeartbeatScheduler?: Parameters<
      typeof startProjectionPinLeaseGuard
    >[0]["scheduler"];
    readonly onEventAppend?: () => void;
  }> = {}
) {
  const { dependencies } = createDependencies([]);
  const runtimeDependencies = {
    ...dependencies,
    eventLogRepo: {
      ...dependencies.eventLogRepo,
      append: async (...args: Parameters<typeof dependencies.eventLogRepo.append>) => {
        extras.onEventAppend?.();
        return await dependencies.eventLogRepo.append(...args);
      }
    }
  };
  const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
    ...runtimeDependencies,
    now: () => CLOCK,
    fieldQuerySession
  });
  return executeRecall({
    dependencies: runtimeDependencies,
    warn: extras.warn ?? (() => undefined),
    now: () => CLOCK,
    buildDefaultPolicy: (strategy, taskSurfaceRef, capturedAt) =>
      service.buildDefaultPolicy(strategy, taskSurfaceRef, capturedAt),
    fieldQuerySession,
    sha256: fieldContractSha256,
    projectionPinHeartbeatScheduler: extras.projectionPinHeartbeatScheduler
  }, {
    taskSurface: createTaskSurface("Ada"),
    workspaceId: "workspace-1",
    strategy: "build"
  });
}

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
