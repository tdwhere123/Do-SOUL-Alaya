import { describe, expect, it } from "vitest";
import {
  PROOF_EFFECT_OPERATOR_ID,
  PROOF_EFFECT_OPERATOR_VERSION,
  hashEffectGovernanceFrontier,
  verifyEffectDecisionReceipt,
  type EffectRequest
} from "@do-soul/alaya-protocol";
import {
  GovernedEffectAction,
  ProofCarryingEffectOwner,
  type CompetingClaim,
  type ProofEffectLookup,
  type ProofRecord
} from "../../governance/effects/proof-effect-policy.js";
import { fieldContractSha256 as defaultFieldSha256 } from "../../shared/field-hash.js";

const AS_OF = "2026-08-16T00:00:00.000Z";
const EARLIER = "2026-08-15T00:00:00.000Z";

describe("ProofCarryingEffectOwner", () => {
  it("denies invalid proof, soft strength, revoked bridges, and restore", () => {
    const soft = new ProofCarryingEffectOwner({
      now: () => AS_OF,
      lookup: lookup({ receipts: [proof("soft-1", "soft_strength")] })
    });
    expect(soft.decide(request({
      action: GovernedEffectAction.REVOKE,
      supporting_receipt_ids: ["missing"]
    })).decision).toBe("deny");
    expect(soft.decide(request({
      action: GovernedEffectAction.REVOKE,
      supporting_receipt_ids: ["soft-1"]
    })).decision).toBe("deny");

    const revoked = new ProofCarryingEffectOwner({
      now: () => AS_OF,
      lookup: lookup({
        receipts: [proof("auth-1", "actor_authority")],
        revoked: true
      })
    });
    expect(revoked.decide(request({
      action: GovernedEffectAction.REVOKE,
      supporting_receipt_ids: ["auth-1"]
    })).decision).toBe("deny");

    const restore = new ProofCarryingEffectOwner({
      now: () => AS_OF,
      lookup: lookup({ receipts: [proof("auth-1", "actor_authority")] })
    });
    expect(restore.decide(request({
      action: GovernedEffectAction.RESTORE,
      supporting_receipt_ids: ["auth-1"]
    })).decision).toBe("deny");
  });

  it("denies hard activation when valid_from is unknown", () => {
    const owner = new ProofCarryingEffectOwner({
      now: () => AS_OF,
      lookup: lookup({
        receipts: [proof("src-1", "source_grounding")],
        targetTime: {
          recorded_at: AS_OF,
          event_time: null,
          valid_from: null,
          valid_to: null
        }
      })
    });
    expect(owner.decide(request({
      action: GovernedEffectAction.ACTIVATE,
      supporting_receipt_ids: ["src-1"]
    })).decision).toBe("deny");
  });

  it("defers overlapping evidenced claims and unknown-time corrections", () => {
    const conflict = new ProofCarryingEffectOwner({
      now: () => AS_OF,
      lookup: lookup({
        receipts: [
          proof("auth-1", "actor_authority"),
          proof("src-1", "source_grounding"),
          proof("pred-1", "predecessor"),
          proof("succ-1", "successor")
        ],
        competing: [
          claim("a", { valid_from: EARLIER, has_evidence: true }),
          claim("b", { valid_from: EARLIER, has_evidence: true })
        ]
      })
    });
    expect(conflict.decide(request({
      action: GovernedEffectAction.SUPERSEDE,
      supporting_receipt_ids: ["auth-1", "src-1", "pred-1", "succ-1"]
    })).decision).toBe("defer");

    const unknownTime = new ProofCarryingEffectOwner({
      now: () => AS_OF,
      lookup: lookup({
        receipts: [
          proof("auth-1", "actor_authority"),
          proof("src-1", "source_grounding"),
          proof("pred-1", "predecessor"),
          proof("succ-1", "successor")
        ],
        targetTime: {
          recorded_at: AS_OF,
          event_time: null,
          valid_from: null,
          valid_to: null
        }
      })
    });
    expect(unknownTime.decide(request({
      action: GovernedEffectAction.CORRECT,
      supporting_receipt_ids: ["auth-1", "src-1", "pred-1", "succ-1"]
    })).decision).toBe("defer");
  });

  it("requires confirmation for erase and seal, then allows with authority", () => {
    const owner = new ProofCarryingEffectOwner({
      now: () => AS_OF,
      lookup: lookup({
        receipts: [
          proof("auth-1", "actor_authority"),
          proof("confirm-1", "confirmation")
        ]
      })
    });
    expect(owner.decide(request({
      action: GovernedEffectAction.ERASE,
      supporting_receipt_ids: ["auth-1"]
    })).decision).toBe("require_confirmation");
    const allowed = owner.decide(request({
      action: GovernedEffectAction.ERASE,
      supporting_receipt_ids: ["auth-1", "confirm-1"]
    }));
    expect(allowed.decision).toBe("allow");
    expect(verifyEffectDecisionReceipt(allowed, defaultFieldSha256).request_digest)
      .toBe(allowed.identity);
  });

  it.each([
    { label: "foreign workspace", overrides: { workspace_id: "workspace-2" } },
    { label: "wrong target", overrides: { target: "claim-2" } },
    { label: "wrong scope", overrides: { scope: "workspace-2" } },
    { label: "revoked", overrides: { revoked: true } },
    { label: "future", overrides: { valid_from: "2026-08-17T00:00:00.000Z" } },
    { label: "future recording", overrides: { recorded_at: "2026-08-17T00:00:00.000Z" } },
    { label: "expired", overrides: { valid_to: EARLIER } }
  ])("denies $label authority proof", ({ overrides }) => {
    const owner = new ProofCarryingEffectOwner({
      now: () => AS_OF,
      lookup: lookup({ receipts: [proof("auth-1", "actor_authority", overrides)] })
    });
    expect(owner.decide(request({
      action: GovernedEffectAction.REVOKE,
      supporting_receipt_ids: ["auth-1"]
    })).decision).toBe("deny");
  });

  it.each([
    { label: "actor", overrides: { actor_id: "actor-2" } },
    { label: "run", overrides: { run_id: "run-2" } },
    { label: "delivery", overrides: { delivery_id: "delivery-2" } }
  ])("denies authority proof bound to another $label", ({ overrides }) => {
    const owner = new ProofCarryingEffectOwner({
      now: () => AS_OF,
      lookup: lookup({
        receipts: [proof("auth-1", "actor_authority", overrides)]
      })
    });
    expect(owner.decide(request({
      action: GovernedEffectAction.REVOKE,
      supporting_receipt_ids: ["auth-1"]
    })).decision).toBe("deny");
  });

  it("scopes every lookup by workspace", () => {
    const calls: string[] = [];
    const owner = new ProofCarryingEffectOwner({
      now: () => AS_OF,
      lookup: {
        findReceipts: (workspaceId) => { calls.push(`receipts:${workspaceId}`); return []; },
        isBridgeRevoked: (workspaceId) => { calls.push(`bridge:${workspaceId}`); return false; },
        competingClaims: (workspaceId) => { calls.push(`claims:${workspaceId}`); return []; },
        isErased: (workspaceId) => { calls.push(`erase:${workspaceId}`); return false; },
        readTargetTime: (workspaceId) => { calls.push(`time:${workspaceId}`); return null; }
      }
    });
    owner.decide(request());
    expect(calls).toEqual([
      "receipts:workspace-1",
      "time:workspace-1",
      "bridge:workspace-1",
      "erase:workspace-1",
      "claims:workspace-1"
    ]);
  });

  it("defers a successor effect when target time is absent", () => {
    const owner = new ProofCarryingEffectOwner({
      now: () => AS_OF,
      lookup: lookup({
        receipts: [
          proof("auth-1", "actor_authority"),
          proof("src-1", "source_grounding"),
          proof("pred-1", "predecessor"),
          proof("succ-1", "successor")
        ],
        targetTime: null
      })
    });
    expect(owner.decide(request({
      action: GovernedEffectAction.CORRECT,
      supporting_receipt_ids: ["auth-1", "src-1", "pred-1", "succ-1"]
    })).decision).toBe("defer");
  });
});

function request(overrides: Partial<EffectRequest> = {}): EffectRequest {
  const witnesses = overrides.supporting_proof_witnesses ?? [];
  return {
    schema_version: 2,
    workspace_id: "workspace-1",
    actor_id: "actor-1",
    run_id: "run-1",
    delivery_id: "delivery-1",
    action: GovernedEffectAction.REVOKE,
    target: "claim-1",
    scope: "workspace-1",
    effective_as_of: AS_OF,
    supporting_receipt_ids: [],
    supporting_proof_witnesses: witnesses,
    governance_frontier: hashEffectGovernanceFrontier(witnesses, defaultFieldSha256),
    policy_operator_id: PROOF_EFFECT_OPERATOR_ID,
    policy_operator_version: PROOF_EFFECT_OPERATOR_VERSION,
    ...overrides
  };
}

function proof(
  id: string,
  kind: ProofRecord["kind"],
  overrides: Partial<ProofRecord> & Partial<{
    actor_id: string;
    run_id: string;
    delivery_id: string;
  }> = {}
): ProofRecord {
  const base = {
    id,
    kind,
    workspace_id: "workspace-1",
    target: "claim-1",
    scope: "workspace-1",
    valid_from: EARLIER,
    valid_to: null,
    event_time: EARLIER,
    recorded_at: AS_OF,
    ...overrides
  };
  return kind === "actor_authority"
    ? {
        ...base,
        kind,
        actor_id: "actor-1",
        run_id: "run-1",
        delivery_id: "delivery-1",
        ...overrides
      } as ProofRecord
    : { ...base, kind } as ProofRecord;
}

function claim(
  id: string,
  overrides: Partial<CompetingClaim> = {}
): CompetingClaim {
  return {
    id,
    recorded_at: AS_OF,
    event_time: EARLIER,
    valid_from: EARLIER,
    valid_to: null,
    has_evidence: false,
    scope_compatible: true,
    ...overrides
  };
}

function lookup(input: {
  readonly receipts?: readonly ProofRecord[];
  readonly competing?: readonly CompetingClaim[];
  readonly revoked?: boolean;
  readonly erased?: boolean;
  readonly targetTime?: {
    readonly recorded_at: string;
    readonly event_time: string | null;
    readonly valid_from: string | null;
    readonly valid_to: string | null;
  } | null;
}): ProofEffectLookup {
  const receipts = input.receipts ?? [];
  return {
    findReceipts: (_workspaceId, ids) => receipts.filter((receipt) => ids.includes(receipt.id)),
    isBridgeRevoked: () => input.revoked === true,
    competingClaims: () => input.competing ?? [],
    isErased: () => input.erased === true,
    readTargetTime: () => input.targetTime === undefined
      ? {
          recorded_at: AS_OF,
          event_time: EARLIER,
          valid_from: EARLIER,
          valid_to: null
        }
      : input.targetTime
  };
}
