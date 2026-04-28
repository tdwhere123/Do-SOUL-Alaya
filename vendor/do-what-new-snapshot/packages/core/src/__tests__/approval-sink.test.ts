import { describe, expect, it, vi } from "vitest";
import { ApprovalSink } from "../index.js";

describe("ApprovalSink", () => {
  it("records an ask outcome when the resolver approves the request", async () => {
    const recordOutcome = vi.fn(async () => undefined);
    const approvalSink = new ApprovalSink({
      circuitBreaker: {
        recordOutcome,
        getState: vi.fn()
      },
      approvalResolver: vi.fn(async (): Promise<"approved"> => "approved"),
      runId: "run-1",
      workspaceId: "workspace-1",
      nodeId: "node-1",
      governanceSubjectKey: "subject-a"
    });

    await expect(approvalSink.requestApproval("exec-1", "tools.write_file", "needs approval")).resolves.toBe(
      "approved"
    );
    expect(recordOutcome).toHaveBeenCalledWith("run-1", "workspace-1", "node-1", "subject-a", "ask");
  });

  it("records a deny outcome when the resolver rejects the request", async () => {
    const recordOutcome = vi.fn(async () => undefined);
    const approvalSink = new ApprovalSink({
      circuitBreaker: {
        recordOutcome,
        getState: vi.fn()
      },
      approvalResolver: vi.fn(async (): Promise<"denied"> => "denied"),
      runId: "run-1",
      workspaceId: "workspace-1",
      nodeId: "node-1",
      governanceSubjectKey: "subject-a"
    });

    await expect(approvalSink.requestApproval("exec-1", "tools.write_file", "needs approval")).resolves.toBe(
      "denied"
    );
    expect(recordOutcome).toHaveBeenCalledWith("run-1", "workspace-1", "node-1", "subject-a", "deny");
  });

  it("defaults to deny when no resolver is injected", async () => {
    const recordOutcome = vi.fn(async () => undefined);
    const approvalSink = new ApprovalSink({
      circuitBreaker: {
        recordOutcome,
        getState: vi.fn()
      },
      runId: "run-1",
      workspaceId: "workspace-1",
      nodeId: "node-1",
      governanceSubjectKey: "subject-a"
    });

    await expect(approvalSink.requestApproval("exec-1", "tools.write_file", "needs approval")).resolves.toBe(
      "denied"
    );
    expect(recordOutcome).toHaveBeenCalledWith("run-1", "workspace-1", "node-1", "subject-a", "deny");
  });

  it("returns the approval decision even when breaker outcome recording fails", async () => {
    const recordFailure = new Error("breaker unavailable");
    const approvalSink = new ApprovalSink({
      circuitBreaker: {
        recordOutcome: vi.fn(async () => {
          throw recordFailure;
        }),
        getState: vi.fn()
      },
      approvalResolver: vi.fn(async (): Promise<"approved"> => "approved"),
      runId: "run-1",
      workspaceId: "workspace-1",
      nodeId: "node-1",
      governanceSubjectKey: "subject-a"
    });

    await expect(approvalSink.requestApproval("exec-1", "tools.write_file", "needs approval")).resolves.toBe(
      "approved"
    );
  });
});
