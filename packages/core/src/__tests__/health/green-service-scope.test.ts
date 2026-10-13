import { describe, expect, it } from "vitest";
import { RevokeReason, VerificationBasis, VerificationVerdict } from "@do-soul/alaya-protocol";
import { GreenClaimStatusResolver } from "../../health/green-claim-status-resolver.js";
import { createClaimForm } from "../governance/claim-service.test-support.js";
import { createGreenStatus, createHarness, createMemoryEntry } from "./green-service.test-support.js";

describe("Green workspace and identity ownership", () => {
  it("rejects every foreign-workspace transition before mutation or audit", async () => {
    const existing = createGreenStatus();
    const { service, statuses, events } = createHarness({ existingStatus: existing });
    const scoped = { targetObjectId: existing.target_object_id, workspaceId: "foreign-workspace" };
    const operations = [
      () => service.grant({ ...scoped, basis: VerificationBasis.PASSIVE_STABLE, validUntil: null, verifiedBy: "review" }),
      () => service.pierce({ ...scoped, reason: RevokeReason.VERIFICATION_FAIL }),
      () => service.setGrace({ ...scoped, until: "2026-04-01T00:00:00Z" }),
      () => service.reevaluate(scoped),
      () => service.runVerification({ ...scoped, verdict: VerificationVerdict.NO_GO, microCorrectionHint: null, necessaryPatch: null }),
      () => service.getStatus(scoped.targetObjectId, scoped.workspaceId)
    ];
    for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(statuses.get(existing.target_object_id)).toEqual(existing);
    expect(events).toEqual([]);
  });

  it("retains one status identity when grants overlap before entering the transaction", async () => {
    const { service, statuses, events } = createHarness();
    const input = { targetObjectId: createMemoryEntry().object_id, workspaceId: "workspace-1",
      basis: VerificationBasis.PASSIVE_STABLE, validUntil: null, verifiedBy: "review" as const };
    const [first, second] = await Promise.all([service.grant(input), service.grant(input)]);
    expect(first.object_id).toBe(second.object_id);
    expect(statuses.size).toBe(1);
    expect(events).toHaveLength(2);
    expect(events.map(event => event.entity_id)).toEqual([first.object_id, first.object_id]);
  });

  it("does not clear an existing status when contest authority is unavailable", async () => {
    const existing = createGreenStatus();
    const { service, statuses, events } = createHarness({ existingStatus: existing, omitStatusResolver: true });
    await expect(service.reevaluate({ targetObjectId: existing.target_object_id, workspaceId: existing.workspace_id }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(statuses.get(existing.target_object_id)).toEqual(existing);
    expect(events).toEqual([]);
  });

  it("resolves a linked contested claim without confusing foreign or unrelated claims", async () => {
    const target = createMemoryEntry().object_id;
    const claims = [
      createClaimForm({ object_id: "claim-contested", workspace_id: "workspace-1", claim_status: "contested", source_object_refs: [target] }),
      createClaimForm({ object_id: "claim-winner", workspace_id: "workspace-1", claim_status: "winner", source_object_refs: [target] }),
      createClaimForm({ object_id: "foreign-claim", workspace_id: "foreign", claim_status: "contested", source_object_refs: ["unclaimed"] })
    ];
    const resolver = new GreenClaimStatusResolver({ findByWorkspaceId: async () => claims });
    await expect(resolver.getGovernanceRole({ targetObjectId: target, workspaceId: "workspace-1" })).resolves.toBe("contested");
    await expect(resolver.getGovernanceRole({ targetObjectId: "unclaimed", workspaceId: "workspace-1" })).resolves.toBe("standalone");
    const unavailable = new GreenClaimStatusResolver({ findByWorkspaceId: async () => { throw new Error("claim store unavailable"); } });
    await expect(unavailable.getGovernanceRole({ targetObjectId: target, workspaceId: "workspace-1" })).rejects.toThrow("claim store unavailable");
  });
});
