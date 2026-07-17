import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface R3SpendApproval {
  readonly schema_version: 1;
  readonly kind: "longmemeval_r3_spend_approval";
  readonly status: "approved";
  readonly operator: Readonly<{ identity: string; approved_at: string }>;
  readonly r2: Readonly<{
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

export interface VerifiedR3SpendApproval {
  readonly approval: R3SpendApproval;
  readonly approval_digest: string;
}

export interface R3SpendApprovalExpectation {
  readonly matrixAuthorizationSha256: string;
  readonly sourceSelectionSha256: string;
  readonly sourceSelectedCount: number;
  readonly finalCacheIdentitySha256: string;
  readonly targetSelectionSha256: string;
  readonly targetSelectedCount: number;
  readonly startingMissing: number;
  readonly maximumAttempts: number;
  readonly successfulShardCeiling: number;
}

export function readR3SpendApproval(path: string): R3SpendApproval {
  return parseR3SpendApproval(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function parseR3SpendApproval(value: unknown): R3SpendApproval {
  const approval = parseApproval(value);
  assertApprovalShape(approval);
  return approval;
}

export function hashR3SpendApproval(approval: R3SpendApproval): string {
  return hashParsedApproval(parseR3SpendApproval(approval));
}

export function verifyR3SpendApproval(
  approval: R3SpendApproval,
  expected: R3SpendApprovalExpectation
): VerifiedR3SpendApproval {
  const parsed = parseR3SpendApproval(approval);
  assertExpectedScope(expected);
  assertR2MaterialEffect(parsed.r2);
  assertExactBinding(parsed, expected);
  return Object.freeze({
    approval: parsed,
    approval_digest: hashParsedApproval(parsed)
  });
}

function parseApproval(value: unknown): R3SpendApproval {
  const approval = record(value, "R3 spend approval");
  const operator = record(approval.operator, "R3 operator");
  const r2 = record(approval.r2, "R3 R2 evidence");
  const mcnemar = record(r2.mcnemar, "R3 McNemar evidence");
  const target = record(approval.target, "R3 target");
  const spend = record(approval.spend, "R3 spend limits");
  return Object.freeze({
    schema_version: literal(approval.schema_version, 1, "R3 schema_version"),
    kind: literal(approval.kind, "longmemeval_r3_spend_approval", "R3 kind"),
    status: literal(approval.status, "approved", "R3 status"),
    operator: Object.freeze({ identity: stringAt(operator, "identity"), approved_at: stringAt(operator, "approved_at") }),
    r2: Object.freeze({
      matrix_authorization_sha256: stringAt(r2, "matrix_authorization_sha256"),
      source_selection_sha256: stringAt(r2, "source_selection_sha256"),
      source_selected_count: literal(r2.source_selected_count, 100, "R2 source_selected_count"),
      final_cache_identity_sha256: stringAt(r2, "final_cache_identity_sha256"),
      hard_gates_passed: literal(r2.hard_gates_passed, true, "R2 hard_gates_passed"),
      answerable_count: literal(r2.answerable_count, 94, "R2 answerable_count"),
      b_a_net_r5_wins: numberAt(r2, "b_a_net_r5_wins"),
      mcnemar: Object.freeze({
        method: literal(
          mcnemar.method,
          "exact_two_sided",
          "R3 requires exact two-sided McNemar evidence"
        ),
        p_value: numberAt(mcnemar, "p_value")
      })
    }),
    target: Object.freeze({
      selection_sha256: stringAt(target, "selection_sha256"),
      selected_count: literal(target.selected_count, 500, "R3 selected_count"),
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

function assertApprovalShape(approval: R3SpendApproval): void {
  if (approval.operator.identity.trim().length === 0 || !isIsoDate(approval.operator.approved_at)) {
    throw new Error("invalid R3 spend approval operator");
  }
  for (const value of hashesFor(approval)) {
    if (!isSha256(value)) throw new Error("R3 spend approval requires SHA-256 identities");
  }
  if (!isFiniteNonnegative(approval.spend.estimated_cost_usd) ||
      !isNonnegativeInteger(approval.spend.disk_floor_bytes) ||
      !isNonnegativeInteger(approval.spend.starting_missing) ||
      !isNonnegativeInteger(approval.spend.maximum_attempts) ||
      !isNonnegativeInteger(approval.spend.successful_shard_ceiling)) {
    throw new Error("R3 spend approval has invalid cost, disk, or attempt limits");
  }
  if (approval.spend.maximum_attempts !== Math.ceil(approval.spend.starting_missing * 1.1) ||
      approval.spend.successful_shard_ceiling !== approval.spend.starting_missing) {
    throw new Error("R3 spend approval must bind the canonical 110 percent attempt and success caps");
  }
}

function assertExpectedScope(expected: R3SpendApprovalExpectation): void {
  if (expected.sourceSelectedCount !== 100 || expected.targetSelectedCount !== 500 ||
      expected.maximumAttempts !== Math.ceil(expected.startingMissing * 1.1) ||
      expected.successfulShardCeiling !== expected.startingMissing) {
    throw new Error("R3 expectation must bind the canonical 100Q to 500Q expansion limits");
  }
}

function assertR2MaterialEffect(r2: R3SpendApproval["r2"]): void {
  if (r2.hard_gates_passed !== true || r2.answerable_count !== 94) {
    throw new Error("R3 requires all R2 hard gates across exactly 94 answerable questions");
  }
  if (!Number.isSafeInteger(r2.b_a_net_r5_wins) || r2.b_a_net_r5_wins < 5) {
    throw new Error("R3 requires at least five net R@5 wins");
  }
  if (r2.mcnemar.method !== "exact_two_sided") {
    throw new Error("R3 requires exact two-sided McNemar evidence");
  }
  if (!Number.isFinite(r2.mcnemar.p_value) || r2.mcnemar.p_value >= 0.05 || r2.mcnemar.p_value < 0) {
    throw new Error("R3 requires exact two-sided McNemar p < 0.05");
  }
}

function assertExactBinding(approval: R3SpendApproval, expected: R3SpendApprovalExpectation): void {
  const bindings: readonly [actual: string | number, required: string | number, label: string][] = [
    [approval.r2.matrix_authorization_sha256, expected.matrixAuthorizationSha256, "R2 matrix authorization"],
    [approval.r2.source_selection_sha256, expected.sourceSelectionSha256, "R2 source selection"],
    [approval.r2.source_selected_count, expected.sourceSelectedCount, "R2 source count"],
    [approval.r2.final_cache_identity_sha256, expected.finalCacheIdentitySha256, "R2 cache identity"],
    [approval.target.selection_sha256, expected.targetSelectionSha256, "R3 target selection"],
    [approval.target.selected_count, expected.targetSelectedCount, "R3 target count"],
    [approval.target.cache_identity_sha256, expected.finalCacheIdentitySha256, "R3 target cache identity"],
    [approval.spend.starting_missing, expected.startingMissing, "R3 starting missing"],
    [approval.spend.maximum_attempts, expected.maximumAttempts, "R3 maximum attempts"],
    [approval.spend.successful_shard_ceiling, expected.successfulShardCeiling, "R3 successful shard ceiling"]
  ];
  for (const [actual, required, label] of bindings) {
    if (actual !== required) throw new Error(`R3 approval ${label.toLowerCase()} does not match current evidence`);
  }
}

function hashParsedApproval(approval: R3SpendApproval): string {
  return createHash("sha256").update(JSON.stringify({
    schema_version: approval.schema_version,
    kind: approval.kind,
    status: approval.status,
    operator: approval.operator,
    r2: approval.r2,
    target: approval.target,
    spend: approval.spend
  }), "utf8").digest("hex");
}

function hashesFor(approval: R3SpendApproval): readonly string[] {
  return [
    approval.r2.matrix_authorization_sha256, approval.r2.source_selection_sha256,
    approval.r2.final_cache_identity_sha256, approval.target.selection_sha256,
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
  if (typeof value !== "string") throw new Error(`R3 spend approval ${key} must be a string`);
  return value;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`R3 spend approval ${key} must be a number`);
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
