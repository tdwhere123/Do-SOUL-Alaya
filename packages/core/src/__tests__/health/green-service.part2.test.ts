import { describe, expect, it } from "vitest";
import { MemoryDimension, RevokeReason, VerificationBasis } from "@do-soul/alaya-protocol";

import { createGreenStatus, createHarness, createMemoryEntry } from "./green-service.test-support.js";

describe("GreenService", () => {
it("hazard grants use a 7-day validity window", async () => {
    const { service } = createHarness({
      memory: createMemoryEntry({ dimension: MemoryDimension.HAZARD })
    });

    const status = await service.grant({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1",
      basis: VerificationBasis.USER_RECONFIRM,
      validUntil: "2026-03-31T00:00:00.000Z",
      verifiedBy: "user"
    });

    expect(status.valid_until).toBe("2026-03-31T00:00:00.000Z");
  });

it("decision grants remain non-expiring to match the protocol contract", async () => {
    const { service } = createHarness({
      memory: createMemoryEntry({ dimension: MemoryDimension.DECISION })
    });

    await expect(
      service.reevaluate({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("unchanged");

    const status = await service.grant({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1",
      basis: VerificationBasis.USER_RECONFIRM,
      validUntil: null,
      verifiedBy: "user"
    });

    expect(status.valid_until).toBeNull();
  });

it("low-signal pierce reasons are suppressed while a governance lease is held", async () => {
    const existingStatus = createGreenStatus({ green_state: "grace" });
    const { service, statuses, events } = createHarness({
      existingStatus,
      leaseHeld: true
    });

    const result = await service.pierce({
      targetObjectId: existingStatus.target_object_id,
      workspaceId: "workspace-1",
      reason: RevokeReason.REVIEW_OVERDUE,
      runId: "run-1"
    });

    expect(result).toEqual(existingStatus);
    expect(statuses.get(existingStatus.target_object_id)?.green_state).toBe("grace");
    expect(events).toHaveLength(0);
  });
});
