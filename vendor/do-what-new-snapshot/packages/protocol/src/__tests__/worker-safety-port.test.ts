import { describe, expect, it } from "vitest";
import { WorkerBaselineLockSchema, type WorkerSafetyPort } from "../worker-safety-port.js";

class StubWorkerSafetyPort implements WorkerSafetyPort {
  public readonly kind = "stub-worker-safety-port";

  public async assembleBaselineLock(workspaceId: string) {
    return WorkerBaselineLockSchema.parse({
      lock_id: "lock-1",
      workspace_id: workspaceId,
      hard_constraint_refs: ["claim-1", "claim-2"],
      denied_tool_categories: ["network", "governance"],
      hazard_object_refs: ["hazard-1"],
      hard_stop_refs: ["hard-stop-1"],
      assembled_at: "2026-04-13T00:00:00.000Z"
    });
  }
}

describe("WorkerBaselineLockSchema", () => {
  it("parses a complete worker baseline lock fixture", () => {
    const fixture = {
      lock_id: "lock-1",
      workspace_id: "workspace-1",
      hard_constraint_refs: ["claim-1", "claim-2"],
      denied_tool_categories: ["network", "governance"],
      hazard_object_refs: ["hazard-1"],
      hard_stop_refs: ["hard-stop-1"],
      assembled_at: "2026-04-13T00:00:00.000Z"
    } as const;

    expect(WorkerBaselineLockSchema.parse(fixture)).toEqual(fixture);
  });

  it("rejects locks that omit hard_constraint_refs", () => {
    const result = WorkerBaselineLockSchema.safeParse({
      lock_id: "lock-1",
      workspace_id: "workspace-1",
      denied_tool_categories: ["network"],
      hazard_object_refs: ["hazard-1"],
      hard_stop_refs: ["hard-stop-1"],
      assembled_at: "2026-04-13T00:00:00.000Z"
    });

    expect(result.success).toBe(false);
  });
});

describe("WorkerSafetyPort", () => {
  it("supports a stub implementation without importing soul or core", async () => {
    const port: WorkerSafetyPort = new StubWorkerSafetyPort();
    const lock = await port.assembleBaselineLock("workspace-1");

    expect(port.kind).toBe("stub-worker-safety-port");
    expect(WorkerBaselineLockSchema.parse(lock)).toEqual(lock);
  });
});
