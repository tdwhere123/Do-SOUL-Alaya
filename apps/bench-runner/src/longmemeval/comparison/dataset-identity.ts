import type { LongMemEvalVariant } from "../dataset.js";

export function parseLongMemEvalVariant(name: string): LongMemEvalVariant {
  if (name === "longmemeval_oracle" || name === "longmemeval_s" || name === "longmemeval_m") {
    return name;
  }
  throw new Error(`unsupported LongMemEval dataset name '${name}'`);
}

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}
