import { describe, expect, it, vi } from "vitest";

import { RecallService } from "../../../recall/recall-service.js";
import {
  createSeededTestOnlyInMemoryFieldQuerySession,
  createTestOnlyInMemoryFieldQuerySession
} from
  "../../../recall/runtime/query/field-query-session.js";
import { captureQueryCondition } from
  "../../../recall/query/condition/query-condition-capture.js";
import { startProjectionPinLeaseGuard } from
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

  it("keeps the reader live across awaits through an injected heartbeat", () => {
    const session = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const pin = session.pinActiveGeneration("workspace-1", CLOCK);
    let operationalTime = "2026-08-16T00:04:00.000Z";
    let heartbeat: (() => void) | null = null;
    const guard = startProjectionPinLeaseGuard({
      session,
      pin,
      captureOperationalTime: () => operationalTime,
      scheduler: {
        every: (_intervalMs, callback) => {
          heartbeat = callback;
          return () => { heartbeat = null; };
        }
      }
    });
    operationalTime = "2026-08-16T00:06:00.000Z";
    heartbeat?.();
    guard.assertHealthy();
    expect(() => session.renew(pin, operationalTime)).not.toThrow();
    guard.stop();
    expect(heartbeat).toBeNull();
    session.release(pin, operationalTime);
  });

  it("releases the pin when preparation input loading fails", async () => {
    const delegate = createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1");
    const release = vi.fn(delegate.release);
    const dependencies = createDependencies([]).dependencies;
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      now: () => CLOCK,
      slotRepo: {
        findByWorkspace: vi.fn(async () => {
          throw new Error("planted slot load failure");
        })
      },
      fieldQuerySession: { ...delegate, release }
    });

    await expect(runRecall(service)).rejects.toThrow(/planted slot load failure/u);
    expect(release).toHaveBeenCalledTimes(1);
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
