import type { CandidateMemorySignal } from "../signals/candidate-memory-signal.js";

export type SchemaGroundingValidationStatus = "valid" | "deferred" | "invalid";
export interface SchemaGroundingValidationResult {
  readonly declared: boolean;
  readonly status: SchemaGroundingValidationStatus;
  readonly reasons: readonly string[];
  readonly field_count: number;
}

/** Validate the entire declared grounding before any producer normalization. */
export function validateSchemaGroundingForSignal(
  signal: Readonly<{
    raw_payload: Readonly<Record<string, unknown>>;
    object_kind: string | null;
    interpretation_contract?: CandidateMemorySignal["interpretation_contract"];
  }>
): SchemaGroundingValidationResult {
  if (signal.interpretation_contract !== undefined) {
    return { declared: true, status: "invalid", reasons: ["source interpretation requires its own admission"], field_count: 0 };
  }
  const raw = signal.raw_payload;
  const declared = [raw.schema_grounding, raw.detected_object, raw.field_candidates, raw.validation_result]
    .some(value => value !== undefined);
  if (!declared) return { declared: false, status: "valid", reasons: [], field_count: 0 };
  const reasons: string[] = [];
  const detected = record(raw.detected_object);
  const kind = nonempty(detected?.object_kind);
  if (kind === null) reasons.push("detected_object.object_kind missing");
  else if (kind !== signal.object_kind) reasons.push("detected_object.object_kind does not match signal.object_kind");
  const fields: readonly unknown[] = Array.isArray(raw.field_candidates) ? raw.field_candidates : [];
  if (fields.length === 0) reasons.push("field_candidates missing");
  for (const [index, value] of fields.entries()) {
    const field = record(value);
    for (const key of ["field_name", "value", "evidence"] as const) {
      if (nonempty(field?.[key]) === null) reasons.push(`field_candidates[${index}].${key} missing`);
    }
  }
  const status = nonempty(record(raw.validation_result)?.status);
  if (status !== "valid") reasons.push(`validation_result.status is ${status ?? "missing"}`);
  return Object.freeze({ declared: true, status: reasons.length === 0 ? "valid" : "deferred",
    reasons: Object.freeze(reasons), field_count: fields.length });
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
