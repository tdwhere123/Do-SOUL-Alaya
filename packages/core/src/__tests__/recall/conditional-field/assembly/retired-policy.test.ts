import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../../../recall/recall-service.js";
import { createDependencies, createTaskSurface } from "../../recall-service-test-fixtures.js";

describe("conditional-field retired policy admission", () => {
  it.each(["querySemanticFactorFormationCapture", "querySemanticFactorCompletenessReceipt"] as const)("rejects explicit %s before reading a source", async (field) => {
    const source = vi.fn(() => { throw new Error("Retired query override must fail before source reads"); });
    const service = new RecallService({ ...createDependencies().dependencies, observerReaders: { source } });
    await expect(service.recall({ workspaceId: "workspace-1", strategy: "analyze", taskSurface: createTaskSurface(),
      [field]: {} })).rejects.toThrow("are retired for conditional-field requests");
    expect(source).not.toHaveBeenCalled();
  });

  it.each(["scoring_weight_overrides", "domain_weight_overrides"] as const)("rejects explicit %s before reading a source", async (field) => {
    const source = vi.fn(() => { throw new Error("Retired policy must fail before source reads"); });
    const service = new RecallService({ ...createDependencies().dependencies, observerReaders: { source } });
    const taskSurface = createTaskSurface();
    const policy = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
    await expect(service.recall({ workspaceId: "workspace-1", strategy: "analyze", taskSurface,
      policyOverride: { ...policy, [field]: {} } })).rejects.toThrow("are retired for conditional-field requests");
    expect(source).not.toHaveBeenCalled();
  });

  it("rejects scoring overrides that smuggle routing overlay weights before source reads", async () => {
    const source = vi.fn(() => { throw new Error("Retired routing overlay must fail before source reads"); });
    const service = new RecallService({ ...createDependencies().dependencies, observerReaders: { source } });
    const taskSurface = createTaskSurface();
    const policy = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
    await expect(service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface,
      policyOverride: {
        ...policy,
        scoring_weight_overrides: { additive: { PATH_PLASTICITY_WEIGHT: 0.12 } }
      }
    })).rejects.toThrow("are retired for conditional-field requests");
    expect(source).not.toHaveBeenCalled();
  });
});
