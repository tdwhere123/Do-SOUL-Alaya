import { z } from "zod";
import { CanonicalSelectionReceiptSchema } from
  "../../../../harness/recall/capture/capture-receipt-schema.js";
import { CanonicalCandidateDiagnosticSchema } from
  "../../../../harness/recall/capture/canonical-candidate-diagnostic-schema.js";

const LegacySelectionNotApplicableSchema = z.object({
  fusion: z.literal("not_applicable"),
  deep_head: z.literal("not_applicable"),
  coverage: z.literal("not_applicable")
}).strict().readonly();

const LEGACY_OBSERVATION_FIELDS = Object.freeze([
  "fused_rank", "fused_score", "per_stream_rank",
  "fused_rank_contribution_per_stream", "deep_head_trace",
  "coverage_marginal_gain", "rank_after_coverage_selector",
  "coverage_selector_action", "select_gamma_decision"
]);

export function isCanonicalCandidateRow(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return record.schema_version === 1 && record.ranking_authority === "prefix_sk" &&
    LegacySelectionNotApplicableSchema.safeParse(record.legacy_selection).success &&
    LEGACY_OBSERVATION_FIELDS.every((field) => record[field] === undefined);
}

export function canonicalCandidatePoolComplete(input: Readonly<{
  receipt: unknown;
  rows: readonly unknown[] | undefined;
  candidateKeys: Iterable<string>;
}>): boolean | null {
  const receipt = CanonicalSelectionReceiptSchema.safeParse(input.receipt);
  if (!receipt.success) return null;
  return receipt.data.execution.status === "captured" && input.rows !== undefined &&
    sameKeys(receipt.data.field_membership.e1_keys, input.candidateKeys) &&
    rowsMatchReceipt(input.rows, receipt.data);
}

function rowsMatchReceipt(
  rows: readonly unknown[],
  receipt: z.infer<typeof CanonicalSelectionReceiptSchema>
): boolean {
  if (rows.length !== receipt.field_membership.e1_keys.length) return false;
  const dispositions = new Map(receipt.dispositions.map((row) => [row.candidate_key, row]));
  const delivery = new Map(receipt.delivery.map((row) => [row.candidate_key, row.delivery_rank]));
  return rows.every((value) => {
    const parsed = CanonicalCandidateDiagnosticSchema.safeParse(value);
    if (!parsed.success || parsed.data.capture_receipt_digest !== receipt.receipt_digest) return false;
    const row = parsed.data;
    const disposition = dispositions.get(row.candidate_key);
    const rank = delivery.get(row.candidate_key) ?? null;
    return disposition !== undefined && JSON.stringify(row.capture_disposition) === JSON.stringify(disposition) &&
      row.final_rank === rank && row.post_rank === rank && row.in_final_packet === (rank !== null);
  });
}

function sameKeys(expected: readonly string[], actual: Iterable<string>): boolean {
  const observed = [...actual].sort();
  const required = [...expected].sort();
  return observed.length === required.length &&
    observed.every((value, index) => value === required[index]);
}
