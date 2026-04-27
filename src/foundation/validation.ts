import { AlayaValidationError } from "../runtime/audit-types.js";

export function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AlayaValidationError(`${label} must be an object.`);
  }
}

export function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AlayaValidationError(`${label} is required.`);
  }
}

export function assertNullableText(value: unknown, label: string): asserts value is string | null {
  if (value !== null) {
    assertText(value, label);
  }
}

export function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new AlayaValidationError(`${label} must be a positive integer.`);
  }
}

export function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw new AlayaValidationError(`${label} must be a non-negative integer.`);
  }
}

export function assertUnitInterval(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new AlayaValidationError(`${label} must be between 0 and 1.`);
  }
}

export function assertNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AlayaValidationError(`${label} must be a finite number.`);
  }
}

export function assertIsoDatetime(value: unknown, label: string): asserts value is string {
  assertText(value, label);
  if (Number.isNaN(Date.parse(value))) {
    throw new AlayaValidationError(`${label} must be an ISO datetime string.`);
  }
}

export function assertOneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string
): asserts value is T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AlayaValidationError(`${label} is not supported.`);
  }
}

export function assertTextArray(value: unknown, label: string, options: { nonEmpty?: boolean } = {}): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new AlayaValidationError(`${label} must be an array.`);
  }
  if (options.nonEmpty === true && value.length === 0) {
    throw new AlayaValidationError(`${label} must not be empty.`);
  }
  value.forEach((entry, index) => assertText(entry, `${label}[${index}]`));
}

export function assertObjectArray(value: unknown, label: string, options: { nonEmpty?: boolean } = {}): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new AlayaValidationError(`${label} must be an array.`);
  }
  if (options.nonEmpty === true && value.length === 0) {
    throw new AlayaValidationError(`${label} must not be empty.`);
  }
  value.forEach((entry, index) => assertObject(entry, `${label}[${index}]`));
}

export function normalizeUnit(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
