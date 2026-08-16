import { describe, expect, it } from "vitest";
import {
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
      supporting_receipt_ids: ["src-1", "pred-1", "succ-1"]
    })).decision).toBe("defer");

    const unknownTime = new ProofCarryingEffectOwner({
      now: () => AS_OF,
      lookup: lookup({
        receipts: [
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
      supporting_receipt_ids: ["src-1", "pred-1", "succ-1"]
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
});

function request(overrides: Partial<EffectRequest> = {}): EffectRequest {
  return {
    workspace_id: "workspace-1",
    action: GovernedEffectAction.REVOKE,
    target: "claim-1",
    scope: "workspace-1",
    effective_as_of: AS_OF,
    supporting_receipt_ids: [],
    ...overrides
  };
}

function proof(id: string, kind: ProofRecord["kind"]): ProofRecord {
  return {
    id,
    kind,
    workspace_id: "workspace-1",
    valid_from: EARLIER,
    valid_to: null,
    event_time: EARLIER,
    recorded_at: AS_OF
  };
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
  };
}): ProofEffectLookup {
  const receipts = input.receipts ?? [];
  return {
    findReceipts: (ids) => receipts.filter((receipt) => ids.includes(receipt.id)),
    isBridgeRevoked: () => input.revoked === true,
    competingClaims: () => input.competing ?? [],
    isErased: () => input.erased === true,
    readTargetTime: () => input.targetTime ?? {
      recorded_at: AS_OF,
      event_time: EARLIER,
      valid_from: EARLIER,
      valid_to: null
    }
  };
}
