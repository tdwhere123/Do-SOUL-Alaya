import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  LONGMEMEVAL_PREDECESSOR_MATERIAL_EFFECT_POLICY,
  type LongMemEvalMaterialEffect
} from "./schema/material-effect.js";
import { computeExtractionFillAttemptCeiling } from
  "../../../runs/extraction/authority/receipt-limits.js";

const CANONICAL_KIND = "longmemeval_expansion_spend_approval";
/** Historical receipt key; local operator files still use this kind. */
const HISTORICAL_KIND = "longmemeval_r3_spend_approval";

export interface ExpansionSpendApproval {
  readonly schema_version: 1;
  readonly kind: "longmemeval_expansion_spend_approval";
  readonly status: "approved";
  readonly operator: Readonly<{ identity: string; approved_at: string }>;
  readonly predecessor: Readonly<{
    matrix_authorization_sha256: string;
    source_selection_sha256: string;
    source_selected_count: number;
    final_cache_identity_sha256: string;
    hard_gates_passed: boolean;
    answerable_count: number;
    b_a_net_r5_wins: number;
    mcnemar: Readonly<{ method: string; p_value: number }>;
  }>;
  readonly target: Readonly<{
    selection_sha256: string;
    selected_count: number;
    cache_identity_sha256: string;
  }>;
  readonly spend: Readonly<{
    starting_missing: number;
    maximum_attempts: number;
    successful_shard_ceiling: number;
    estimated_cost_usd: number;
    disk_floor_bytes: number;
  }>;
}

export interface VerifiedExpansionSpendApproval {
  readonly approval: ExpansionSpendApproval;
  readonly approval_digest: string;
}

export interface ExpansionSpendApprovalExpectation {
  readonly matrixAuthorizationSha256: string;
  readonly sourceSelectionSha256: string;
  readonly sourceSelectedCount: number;
  readonly finalCacheIdentitySha256: string;
  readonly targetSelectionSha256: string;
  readonly targetSelectedCount: number;
  readonly startingMissing: number;
  readonly maximumAttempts: number;
  readonly successfulShardCeiling: number;
  readonly materialEffect: Pick<LongMemEvalMaterialEffect, "paired_r_at_5">;
}

type PredecessorMaterialEffectEvidence = Readonly<{
  hard_gates_passed: boolean;
  answerable_count: number;
  b_a_net_r5_wins: number;
  mcnemar: Readonly<{ method: string; p_value: number }>;
}>;

export function readExpansionSpendApproval(path: string): ExpansionSpendApproval {
  return parseExpansionSpendApproval(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function parseExpansionSpendApproval(value: unknown): ExpansionSpendApproval {
  const approval = parseApproval(value);
  assertApprovalShape(approval);
  return approval;
}

export function hashExpansionSpendApproval(approval: ExpansionSpendApproval): string {
  return hashParsedApproval(parseExpansionSpendApproval(approval));
}

export function verifyExpansionSpendApproval(
  approval: ExpansionSpendApproval,
  expected: ExpansionSpendApprovalExpectation
): VerifiedExpansionSpendApproval {
  const parsed = parseExpansionSpendApproval(approval);
  assertExpectedScope(expected);
  assertPredecessorMaterialEffect(parsed.predecessor);
  assertExactBinding(parsed, expected);
  return Object.freeze({
    approval: parsed,
    approval_digest: hashParsedApproval(parsed)
  });
}

function parseApproval(value: unknown): ExpansionSpendApproval {
  const approval = record(value, "expansion spend approval");
  const operator = record(approval.operator, "expansion spend approval operator");
  const predecessorSource = approval.predecessor !== undefined
    ? approval.predecessor
    : approval.r2; // historical receipt key on disk
  const predecessor = record(
    predecessorSource,
    "expansion spend approval predecessor evidence"
  );
  const mcnemar = record(predecessor.mcnemar, "expansion spend approval McNemar evidence");
  const target = record(approval.target, "expansion spend approval target");
  const spend = record(approval.spend, "expansion spend approval spend limits");
  return Object.freeze({
    schema_version: literal(approval.schema_version, 1, "expansion spend approval schema_version"),
    kind: parseKind(approval.kind),
    status: literal(approval.status, "approved", "expansion spend approval status"),
    operator: Object.freeze({ identity: stringAt(operator, "identity"), approved_at: stringAt(operator, "approved_at") }),
    predecessor: Object.freeze({
      matrix_authorization_sha256: stringAt(predecessor, "matrix_authorization_sha256"),
      source_selection_sha256: stringAt(predecessor, "source_selection_sha256"),
      source_selected_count: literal(predecessor.source_selected_count, 100, "predecessor source_selected_count"),
      final_cache_identity_sha256: stringAt(predecessor, "final_cache_identity_sha256"),
      hard_gates_passed: literal(predecessor.hard_gates_passed, true, "predecessor hard_gates_passed"),
      answerable_count: literal(
        predecessor.answerable_count,
        LONGMEMEVAL_PREDECESSOR_MATERIAL_EFFECT_POLICY.answerableCount,
        "predecessor answerable_count"
      ),
      b_a_net_r5_wins: numberAt(predecessor, "b_a_net_r5_wins"),
      mcnemar: Object.freeze({
        method: literal(
          mcnemar.method,
          LONGMEMEVAL_PREDECESSOR_MATERIAL_EFFECT_POLICY.mcnemarMethod,
          "expansion spend approval requires exact two-sided McNemar evidence"
        ),
        p_value: numberAt(mcnemar, "p_value")
      })
    }),
    target: Object.freeze({
      selection_sha256: stringAt(target, "selection_sha256"),
      selected_count: literal(target.selected_count, 500, "expansion spend approval selected_count"),
      cache_identity_sha256: stringAt(target, "cache_identity_sha256")
    }),
    spend: Object.freeze({
      starting_missing: numberAt(spend, "starting_missing"),
      maximum_attempts: numberAt(spend, "maximum_attempts"),
      successful_shard_ceiling: numberAt(spend, "successful_shard_ceiling"),
      estimated_cost_usd: numberAt(spend, "estimated_cost_usd"),
      disk_floor_bytes: numberAt(spend, "disk_floor_bytes")
    })
  });
}

function parseKind(value: unknown): "longmemeval_expansion_spend_approval" {
  if (value === HISTORICAL_KIND) return CANONICAL_KIND;
  return literal(value, CANONICAL_KIND, "expansion spend approval kind");
}

function assertApprovalShape(approval: ExpansionSpendApproval): void {
  if (approval.operator.identity.trim().length === 0 || !isIsoDate(approval.operator.approved_at)) {
    throw new Error("invalid expansion spend approval operator");
  }
  for (const value of hashesFor(approval)) {
    if (!isSha256(value)) throw new Error("expansion spend approval requires SHA-256 identities");
  }
  if (!isFiniteNonnegative(approval.spend.estimated_cost_usd) ||
      !isNonnegativeInteger(approval.spend.disk_floor_bytes) ||
      !isNonnegativeInteger(approval.spend.starting_missing) ||
      !isNonnegativeInteger(approval.spend.maximum_attempts) ||
      !isNonnegativeInteger(approval.spend.successful_shard_ceiling)) {
    throw new Error("expansion spend approval has invalid cost, disk, or attempt limits");
  }
  if (approval.spend.maximum_attempts !==
      computeExtractionFillAttemptCeiling(approval.spend.starting_missing) ||
      approval.spend.successful_shard_ceiling !== approval.spend.starting_missing) {
    throw new Error(
      "expansion spend approval must bind the canonical transport attempt and success caps"
    );
  }
}

function assertExpectedScope(expected: ExpansionSpendApprovalExpectation): void {
  if (expected.sourceSelectedCount !== 100 || expected.targetSelectedCount !== 500 ||
      expected.maximumAttempts !== computeExtractionFillAttemptCeiling(expected.startingMissing) ||
      expected.successfulShardCeiling !== expected.startingMissing) {
    throw new Error("expansion spend approval expectation must bind the canonical 100Q to 500Q expansion limits");
  }
  const paired = expected.materialEffect.paired_r_at_5;
  assertPredecessorMaterialEffect({
    hard_gates_passed: true,
    answerable_count: paired.answerable_count,
    b_a_net_r5_wins: paired.net,
    mcnemar: {
      method: paired.mcnemar.method,
      p_value: paired.mcnemar.p_value
    }
  });
}

function assertPredecessorMaterialEffect(predecessor: PredecessorMaterialEffectEvidence): void {
  if (predecessor.hard_gates_passed !== true ||
      predecessor.answerable_count !== LONGMEMEVAL_PREDECESSOR_MATERIAL_EFFECT_POLICY.answerableCount) {
    throw new Error("expansion spend approval requires all predecessor hard gates across exactly 94 answerable questions");
  }
  if (!Number.isSafeInteger(predecessor.b_a_net_r5_wins) ||
      Math.abs(predecessor.b_a_net_r5_wins) >
        LONGMEMEVAL_PREDECESSOR_MATERIAL_EFFECT_POLICY.answerableCount) {
    throw new Error("expansion spend approval requires an integer net R@5 diagnostic");
  }
  if (predecessor.mcnemar.method !== LONGMEMEVAL_PREDECESSOR_MATERIAL_EFFECT_POLICY.mcnemarMethod) {
    throw new Error("expansion spend approval requires exact two-sided McNemar evidence");
  }
  if (!Number.isFinite(predecessor.mcnemar.p_value) ||
      predecessor.mcnemar.p_value > 1 || predecessor.mcnemar.p_value < 0) {
    throw new Error("expansion spend approval requires a bounded exact two-sided McNemar diagnostic");
  }
}

function assertExactBinding(
  approval: ExpansionSpendApproval,
  expected: ExpansionSpendApprovalExpectation
): void {
  const paired = expected.materialEffect.paired_r_at_5;
  const bindings: readonly [actual: string | number, required: string | number, label: string][] = [
    [approval.predecessor.matrix_authorization_sha256, expected.matrixAuthorizationSha256, "predecessor matrix authorization"],
    [approval.predecessor.source_selection_sha256, expected.sourceSelectionSha256, "predecessor source selection"],
    [approval.predecessor.source_selected_count, expected.sourceSelectedCount, "predecessor source count"],
    [approval.predecessor.final_cache_identity_sha256, expected.finalCacheIdentitySha256, "predecessor cache identity"],
    [approval.predecessor.answerable_count, paired.answerable_count, "predecessor material effect answerable count"],
    [approval.predecessor.b_a_net_r5_wins, paired.net, "predecessor material effect net R@5 wins"],
    [approval.predecessor.mcnemar.method, paired.mcnemar.method, "predecessor material effect McNemar method"],
    [approval.predecessor.mcnemar.p_value, paired.mcnemar.p_value, "predecessor material effect McNemar p-value"],
    [approval.target.selection_sha256, expected.targetSelectionSha256, "expansion spend approval target selection"],
    [approval.target.selected_count, expected.targetSelectedCount, "expansion spend approval target count"],
    [approval.target.cache_identity_sha256, expected.finalCacheIdentitySha256, "expansion spend approval target cache identity"],
    [approval.spend.starting_missing, expected.startingMissing, "expansion spend approval starting missing"],
    [approval.spend.maximum_attempts, expected.maximumAttempts, "expansion spend approval maximum attempts"],
    [approval.spend.successful_shard_ceiling, expected.successfulShardCeiling, "expansion spend approval successful shard ceiling"]
  ];
  for (const [actual, required, label] of bindings) {
    if (actual !== required) {
      throw new Error(`expansion spend approval ${label.toLowerCase()} does not match current evidence`);
    }
  }
}

function hashParsedApproval(approval: ExpansionSpendApproval): string {
  return createHash("sha256").update(JSON.stringify({
    schema_version: approval.schema_version,
    kind: approval.kind,
    status: approval.status,
    operator: approval.operator,
    predecessor: approval.predecessor,
    target: approval.target,
    spend: approval.spend
  }), "utf8").digest("hex");
}

function hashesFor(approval: ExpansionSpendApproval): readonly string[] {
  return [
    approval.predecessor.matrix_authorization_sha256, approval.predecessor.source_selection_sha256,
    approval.predecessor.final_cache_identity_sha256, approval.target.selection_sha256,
    approval.target.cache_identity_sha256
  ];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`expansion spend approval ${key} must be a string`);
  return value;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`expansion spend approval ${key} must be a number`);
  return value;
}

function literal<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  label: string
): T {
  if (value !== expected) throw new Error(`${label} is invalid`);
  return expected;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isFiniteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
