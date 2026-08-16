import { fieldContractSha256 } from "@do-soul/alaya-core";
import {
  CAUSAL_USAGE_OPERATOR_ID,
  CausalUsageReceiptSchema,
  hashCausalUsageId,
  type CausalUsageKind,
  type CausalUsageReceipt
} from "@do-soul/alaya-protocol";

export const usageIdentitySha256 = fieldContractSha256;

export function hashUsageIdentity(input: Readonly<{
  readonly causal_key: string;
  readonly downstream_ref: string;
  readonly scope: string;
  readonly operator_id?: string;
}>): string {
  return hashCausalUsageId({
    causal_key: input.causal_key,
    downstream_ref: input.downstream_ref,
    scope: input.scope,
    operator_id: input.operator_id ?? CAUSAL_USAGE_OPERATOR_ID
  }, usageIdentitySha256);
}

export function buildCausalUsageReceipt(input: Readonly<{
  readonly workspaceId: string;
  readonly causalKey: string;
  readonly downstreamRef: string;
  readonly occurredAt: string;
  readonly scope: string;
  readonly usageKind: CausalUsageKind;
  readonly weight?: number;
}>): CausalUsageReceipt {
  const operatorId = CAUSAL_USAGE_OPERATOR_ID;
  const weight = input.usageKind === "causal" ? (input.weight ?? 1) : 0;
  return CausalUsageReceiptSchema.parse({
    schema_version: 1,
    producer: operatorId,
    consumer: "path_projection",
    identity: hashUsageIdentity({
      causal_key: input.causalKey,
      downstream_ref: input.downstreamRef,
      scope: input.scope,
      operator_id: operatorId
    }),
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "retain_identity",
    workspace_id: input.workspaceId,
    causal_key: input.causalKey,
    occurred_at: input.occurredAt,
    downstream_ref: input.downstreamRef,
    weight,
    scope: input.scope,
    usage_kind: input.usageKind,
    operator_id: operatorId,
    recorded_at: input.occurredAt
  });
}
