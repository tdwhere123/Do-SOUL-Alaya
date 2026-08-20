import { describe, expect, it } from "vitest";
import { GovernanceResolutionPayloadSchema } from "../../events/governance-resolution.js";

const base = {
  target_object_id: "claim-1",
  resolution: "correct",
  workspace_id: "workspace-1",
  run_id: "run-1",
  agent_target: "agent-1",
  delivery_id: "delivery-1",
  policy: null,
  policy_classification: null,
  reason: null,
  obligation_id: null,
  activated_claim_id: null,
  occurred_at: "2026-08-17T00:00:00.000Z"
} as const;

describe("governance resolution event payload", () => {
  it("retains correction predecessor and successor receipts", () => {
    expect(GovernanceResolutionPayloadSchema.parse({
      ...base,
      correction: "Use the workspace package manager.",
      predecessor_receipt_id: "predecessor-1",
      successor_receipt_id: "successor-1"
    })).toMatchObject({
      correction: "Use the workspace package manager.",
      predecessor_receipt_id: "predecessor-1",
      successor_receipt_id: "successor-1"
    });
  });

  it("keeps the new fields additive for existing event producers", () => {
    expect(GovernanceResolutionPayloadSchema.parse(base)).toMatchObject({
      correction: null,
      predecessor_receipt_id: null,
      successor_receipt_id: null
    });
  });
});
