import { describe, expect, it } from "vitest";
import {
  FieldGenerationEventType,
  ProjectionEraseBarrierSchema,
  type EffectRequest
} from "@do-soul/alaya-protocol";
import {
  EventLogSafeEraseBarrier,
  InMemoryEraseBarrierStore,
  InMemoryEraseSubjectStore,
  InMemoryGovernanceEventLog
} from "../../governance/effects/erase-barrier.js";
import { GovernedEffectLifecycle } from "../../governance/effects/lifecycle-effects.js";
import {
  GovernedEffectAction,
  ProofCarryingEffectOwner,
  type ProofEffectLookup,
  type ProofRecord
} from "../../governance/effects/proof-effect-policy.js";

const AS_OF = "2026-08-16T00:00:00.000Z";
const DIGEST = `sha256:${"b".repeat(64)}`;

describe("GovernedEffectLifecycle", () => {
  it("retains predecessor and successor receipts on allow, and will not roll back erase", () => {
    const subjects = new InMemoryEraseSubjectStore();
    const barriers = new InMemoryEraseBarrierStore();
    const eventLog = new InMemoryGovernanceEventLog(() => AS_OF);
    subjects.seed("workspace-1", "claim-1", "plaintext claim body");
    const erase = new EventLogSafeEraseBarrier({ subjects, barriers, eventLog });
    const lifecycle = new GovernedEffectLifecycle({
      proof: new ProofCarryingEffectOwner({
        now: () => AS_OF,
        lookup: lifecycleLookup()
      }),
      erase,
      eventLog,
      now: () => AS_OF,
      buildEraseBarrier: () => barrier()
    });

    const corrected = lifecycle.apply(request({
      action: GovernedEffectAction.CORRECT,
      supporting_receipt_ids: ["src-1", "pred-1", "succ-1"]
    }));
    expect(corrected.decision.decision).toBe("allow");
    expect(corrected.history.predecessors).toContain("src-1");
    expect(corrected.history.successors.length).toBeGreaterThan(0);

    const erased = lifecycle.apply(request({
      action: GovernedEffectAction.ERASE,
      supporting_receipt_ids: ["auth-1", "confirm-1"]
    }));
    expect(erased.decision.decision).toBe("allow");
    expect(erased.history.erased).toBe(true);
    expect(subjects.getPlaintext("workspace-1", "claim-1")).toBeNull();
    expect(() => erase.restorePlaintext("workspace-1", "claim-1", "plaintext claim body"))
      .toThrow(/irreversible/u);
    expect(eventLog.entries.some((entry) =>
      entry.event_type === FieldGenerationEventType.SOUL_FIELD_EFFECT_DECIDED
    )).toBe(true);
  });
});

function request(overrides: Partial<EffectRequest> = {}): EffectRequest {
  return {
    workspace_id: "workspace-1",
    action: GovernedEffectAction.CORRECT,
    target: "claim-1",
    scope: "workspace-1",
    effective_as_of: AS_OF,
    supporting_receipt_ids: ["src-1", "pred-1", "succ-1"],
    ...overrides
  };
}

function lifecycleLookup(): ProofEffectLookup {
  const receipts: ProofRecord[] = [
    proof("src-1", "source_grounding"),
    proof("pred-1", "predecessor"),
    proof("succ-1", "successor"),
    proof("auth-1", "actor_authority"),
    proof("confirm-1", "confirmation")
  ];
  return {
    findReceipts: (ids) => receipts.filter((receipt) => ids.includes(receipt.id)),
    isBridgeRevoked: () => false,
    competingClaims: () => [],
    isErased: () => false,
    readTargetTime: () => ({
      recorded_at: AS_OF,
      event_time: AS_OF,
      valid_from: "2026-08-15T00:00:00.000Z",
      valid_to: null
    })
  };
}

function proof(id: string, kind: ProofRecord["kind"]): ProofRecord {
  return {
    id,
    kind,
    workspace_id: "workspace-1",
    valid_from: "2026-08-15T00:00:00.000Z",
    valid_to: null,
    event_time: AS_OF,
    recorded_at: AS_OF
  };
}

function barrier() {
  return ProjectionEraseBarrierSchema.parse({
    schema_version: 1,
    producer: "erase_barrier",
    consumer: "projection_generation",
    identity: DIGEST,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "tombstone",
    deletion_behavior: "content_free_tombstone",
    workspace_id: "workspace-1",
    barrier_id: "barrier-claim-1",
    generation_id: null,
    subject_kind: "source_record",
    subject_id: "claim-1",
    erased_at: AS_OF
  });
}
