import {
  PROOF_EFFECT_OPERATOR_ID,
  PROOF_EFFECT_OPERATOR_VERSION,
  hashEffectGovernanceFrontier,
  type ClaimForm,
  type ContextDeliveryRecord,
  type EffectRequest,
  type ProofEffectWitness
} from "@do-soul/alaya-protocol";
import {
  ProofCarryingEffectOwner,
  fieldContractSha256,
  type ProofEffectLookup,
  type ProofRecord
} from "@do-soul/alaya-core";

type EffectInput = Readonly<{
  workspaceId: string;
  actorId: string;
  runId: string;
  deliveryId: string;
  targetObjectId: string;
  scope: string;
  effectiveAsOf: string;
  action: "activate" | "revoke" | "correct";
  correction?: string;
}>;

export function createSoulResolveEffectFixture(input: Readonly<{
  claims: ReadonlyMap<string, ClaimForm>;
  deliveries: ReadonlyMap<string, ContextDeliveryRecord>;
}>) {
  return {
    deliveryAuthority: {
      authorize: async (request: Readonly<{
        workspaceId: string;
        actorId: string;
        runId: string | null;
        deliveryId: string;
        targetObjectId: string;
      }>) => {
        const delivery = input.deliveries.get(request.deliveryId);
        return delivery !== undefined &&
          delivery.workspace_id === request.workspaceId &&
          delivery.agent_target === request.actorId &&
          delivery.run_id === request.runId
          ? { deliveredAt: delivery.delivered_at }
          : null;
      }
    },
    effectAuthority: {
      decide: async (request: EffectInput) => {
        const proofKinds = request.action === "correct"
          ? ["actor_authority", "source_grounding", "predecessor", "successor"] as const
          : ["actor_authority", "source_grounding"] as const;
        const proofs = Object.freeze(proofKinds.map((kind) => proof(kind, request)));
        const witnesses = proofs.map((item): ProofEffectWitness => ({
          receipt_id: item.id,
          kind: item.kind,
          authority_event_id: item.kind === "actor_authority" ? "delivery-audit-1" : null,
          source_record_id: item.kind === "source_grounding" ? "source-record-1" : null,
          source_content_digest: item.kind === "source_grounding" ? "digest-1" : null
        }));
        const effectRequest = buildRequest(request, witnesses);
        return new ProofCarryingEffectOwner({
          lookup: new TestProofLookup(input.claims, proofs),
          now: () => request.effectiveAsOf
        }).decide(effectRequest);
      }
    }
  };
}

class TestProofLookup implements ProofEffectLookup {
  public constructor(
    private readonly claims: ReadonlyMap<string, ClaimForm>,
    private readonly proofs: readonly ProofRecord[]
  ) {}

  public findReceipts(workspaceId: string, ids: readonly string[]): readonly ProofRecord[] {
    return this.proofs.filter((proof) =>
      proof.workspace_id === workspaceId && ids.includes(proof.id));
  }

  public isBridgeRevoked(workspaceId: string, scope: string): boolean {
    return workspaceId !== scope;
  }

  public competingClaims(): readonly [] { return []; }
  public isErased(): boolean { return false; }

  public readTargetTime(_workspaceId: string, target: string) {
    const claim = this.claims.get(target);
    const validFrom = claim?.created_at ?? this.proofs.find((proof) =>
      "target" in proof && proof.target === target)?.valid_from;
    return validFrom === undefined || validFrom === null ? null : {
      recorded_at: validFrom,
      event_time: validFrom,
      valid_from: validFrom,
      valid_to: null
    };
  }
}

function buildRequest(input: EffectInput, witnesses: readonly ProofEffectWitness[]): EffectRequest {
  return {
    schema_version: 2,
    workspace_id: input.workspaceId,
    actor_id: input.actorId,
    run_id: input.runId,
    delivery_id: input.deliveryId,
    action: input.action,
    target: input.targetObjectId,
    scope: input.scope,
    effective_as_of: input.effectiveAsOf,
    supporting_receipt_ids: witnesses.map((witness) => witness.receipt_id),
    supporting_proof_witnesses: witnesses,
    governance_frontier: hashEffectGovernanceFrontier(witnesses, fieldContractSha256),
    policy_operator_id: PROOF_EFFECT_OPERATOR_ID,
    policy_operator_version: PROOF_EFFECT_OPERATOR_VERSION
  };
}

function proof(
  kind: "actor_authority" | "source_grounding" | "predecessor" | "successor",
  input: EffectInput
): ProofRecord {
  const common = {
    id: `${kind}:${input.deliveryId}:${input.targetObjectId}`,
    workspace_id: input.workspaceId,
    kind,
    target: input.targetObjectId,
    scope: input.scope,
    recorded_at: input.effectiveAsOf,
    event_time: input.effectiveAsOf,
    valid_from: input.effectiveAsOf,
    valid_to: null
  } as const;
  return kind === "actor_authority"
    ? Object.freeze({
        ...common,
        actor_id: input.actorId,
        run_id: input.runId,
        delivery_id: input.deliveryId
      })
    : Object.freeze(common);
}
