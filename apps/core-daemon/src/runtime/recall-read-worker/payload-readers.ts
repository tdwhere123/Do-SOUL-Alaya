export function asPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("worker payload must be an object");
  }
  return value as Record<string, unknown>;
}

export function readString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`worker payload ${name} must be a string`);
  }
  return value;
}

export function readNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`worker payload ${name} must be a finite number`);
  }
  return value;
}

export function readStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`worker payload ${name} must be a string array`);
  }
  return value;
}

export function readOptionalKeywordFieldCapture(
  value: unknown
): Readonly<{ readonly variant: "lexical_relaxed" | "lexical_expanded" }> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("worker payload capture must be an object");
  }
  const variant = (value as { readonly variant?: unknown }).variant;
  if (variant !== "lexical_relaxed" && variant !== "lexical_expanded") {
    throw new Error("worker payload capture.variant is invalid");
  }
  return Object.freeze({ variant });
}

export function readPositiveIntegerArray(
  value: unknown,
  name: string
): readonly number[] {
  if (!Array.isArray(value) || value.some((item) =>
    !Number.isSafeInteger(item) || Number(item) <= 0)) {
    throw new Error(`worker payload ${name} must be positive integers`);
  }
  return Object.freeze(value.map(Number));
}
