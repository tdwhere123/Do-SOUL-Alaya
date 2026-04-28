import { describe, expect, it, vi } from "vitest";
import { PhaseCEventType, type EventLogEntry } from "@do-what/protocol";
import { EventPublisherPropagationError } from "@do-what/core";
import { withSecurityStatusWorkspaceService } from "../security-status-bootstrap.js";

function createPropagationError(): EventPublisherPropagationError {
  const entry: EventLogEntry = {
    event_id: "event-1",
    event_type: PhaseCEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
    entity_type: "workspace",
    entity_id: "workspace-1",
    workspace_id: "workspace-1",
    run_id: null,
    caused_by: "system",
    revision: 0,
    payload_json: {
      workspace_id: "workspace-1",
      posture: "baseline",
      zero_day_active: false,
      active_security_locks: 0,
      reason: "workspace_initialized",
      changed_at: "2026-04-22T00:00:00.000Z"
    },
    created_at: "2026-04-22T00:00:00.000Z"
  };

  return new EventPublisherPropagationError(entry, new Error("broadcast failed"));
}

describe("withSecurityStatusWorkspaceService", () => {
  it("keeps create successful and skips initialization-failed witness on propagation failure", async () => {
    const workspace = {
      workspace_id: "workspace-1",
      name: "workspace",
      root_path: "/tmp/workspace",
      workspace_kind: "local_repo",
      created_at: "2026-04-22T00:00:00.000Z",
      updated_at: "2026-04-22T00:00:00.000Z"
    };
    const initializeWorkspace = vi.fn(async () => {
      throw createPropagationError();
    });
    const recordInitializationFailure = vi.fn(async () => undefined);
    const service = withSecurityStatusWorkspaceService(
      {
        create: vi.fn(async () => workspace)
      } as never,
      {
        initializeWorkspace,
        recordInitializationFailure
      }
    );

    await expect(service.create({} as never)).resolves.toEqual(workspace);
    expect(initializeWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(recordInitializationFailure).not.toHaveBeenCalled();
  });

  it("keeps read paths non-fatal and skips initialization-failed witness on propagation failure", async () => {
    const workspace = {
      workspace_id: "workspace-1",
      name: "workspace",
      root_path: "/tmp/workspace",
      workspace_kind: "local_repo",
      created_at: "2026-04-22T00:00:00.000Z",
      updated_at: "2026-04-22T00:00:00.000Z"
    };
    const initializeWorkspace = vi.fn(async () => {
      throw createPropagationError();
    });
    const recordInitializationFailure = vi.fn(async () => undefined);
    const service = withSecurityStatusWorkspaceService(
      {
        getById: vi.fn(async () => workspace),
        list: vi.fn(async () => [workspace])
      } as never,
      {
        initializeWorkspace,
        recordInitializationFailure
      }
    );

    await expect(service.getById("workspace-1")).resolves.toEqual(workspace);
    await expect(service.list()).resolves.toEqual([workspace]);
    expect(recordInitializationFailure).not.toHaveBeenCalled();
  });
});
