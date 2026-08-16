import { z } from "zod";
import { NonEmptyStringSchema } from "../../shared/schema-primitives.js";

export const FIELD_CONTRACT_DIGEST_PREFIX = "sha256:";
export const FIELD_CONTRACT_HEX_PATTERN = /^[0-9a-f]{64}$/u;
export const FIELD_CONTRACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const FIELD_CONTRACT_SCHEMA_VERSION = "1";
export const FieldContractDigestSchema = z.string().regex(FIELD_CONTRACT_DIGEST_PATTERN);

export type FieldContractSha256 = (preimage: string) => string;
export type FieldOperatorVersionEntry = Readonly<{
  readonly id: string;
  readonly version: string;
}>;

export const FieldReceiptReplayRuleSchema = z.enum(["idempotent_same_identity"]);
export const FieldReceiptFailureDispositionSchema = z.enum(["fail_closed"]);
export const FieldReceiptGovernanceEffectSchema = z.enum([
  "none",
  "audit_only",
  "tombstone",
  "policy_decision"
]);
export const FieldReceiptDeletionBehaviorSchema = z.enum([
  "retain_identity",
  "content_free_tombstone",
  "rebuildable"
]);
export const FieldReceiptContractFieldsSchema = z.object({
  producer: NonEmptyStringSchema.max(128),
  consumer: NonEmptyStringSchema.max(128),
  identity: FieldContractDigestSchema,
  replay_rule: FieldReceiptReplayRuleSchema,
  failure_disposition: FieldReceiptFailureDispositionSchema,
  governance_effect: FieldReceiptGovernanceEffectSchema,
  deletion_behavior: FieldReceiptDeletionBehaviorSchema
});

export type FieldReceiptReplayRule = z.infer<typeof FieldReceiptReplayRuleSchema>;
export type FieldReceiptFailureDisposition = z.infer<typeof FieldReceiptFailureDispositionSchema>;
export type FieldReceiptGovernanceEffect = z.infer<typeof FieldReceiptGovernanceEffectSchema>;
export type FieldReceiptDeletionBehavior = z.infer<typeof FieldReceiptDeletionBehaviorSchema>;
export type FieldReceiptContractFields = z.infer<typeof FieldReceiptContractFieldsSchema>;

export function fieldReceiptContractFields(input: Readonly<{
  readonly identity: string;
  readonly producer: string;
  readonly consumer: string;
  readonly deletion_behavior?: FieldReceiptDeletionBehavior;
}>): FieldReceiptContractFields {
  return {
    producer: input.producer,
    consumer: input.consumer,
    identity: input.identity,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: input.deletion_behavior ?? "retain_identity"
  };
}

export function formatFieldContractDigest(hex: string): string {
  if (!FIELD_CONTRACT_HEX_PATTERN.test(hex)) {
    throw new Error("field contract digest hex is invalid");
  }
  return `${FIELD_CONTRACT_DIGEST_PREFIX}${hex}`;
}

export function isFieldContractDigest(value: string): boolean {
  return FIELD_CONTRACT_DIGEST_PATTERN.test(value);
}

export function hashLabeledIdentity(
  label: string,
  parts: readonly (string | number)[],
  sha256: FieldContractSha256
): string {
  return formatFieldContractDigest(sha256(JSON.stringify([label, ...parts])));
}

export function hashContentDigest(bytes: string, sha256: FieldContractSha256): string {
  return formatFieldContractDigest(sha256(bytes));
}

export function hashSourceRecordId(
  input: Readonly<{
    readonly source_id: string;
    readonly source_version: string;
    readonly content_digest: string;
  }>,
  sha256: FieldContractSha256
): string {
  return hashLabeledIdentity("source_record", [
    input.source_id,
    input.source_version,
    input.content_digest
  ], sha256);
}

export function hashAddressableSourceSpanId(
  input: Readonly<{
    readonly record_id: string;
    readonly start_offset: number;
    readonly end_offset: number;
    readonly purpose: string;
    readonly producer_version: string;
  }>,
  sha256: FieldContractSha256
): string {
  if (input.end_offset <= input.start_offset) {
    throw new Error("addressable source span must be half-open and non-empty");
  }
  return hashLabeledIdentity("source_span", [
    input.record_id,
    input.start_offset,
    input.end_offset,
    input.purpose,
    input.producer_version
  ], sha256);
}

export function hashFactorId(
  input: Readonly<{
    readonly family: string;
    readonly canonical_payload: string;
    readonly operator_id: string;
  }>,
  sha256: FieldContractSha256
): string {
  return hashLabeledIdentity("factor", [
    input.family,
    input.canonical_payload,
    input.operator_id
  ], sha256);
}

export function hashIncidenceId(
  input: Readonly<{
    readonly span_id: string;
    readonly factor_id: string;
    readonly scope: string;
    readonly operator_id: string;
  }>,
  sha256: FieldContractSha256
): string {
  return hashLabeledIdentity("incidence", [
    input.span_id,
    input.factor_id,
    input.scope,
    input.operator_id
  ], sha256);
}

export function hashDerivationJobId(
  input: Readonly<{
    readonly purpose: string;
    readonly operator_id: string;
    readonly input_evidence_ids: readonly string[];
  }>,
  sha256: FieldContractSha256
): string {
  return hashLabeledIdentity("derivation_job", [
    input.purpose,
    input.operator_id,
    ...sortedText(input.input_evidence_ids)
  ], sha256);
}

export function hashOperatorManifestDigest(
  operators: readonly FieldOperatorVersionEntry[],
  sha256: FieldContractSha256
): string {
  return hashLabeledIdentity(
    "operator_manifest",
    operators.flatMap((entry) => [entry.id, entry.version]),
    sha256
  );
}

export function hashGenerationId(
  input: Readonly<{
    readonly operators: readonly FieldOperatorVersionEntry[];
    readonly operator_manifest_digest: string;
    readonly field_schema_version: string;
    readonly input_event_frontier: string;
    readonly governance_frontier: string;
  }>,
  sha256: FieldContractSha256
): string {
  if (input.field_schema_version !== FIELD_CONTRACT_SCHEMA_VERSION) {
    throw new Error("field contract schema version drift");
  }
  const expected = hashOperatorManifestDigest(input.operators, sha256);
  if (input.operator_manifest_digest !== expected) {
    throw new Error("field generation operator manifest digest mismatch");
  }
  return hashLabeledIdentity("generation", [
    input.operator_manifest_digest,
    ...input.operators.flatMap((entry) => [entry.id, entry.version]),
    input.field_schema_version,
    input.input_event_frontier,
    input.governance_frontier
  ], sha256);
}

export function hashBundleId(
  input: Readonly<{
    readonly scope: string;
    readonly anchor_digest: string;
    readonly level: number;
    readonly operator_id: string;
    readonly generation_id: string;
  }>,
  sha256: FieldContractSha256
): string {
  return hashLabeledIdentity("bundle", [
    input.scope,
    input.anchor_digest,
    input.level,
    input.operator_id,
    input.generation_id
  ], sha256);
}

export function hashConditionDigest(
  condition: Readonly<{
    readonly principal: string;
    readonly authorized_scopes: readonly string[];
    readonly explicit_bridges: readonly string[];
    readonly workspace_project: string;
    readonly effective_as_of: string;
    readonly query_task_factors: readonly string[];
    readonly governance_state: string;
    readonly activation_budget: number;
    readonly token_budget: number;
    readonly request_id?: string;
    readonly trace_id?: string;
    readonly span_id?: string;
  }>,
  sha256: FieldContractSha256
): string {
  return hashLabeledIdentity("condition", [
    condition.principal,
    ...condition.authorized_scopes,
    ...condition.explicit_bridges,
    condition.workspace_project,
    condition.effective_as_of,
    ...condition.query_task_factors,
    condition.governance_state,
    condition.activation_budget,
    condition.token_budget
  ], sha256);
}

export function hashQueryCacheKey(
  input: Readonly<{
    readonly generation_id: string;
    readonly condition_digest: string;
    readonly query_operator_id: string;
  }>,
  sha256: FieldContractSha256
): string {
  return hashLabeledIdentity("query_cache", [
    input.generation_id,
    input.condition_digest,
    input.query_operator_id
  ], sha256);
}

export function hashEffectRequestDigest(
  request: Readonly<{
    readonly action: string;
    readonly target: string;
    readonly scope: string;
    readonly effective_as_of: string;
    readonly supporting_receipt_ids: readonly string[];
  }>,
  sha256: FieldContractSha256
): string {
  return hashLabeledIdentity("effect_request", [
    request.action,
    request.target,
    request.scope,
    request.effective_as_of,
    ...sortedText(request.supporting_receipt_ids)
  ], sha256);
}

export function hashCausalUsageId(
  input: Readonly<{
    readonly causal_key: string;
    readonly downstream_ref: string;
    readonly scope: string;
    readonly operator_id: string;
  }>,
  sha256: FieldContractSha256
): string {
  return hashLabeledIdentity("causal_usage", [
    input.causal_key,
    input.downstream_ref,
    input.scope,
    input.operator_id
  ], sha256);
}

export function assertFieldOperatorId(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error("field contract operator id drift");
  }
}

export function assertFieldIdentity(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} identity mismatch`);
  }
}

export function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortedText(values: readonly string[]): readonly string[] {
  return [...values].sort(compareCodeUnits);
}
