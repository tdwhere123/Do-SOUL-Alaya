import {
  IsoDatetimeStringSchema,
  isSourceGroundingDeferReason,
  sourceGroundingDeferReasons,
  type SourceGroundingDeferEntry,
  type SourceGroundingDeferReason,
  type SourceGroundingDeferStats
} from "@do-soul/alaya-protocol";

const CLAIM_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function projectSourceGroundingDeferEntry(value: unknown): SourceGroundingDeferEntry {
  const entry = requireRecord(value, "entry");
  return {
    signal_id: readDisplayText(entry.signal_id, "signal_id"),
    workspace_id: readDisplayText(entry.workspace_id, "workspace_id"),
    run_id: readDisplayText(entry.run_id, "run_id"),
    defer_reason: readDeferReason(entry.defer_reason),
    enqueued_at: readIsoDatetime(entry.enqueued_at, "enqueued_at"),
    claim_token_fingerprint: readClaimFingerprint(entry.claim_token_fingerprint),
    claim_expires_at: readNullableIsoDatetime(entry.claim_expires_at, "claim_expires_at"),
    admission_state: readEnum(entry.admission_state, ["ready", "capacity_blocked"], "admission_state")
  };
}

export function projectSourceGroundingDeferStats(value: unknown): SourceGroundingDeferStats {
  const stats = requireRecord(value, "stats");
  return {
    queue_depth: readCount(stats.queue_depth, "queue_depth"),
    queue_cap: readCount(stats.queue_cap, "queue_cap"),
    queue_cap_per_workspace: readCount(stats.queue_cap_per_workspace, "queue_cap_per_workspace"),
    queue_hard_limit_per_workspace: readCount(
      stats.queue_hard_limit_per_workspace,
      "queue_hard_limit_per_workspace"
    ),
    queue_scope: readEnum(stats.queue_scope, ["workspace", "aggregate"], "queue_scope"),
    claimable_depth: readCount(stats.claimable_depth, "claimable_depth"),
    capacity_blocked_depth: readCount(stats.capacity_blocked_depth, "capacity_blocked_depth"),
    capacity_state: readEnum(stats.capacity_state, ["ready", "saturated"], "capacity_state"),
    deferred_by_reason: projectReasonCounts(stats.deferred_by_reason)
  };
}

function projectReasonCounts(value: unknown) {
  const input = requireRecord(value, "deferred_by_reason");
  const output: Partial<Record<SourceGroundingDeferReason, number>> = {};
  for (const reason of sourceGroundingDeferReasons) {
    const count = input[reason];
    if (count !== undefined) output[reason] = readCount(count, `reason:${reason}`);
  }
  return output;
}

function readClaimFingerprint(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !CLAIM_FINGERPRINT_PATTERN.test(value)) {
    throw new Error("Invalid source-grounding claim fingerprint.");
  }
  return value;
}

function readNullableIsoDatetime(value: unknown, field: string): string | null {
  return value === null ? null : readIsoDatetime(value, field);
}

function readIsoDatetime(value: unknown, field: string): string {
  const parsed = IsoDatetimeStringSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid source-grounding ${field}.`);
  return parsed.data;
}

function readDisplayText(value: unknown, field: string): string {
  if (
    typeof value !== "string" || value.trim().length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new Error(`Invalid source-grounding ${field}.`);
  }
  return value;
}

function readDeferReason(value: unknown): SourceGroundingDeferReason {
  if (typeof value !== "string" || !isSourceGroundingDeferReason(value)) {
    throw new Error("Invalid source-grounding defer reason.");
  }
  return value;
}

function readCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid source-grounding ${field}.`);
  }
  return value;
}

function readEnum<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  field: string
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    throw new Error(`Invalid source-grounding ${field}.`);
  }
  return value as Value;
}

function requireRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid source-grounding ${field}.`);
  }
  return value as Readonly<Record<string, unknown>>;
}
