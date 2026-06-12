import { describe, expect, it, vi } from "vitest";
import { FileApprovalEventType } from "@do-soul/alaya-protocol";
import { createSoulApprovalService } from "../../services/soul-approval-service.js";

describe("SoulApprovalService", () => {
  it("throws NOT_FOUND when no pending approval exists for the run", async () => {
    const eventLogRepo = createEventLogRepo([]);
    const runtimeNotifier = { notifyEntry: vi.fn() };
    const service = createSoulApprovalService({
      eventLogRepo,
      runLookup: vi.fn(async () => ({
        run_id: "run-1",
        workspace_id: "ws-1"
      })),
      runtimeNotifier,
      now: () => "2026-04-01T00:00:00.000Z"
    });

    await expect(
      service.approve({
        approvalId: "approval-1",
        runId: "run-1",
        causedBy: "user_action"
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Pending approval not found for run"
    });
    expect(eventLogRepo.append).not.toHaveBeenCalled();
    expect(runtimeNotifier.notifyEntry).not.toHaveBeenCalled();
  });

  it("throws CONFLICT when the approval has already been resolved", async () => {
    const eventLogRepo = createEventLogRepo([
      createApprovalRequestedEvent({
        approvalId: "approval-1",
        runId: "run-1"
      }),
      createApprovalResolvedEvent({
        approvalId: "approval-1",
        runId: "run-1",
        result: "approved"
      })
    ]);
    const runtimeNotifier = { notifyEntry: vi.fn() };
    const service = createSoulApprovalService({
      eventLogRepo,
      runLookup: vi.fn(async () => ({
        run_id: "run-1",
        workspace_id: "ws-1"
      })),
      runtimeNotifier,
      now: () => "2026-04-01T00:00:00.000Z"
    });

    await expect(
      service.reject({
        approvalId: "approval-1",
        runId: "run-1",
        causedBy: "user_action"
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Approval has already been resolved"
    });
    expect(eventLogRepo.append).not.toHaveBeenCalled();
    expect(runtimeNotifier.notifyEntry).not.toHaveBeenCalled();
  });

  it("short-circuits after validating the first resolved approval event", async () => {
    const eventLogRepo = createEventLogRepo([
      createApprovalRequestedEvent({
        approvalId: "approval-1",
        runId: "run-1"
      }),
      createApprovalResolvedEvent({
        approvalId: "approval-1",
        runId: "run-1",
        result: "approved"
      }),
      createApprovalResolvedEvent({
        approvalId: "approval-1",
        runId: "run-1",
        result: "approved",
        payload_json: {
          approval_id: "approval-1",
          result: "approved",
          resolved_at: "2026-04-01T02:00:00.000Z",
          run_id: "run-1"
        }
      })
    ]);
    const runtimeNotifier = { notifyEntry: vi.fn() };
    const service = createSoulApprovalService({
      eventLogRepo,
      runLookup: vi.fn(async () => ({
        run_id: "run-1",
        workspace_id: "ws-1"
      })),
      runtimeNotifier,
      now: () => "2026-04-01T01:30:00.000Z"
    });

    await expect(
      service.reject({
        approvalId: "approval-1",
        runId: "run-1",
        causedBy: "user_action"
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Approval has already been resolved"
    });
    expect(eventLogRepo.append).not.toHaveBeenCalled();
    expect(runtimeNotifier.notifyEntry).not.toHaveBeenCalled();
  });

  it("preserves the requested message_id and description when resolving an approval", async () => {
    const eventLogRepo = createEventLogRepo([
      createApprovalRequestedEvent({
        approvalId: "approval-1",
        runId: "run-1",
        messageId: "msg-request-1",
        description: "Review cross-cutting permission merge",
        riskLevel: "high",
        sourceKind: "governance"
      })
    ]);
    const runtimeNotifier = { notifyEntry: vi.fn() };
    const service = createSoulApprovalService({
      eventLogRepo,
      runLookup: vi.fn(async () => ({
        run_id: "run-1",
        workspace_id: "ws-1"
      })),
      runtimeNotifier,
      now: () => "2026-04-01T03:00:00.000Z"
    });

    await expect(
      service.approve({
        approvalId: "approval-1",
        runId: "run-1",
        causedBy: "user_action"
      })
    ).resolves.toEqual({
      approval_id: "approval-1",
      result: "approved",
      resolved_at: "2026-04-01T03:00:00.000Z"
    });

    expect(eventLogRepo.append).toHaveBeenCalledWith({
      event_type: FileApprovalEventType.SOUL_APPROVAL_RESOLVED,
      entity_type: "approval",
      entity_id: "approval-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      caused_by: "user_action",
      payload_json: {
        message_id: "msg-request-1",
        approval_id: "approval-1",
        result: "approved",
        description: "Review cross-cutting permission merge",
        resolved_at: "2026-04-01T03:00:00.000Z",
        risk_level: "high",
        source_kind: "governance",
        run_id: "run-1"
      }
    });
    expect(runtimeNotifier.notifyEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: FileApprovalEventType.SOUL_APPROVAL_RESOLVED,
        entity_id: "approval-1",
        run_id: "run-1"
      })
    );
  });

  it("uses the highest observed revision plus one even when revisions are non-consecutive", async () => {
    const eventLogRepo = createEventLogRepo([
      createApprovalRequestedEvent({
        approvalId: "approval-1",
        runId: "run-1",
        revision: 2
      }),
      createApprovalRequestedEvent({
        approvalId: "approval-1",
        runId: "run-1",
        revision: 7,
        messageId: "msg-request-latest",
        description: "Latest approval request"
      })
    ]);
    const runtimeNotifier = { notifyEntry: vi.fn() };
    const service = createSoulApprovalService({
      eventLogRepo,
      runLookup: vi.fn(async () => ({
        run_id: "run-1",
        workspace_id: "ws-1"
      })),
      runtimeNotifier,
      now: () => "2026-04-01T04:00:00.000Z"
    });

    await expect(
      service.approve({
        approvalId: "approval-1",
        runId: "run-1",
        causedBy: "user_action"
      })
    ).resolves.toEqual({
      approval_id: "approval-1",
      result: "approved",
      resolved_at: "2026-04-01T04:00:00.000Z"
    });

    expect(eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_json: expect.objectContaining({
          message_id: "msg-request-latest",
          description: "Latest approval request"
        })
      })
    );
  });

  it("resolves approvals with large histories without spreading all revisions into Math.max", async () => {
    const eventLogRepo = createEventLogRepo(
      Array.from({ length: 300_000 }, (_, index) =>
        createApprovalRequestedEvent({
          approvalId: "approval-1",
          runId: "run-1",
          revision: index * 2,
          messageId: `msg-request-${index}`,
          description: `Approval request ${index}`
        })
      )
    );
    const runtimeNotifier = { notifyEntry: vi.fn() };
    const service = createSoulApprovalService({
      eventLogRepo,
      runLookup: vi.fn(async () => ({
        run_id: "run-1",
        workspace_id: "ws-1"
      })),
      runtimeNotifier,
      now: () => "2026-04-01T04:30:00.000Z"
    });

    await expect(
      service.approve({
        approvalId: "approval-1",
        runId: "run-1",
        causedBy: "user_action"
      })
    ).resolves.toEqual({
      approval_id: "approval-1",
      result: "approved",
      resolved_at: "2026-04-01T04:30:00.000Z"
    });

    expect(eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_json: expect.objectContaining({
          message_id: "msg-request-299999",
          description: "Approval request 299999"
        })
      })
    );
  });

  it("throws VALIDATION when a resolved approval event payload is malformed", async () => {
    const eventLogRepo = createEventLogRepo([
      createApprovalRequestedEvent({
        approvalId: "approval-1",
        runId: "run-1"
      }),
      createApprovalResolvedEvent({
        approvalId: "approval-1",
        runId: "run-1",
        result: "approved",
        payload_json: {
          approval_id: "approval-1",
          result: "approved",
          description: "Already resolved",
          resolved_at: "2026-04-01T02:00:00.000Z",
          run_id: "run-1"
        }
      })
    ]);
    const runtimeNotifier = { notifyEntry: vi.fn() };
    const service = createSoulApprovalService({
      eventLogRepo,
      runLookup: vi.fn(async () => ({
        run_id: "run-1",
        workspace_id: "ws-1"
      })),
      runtimeNotifier,
      now: () => "2026-04-01T05:00:00.000Z"
    });

    await expect(
      service.reject({
        approvalId: "approval-1",
        runId: "run-1",
        causedBy: "user_action"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Invalid SOUL approval resolved payload"
    });
    expect(eventLogRepo.append).not.toHaveBeenCalled();
    expect(runtimeNotifier.notifyEntry).not.toHaveBeenCalled();
  });
});

function createEventLogRepo(
  entries: readonly Record<string, unknown>[]
): Parameters<typeof createSoulApprovalService>[0]["eventLogRepo"] {
  return {
    queryByRun: vi.fn(async () => entries),
    append: vi.fn(async (entry: Record<string, unknown>) => ({
      event_id: "event-resolved-1",
      created_at: "2026-04-01T03:00:00.000Z",
      ...entry
    }))
  } as unknown as Parameters<typeof createSoulApprovalService>[0]["eventLogRepo"];
}

function createApprovalRequestedEvent(options: {
  readonly approvalId: string;
  readonly runId: string;
  readonly messageId?: string;
  readonly description?: string;
  readonly riskLevel?: "low" | "medium" | "high";
  readonly sourceKind?: string;
  readonly revision?: number;
}) {
  return {
    event_id: `event-requested-${options.approvalId}`,
    event_type: FileApprovalEventType.SOUL_APPROVAL_REQUESTED,
    entity_type: "approval",
    entity_id: options.approvalId,
    workspace_id: "ws-1",
    run_id: options.runId,
    caused_by: "system",
    revision: options.revision ?? 0,
    payload_json: {
      message_id: options.messageId ?? `msg-${options.approvalId}`,
      approval_id: options.approvalId,
      description: options.description ?? "Default approval request",
      risk_level: options.riskLevel,
      source_kind: options.sourceKind,
      run_id: options.runId
    },
    created_at: "2026-04-01T00:00:00.000Z"
  };
}

function createApprovalResolvedEvent(options: {
  readonly approvalId: string;
  readonly runId: string;
  readonly result: "approved" | "rejected";
  readonly revision?: number;
  readonly payload_json?: Record<string, unknown>;
}) {
  return {
    event_id: `event-resolved-${options.approvalId}`,
    event_type: FileApprovalEventType.SOUL_APPROVAL_RESOLVED,
    entity_type: "approval",
    entity_id: options.approvalId,
    workspace_id: "ws-1",
    run_id: options.runId,
    caused_by: "user_action",
    revision: options.revision ?? 0,
    payload_json: options.payload_json ?? {
      message_id: `msg-${options.approvalId}`,
      approval_id: options.approvalId,
      result: options.result,
      description: "Already resolved",
      resolved_at: "2026-04-01T02:00:00.000Z",
      run_id: options.runId
    },
    created_at: "2026-04-01T02:00:00.000Z"
  };
}
