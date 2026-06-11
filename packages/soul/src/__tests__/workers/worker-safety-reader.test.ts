import {
  ClaimLifecycleState,
  canonicalGovernanceSubject,
  type ClaimForm,
  type ToolCategory
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { SoulWorkerSafetyReader } from "../../workers/worker-safety-reader.js";

describe("SoulWorkerSafetyReader", () => {
  it("derives strict claim refs from read-only workspace claims and deduplicates read-side outputs", async () => {
    const reader = new SoulWorkerSafetyReader({
      claimRegistryReader: {
        listClaimsForWorkspace: vi.fn(async () => [
          createClaim({ object_id: "claim-1", enforcement_level: "strict" }),
          createClaim({ object_id: "claim-2", enforcement_level: "strict" }),
          createClaim({ object_id: "claim-1", enforcement_level: "strict" }),
          createClaim({ object_id: "claim-ignored", enforcement_level: "preferred" }),
          createClaim({ object_id: "claim-draft", enforcement_level: "strict", claim_status: ClaimLifecycleState.DRAFT })
        ])
      },
      hazardProjectionReader: {
        listActiveHazardObjectRefs: vi.fn(async () => ["hazard-1", "hazard-1", "hazard-2"])
      },
      policyProjectionReader: {
        listGlobalDeniedToolCategories: vi.fn(
          async (): Promise<readonly ToolCategory[]> => ["network", "network", "governance"]
        ),
        listWorkspaceHardStopRefs: vi.fn(async () => ["stop-1", "stop-1", "stop-2"])
      }
    });

    await expect(reader.listStrictClaimRefs("workspace-1")).resolves.toEqual([
      "claim-1",
      "claim-2",
      "claim-draft"
    ]);
    await expect(reader.listActiveHazardObjectRefs("workspace-1")).resolves.toEqual(["hazard-1", "hazard-2"]);
    await expect(reader.listGlobalDeniedCategories()).resolves.toEqual(["network", "governance"]);
    await expect(reader.listHardStopRefs("workspace-1")).resolves.toEqual(["stop-1", "stop-2"]);
  });

  it("keeps contested and winner strict claims because they still contribute to baseline coverage", async () => {
    const reader = new SoulWorkerSafetyReader({
      claimRegistryReader: {
        listClaimsForWorkspace: vi.fn(async () => [
          createClaim({
            object_id: "claim-contested",
            enforcement_level: "strict",
            claim_status: ClaimLifecycleState.CONTESTED
          }),
          createClaim({
            object_id: "claim-winner",
            enforcement_level: "strict",
            claim_status: ClaimLifecycleState.WINNER
          })
        ])
      },
      hazardProjectionReader: {
        listActiveHazardObjectRefs: vi.fn(async () => [])
      },
      policyProjectionReader: {
        listGlobalDeniedToolCategories: vi.fn(async () => []),
        listWorkspaceHardStopRefs: vi.fn(async () => [])
      }
    });

    await expect(reader.listStrictClaimRefs("workspace-1")).resolves.toEqual([
      "claim-contested",
      "claim-winner"
    ]);
  });

  it("fails closed when a read-only projection returns malformed refs", async () => {
    const reader = new SoulWorkerSafetyReader({
      claimRegistryReader: {
        listClaimsForWorkspace: vi.fn(async () => [])
      },
      hazardProjectionReader: {
        listActiveHazardObjectRefs: vi.fn(async () => ["hazard-1", " "])
      },
      policyProjectionReader: {
        listGlobalDeniedToolCategories: vi.fn(
          async (): Promise<readonly ToolCategory[]> => ["network"]
        ),
        listWorkspaceHardStopRefs: vi.fn(async () => ["stop-1"])
      }
    });

    await expect(reader.listActiveHazardObjectRefs("workspace-1")).rejects.toThrow(
      "must not return empty refs"
    );
  });

  it("fails closed with a domain error when a projection returns a non-string ref", async () => {
    const reader = new SoulWorkerSafetyReader({
      claimRegistryReader: {
        listClaimsForWorkspace: vi.fn(async () => [])
      },
      hazardProjectionReader: {
        listActiveHazardObjectRefs: vi.fn(async () => ["hazard-1", 42 as unknown as string])
      },
      policyProjectionReader: {
        listGlobalDeniedToolCategories: vi.fn(
          async (): Promise<readonly ToolCategory[]> => ["network"]
        ),
        listWorkspaceHardStopRefs: vi.fn(async () => ["stop-1"])
      }
    });

    await expect(reader.listActiveHazardObjectRefs("workspace-1")).rejects.toThrow(
      "must return string refs"
    );
  });
});

function createClaim(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: "claim-1",
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-04-12T00:00:00.000Z",
    updated_at: "2026-04-12T00:00:00.000Z",
    created_by: "user_action",
    governance_subject: canonicalGovernanceSubject("tooling.policy", { project: "alpha" }),
    claim_kind: "constraint",
    scope_class: "project",
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Never bypass governance constraints.",
    evidence_refs: [],
    source_object_refs: [],
    workspace_id: "workspace-1",
    claim_status: ClaimLifecycleState.ACTIVE,
    ...overrides
  };
}
