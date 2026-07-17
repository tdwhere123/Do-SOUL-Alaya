import { describe, expect, it, vi } from "vitest";

import { createEdgeProposalMaintenance } from "../../garden/scheduler-edge-proposals.js";
import type { CreateGardenSchedulerRuntimeSupportInput } from "../../garden/scheduler-runtime-types.js";
import {
  createGardenEdgeProposalReconcileDeferralPort,
  deferGardenBootstrapPathReconciliation
} from "../../runtime/garden-legacy-path-admission.js";

describe("Garden legacy path admission fences", () => {
  it("runs the formal edge-proposal scheduler seam without invoking accepted-proposal legacy minting", async () => {
    const legacyReconcileStuckAccepts = vi.fn(async () => ({
      scanned: 1,
      reminted: 1,
      already_present: 0,
      rejected: 0,
      transient_failed: 0
    }));
    const sweepExpired = vi.fn(async () => ({ scanned: 0, expired: 0, skipped: 0 }));
    const warn = vi.fn();
    const legacyEdgeProposalService = {
      reconcileStuckAccepts: legacyReconcileStuckAccepts,
      sweepExpired
    };
    const edgeProposalReconcile = createGardenEdgeProposalReconcileDeferralPort(
      legacyEdgeProposalService,
      warn
    );
    const maintenance = createEdgeProposalMaintenance({
      edgeProposalReconcile,
      workspaceRepo: { list: vi.fn(async () => [{ workspace_id: "workspace-1" }]) },
      warn
    } as unknown as CreateGardenSchedulerRuntimeSupportInput);

    await maintenance.reconcileStuckEdgeProposalAccepts();

    expect(legacyReconcileStuckAccepts).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "garden edge proposal accept-to-mint reconciliation deferred without temporal assertion provenance",
      { workspace_id: "workspace-1", limit: 32 }
    );
  });

  it("keeps expiry sweeping available while accept-to-mint recovery stays deferred", async () => {
    const sweepExpired = vi.fn(async () => ({ scanned: 1, expired: 1, skipped: 0 }));
    const warn = vi.fn();
    const edgeProposalReconcile = createGardenEdgeProposalReconcileDeferralPort(
      { sweepExpired },
      warn
    );
    const maintenance = createEdgeProposalMaintenance({
      edgeProposalReconcile,
      workspaceRepo: { list: vi.fn(async () => [{ workspace_id: "workspace-1" }]) },
      warn
    } as unknown as CreateGardenSchedulerRuntimeSupportInput);

    await maintenance.sweepExpiredEdgeProposals();

    expect(sweepExpired).toHaveBeenCalledWith({ workspaceId: "workspace-1", limit: 64 });
    expect(warn).toHaveBeenCalledWith(
      "edge proposal TTL sweep expired past-TTL pending proposals",
      { workspace_id: "workspace-1", scanned: 1, expired: 1, skipped: 0 }
    );
  });

  it("defers startup bootstrap reconciliation only for active workspaces", async () => {
    const warn = vi.fn();

    await deferGardenBootstrapPathReconciliation(
      {
        list: vi.fn(async () => [
          { workspace_id: "workspace-active", workspace_state: "active" },
          { workspace_id: "workspace-archived", workspace_state: "archived" }
        ])
      },
      warn
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "garden bootstrap path reconciliation deferred without temporal assertion provenance",
      { workspace_id: "workspace-active" }
    );
  });
});
