import { describe, expect, it, vi } from "vitest";
import { WorkerBaselineLockSchema } from "@do-what/protocol";
import { SoulWorkerSafetyAdapter } from "../worker-safety-adapter.js";
import { SoulWorkerSafetyReader } from "../worker-safety-reader.js";

describe("SoulWorkerSafetyAdapter", () => {
  it("assembles a validated baseline lock from soul read-only projections", async () => {
    const projectionReader = {
      claimRegistryReader: {
        listClaimsForWorkspace: vi.fn(async () => [])
      },
      hazardProjectionReader: {
        listActiveHazardObjectRefs: vi.fn(async () => ["hazard-1"])
      },
      policyProjectionReader: {
        listGlobalDeniedToolCategories: vi.fn(async () => ["network", "governance"]),
        listWorkspaceHardStopRefs: vi.fn(async () => ["hard-stop-1"])
      }
    };
    const reader = new SoulWorkerSafetyReader(projectionReader);
    vi.spyOn(reader, "listStrictClaimRefs").mockResolvedValue(["claim-1", "claim-2"]);
    const adapter = new SoulWorkerSafetyAdapter({ reader });

    const lock = await adapter.assembleBaselineLock("workspace-1");

    expect(adapter.kind).toBe("soul-worker-safety-adapter");
    expect(adapter.kind.length).toBeGreaterThan(0);
    expect(WorkerBaselineLockSchema.parse(lock)).toEqual(lock);
    expect(lock.workspace_id).toBe("workspace-1");
    expect(lock.hard_constraint_refs).toEqual(["claim-1", "claim-2"]);
    expect(lock.denied_tool_categories).toEqual(["network", "governance"]);
    expect(lock.hazard_object_refs).toEqual(["hazard-1"]);
    expect(lock.hard_stop_refs).toEqual(["hard-stop-1"]);
    expect(lock.lock_id.length).toBeGreaterThan(0);
    expect(reader.listStrictClaimRefs).toHaveBeenCalledWith("workspace-1");
    expect(projectionReader.hazardProjectionReader.listActiveHazardObjectRefs).toHaveBeenCalledWith("workspace-1");
    expect(projectionReader.policyProjectionReader.listGlobalDeniedToolCategories).toHaveBeenCalledWith();
    expect(projectionReader.policyProjectionReader.listWorkspaceHardStopRefs).toHaveBeenCalledWith("workspace-1");
  });

  it("uses the injected clock when assembling the lock", async () => {
    const reader = new SoulWorkerSafetyReader({
      claimRegistryReader: {
        listClaimsForWorkspace: vi.fn(async () => [])
      },
      hazardProjectionReader: {
        listActiveHazardObjectRefs: vi.fn(async () => [])
      },
      policyProjectionReader: {
        listGlobalDeniedToolCategories: vi.fn(async () => []),
        listWorkspaceHardStopRefs: vi.fn(async () => [])
      }
    });
    vi.spyOn(reader, "listStrictClaimRefs").mockResolvedValue([]);
    const adapter = new SoulWorkerSafetyAdapter({
      reader,
      now: () => "2026-04-14T12:00:00.000Z"
    });

    const lock = await adapter.assembleBaselineLock("workspace-1");

    expect(lock.assembled_at).toBe("2026-04-14T12:00:00.000Z");
  });

  it("rethrows reader failures without masking them", async () => {
    const reader = new SoulWorkerSafetyReader({
      claimRegistryReader: {
        listClaimsForWorkspace: vi.fn(async () => [])
      },
      hazardProjectionReader: {
        listActiveHazardObjectRefs: vi.fn(async () => {
          throw new Error("hazard reader unavailable");
        })
      },
      policyProjectionReader: {
        listGlobalDeniedToolCategories: vi.fn(async () => ["network"]),
        listWorkspaceHardStopRefs: vi.fn(async () => ["hard-stop-1"])
      }
    });
    vi.spyOn(reader, "listStrictClaimRefs").mockResolvedValue(["claim-1"]);
    const adapter = new SoulWorkerSafetyAdapter({ reader });

    await expect(adapter.assembleBaselineLock("workspace-1")).rejects.toThrow("hazard reader unavailable");
  });
});
