import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import {
  assertAllowedKeys,
  freezeShadow,
  isShadowRecord,
  requireNonemptyString,
  ShadowContractError
} from "../../prefix-capture/envelope.js";

export const MEASUREMENT_GROUP_OPERATOR_ID = "recall_measurement_group_v1" as const;

export const MEASUREMENT_COMBINE_OPERATORS = [
  "identity_dedupe",
  "bound_intersection",
  "exact_agreement",
  "existential_proof",
  "proved_lower_max",
  "exact_state_only"
] as const;

export type MeasurementCombineOperatorV1 =
  (typeof MEASUREMENT_COMBINE_OPERATORS)[number];

export type MeasurementComparisonDirectionV1 =
  | "higher_is_stronger"
  | "lower_is_stronger"
  | "exact";

export type MeasurementCorrelationPolicyV1 =
  | "identity_dedupe"
  | "require_declared"
  | "unknown_blocks";

export type MeasurementUpperBoundRuleV1 = "interval_upper" | "none_declared";

export type MeasurementDomainV1 =
  | "numeric_interval"
  | "four_valued_proposition";

export type MeasurementGroupContractV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof MEASUREMENT_GROUP_OPERATOR_ID;
  readonly contract_id: string;
  readonly operator_version: string;
  readonly proposition_schema: string;
  readonly measurement_domain: MeasurementDomainV1;
  readonly comparison_direction: MeasurementComparisonDirectionV1;
  readonly correlation_policy: MeasurementCorrelationPolicyV1;
  readonly combine_operator: MeasurementCombineOperatorV1;
  readonly soundness_preconditions: readonly string[];
  readonly upper_bound_rule: MeasurementUpperBoundRuleV1;
  readonly digest: RecallFieldDigest;
}>;

export type MeasurementGroupContractInputV1 =
  Omit<MeasurementGroupContractV1, "schema_version" | "operator_id" | "digest">;

export function createMeasurementGroupContractV1(
  input: MeasurementGroupContractInputV1
): MeasurementGroupContractV1 {
  const contract = freezeShadow({
    schema_version: 1 as const,
    operator_id: MEASUREMENT_GROUP_OPERATOR_ID,
    contract_id: requireNonemptyString(input.contract_id, "contract_id"),
    operator_version: requireNonemptyString(input.operator_version, "operator_version"),
    proposition_schema: requireNonemptyString(input.proposition_schema, "proposition_schema"),
    measurement_domain: parseDomain(input.measurement_domain),
    comparison_direction: parseDirection(input.comparison_direction),
    correlation_policy: parseCorrelation(input.correlation_policy),
    combine_operator: parseOperator(input.combine_operator),
    soundness_preconditions: Object.freeze(
      [...input.soundness_preconditions].map((item, index) =>
        requireNonemptyString(item, `soundness_preconditions[${index}]`)
      )
    ),
    upper_bound_rule: parseUpper(input.upper_bound_rule)
  });
  assertSound(contract);
  return freezeShadow({
    ...contract,
    digest: digestRecallFieldIdentity(contract)
  });
}

export function parseMeasurementGroupContractV1(input: unknown): MeasurementGroupContractV1 {
  const record = requireRecord(input);
  assertAllowedKeys(record, [
    "schema_version",
    "operator_id",
    "contract_id",
    "operator_version",
    "proposition_schema",
    "measurement_domain",
    "comparison_direction",
    "correlation_policy",
    "combine_operator",
    "soundness_preconditions",
    "upper_bound_rule",
    "digest"
  ]);
  if (record.schema_version !== 1) {
    throw new ShadowContractError("measurement contract schema mismatch");
  }
  if (record.operator_id !== MEASUREMENT_GROUP_OPERATOR_ID) {
    throw new ShadowContractError("measurement contract operator mismatch");
  }
  if (!Array.isArray(record.soundness_preconditions)) {
    throw new ShadowContractError("soundness_preconditions must be a list");
  }
  const created = createMeasurementGroupContractV1({
    contract_id: String(record.contract_id),
    operator_version: String(record.operator_version),
    proposition_schema: String(record.proposition_schema),
    measurement_domain: record.measurement_domain as MeasurementGroupContractV1["measurement_domain"],
    comparison_direction: record.comparison_direction as MeasurementComparisonDirectionV1,
    correlation_policy: record.correlation_policy as MeasurementCorrelationPolicyV1,
    combine_operator: record.combine_operator as MeasurementCombineOperatorV1,
    soundness_preconditions: record.soundness_preconditions.map((item) => String(item)),
    upper_bound_rule: record.upper_bound_rule as MeasurementUpperBoundRuleV1
  });
  if (record.digest !== created.digest) {
    throw new ShadowContractError("measurement contract digest mismatch");
  }
  return created;
}

function assertSound(contract: Omit<MeasurementGroupContractV1, "digest">): void {
  const propositionState = contract.measurement_domain === "four_valued_proposition";
  if (propositionState !== (contract.combine_operator === "exact_state_only")) {
    throw new ShadowContractError(
      "exact_state_only is reserved for the four-valued proposition domain"
    );
  }
  if (propositionState && (contract.comparison_direction !== "exact" ||
    contract.upper_bound_rule !== "none_declared")) {
    throw new ShadowContractError(
      "four-valued proposition state requires exact direction and no numeric upper rule"
    );
  }
  if (contract.combine_operator === "proved_lower_max" &&
    contract.upper_bound_rule === "none_declared" &&
    contract.comparison_direction === "exact") {
    throw new ShadowContractError("proved_lower_max cannot be an exact comparator without an upper-bound rule");
  }
}

function parseDomain(value: unknown): MeasurementDomainV1 {
  if (value !== "numeric_interval" && value !== "four_valued_proposition") {
    throw new ShadowContractError("unknown v1 measurement domain");
  }
  return value;
}

function parseDirection(value: unknown): MeasurementComparisonDirectionV1 {
  if (value !== "higher_is_stronger" && value !== "lower_is_stronger" && value !== "exact") {
    throw new ShadowContractError("unknown comparison direction");
  }
  return value;
}

function parseCorrelation(value: unknown): MeasurementCorrelationPolicyV1 {
  if (value !== "identity_dedupe" && value !== "require_declared" && value !== "unknown_blocks") {
    throw new ShadowContractError("unknown correlation policy");
  }
  return value;
}

function parseOperator(value: unknown): MeasurementCombineOperatorV1 {
  if (typeof value !== "string" ||
    !MEASUREMENT_COMBINE_OPERATORS.includes(value as MeasurementCombineOperatorV1)) {
    throw new ShadowContractError("unknown combine operator");
  }
  return value as MeasurementCombineOperatorV1;
}

function parseUpper(value: unknown): MeasurementUpperBoundRuleV1 {
  if (value !== "interval_upper" && value !== "none_declared") {
    throw new ShadowContractError("unknown upper-bound rule");
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isShadowRecord(value)) {
    throw new ShadowContractError("measurement contract must be an object");
  }
  return value;
}
