import { StorageError } from "../../shared/errors.js";
import { parseJsonColumn } from "./parse-json-column.js";
import { parseNonEmptyString } from "./validators.js";

export interface RowParser<T> {
  parse(value: unknown): T;
}

export function parseOptionalRow<T>(
  value: unknown,
  parser: RowParser<T>,
  label: string
): T | null {
  if (value === undefined || value === null) {
    return null;
  }

  return parseRow(value, parser, label);
}

export function parseRow<T>(value: unknown, parser: RowParser<T>, label: string): T {
  try {
    return parser.parse(value);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${label}.`, error);
  }
}

export function parseRows<T>(
  values: unknown,
  parser: RowParser<T>,
  label: string
): readonly T[] {
  if (!Array.isArray(values)) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${label}: expected row array.`);
  }

  return values.map((row, index) => parseRow(row, parser, `${label}[${index}]`));
}

export function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${label}: expected object row.`);
  }

  return value as Record<string, unknown>;
}

export function readStringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }
  return value;
}

export function readNonEmptyStringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }

  return parseNonEmptyString(value, field);
}

export function readPositiveIntField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }

  return value;
}

export function readNonNegativeIntField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }

  return value;
}

export function readSqliteBooleanIntField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (value !== 0 && value !== 1) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }

  return value;
}

export function readBufferField(record: Record<string, unknown>, field: string): Buffer {
  const value = record[field];
  if (!Buffer.isBuffer(value)) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }

  return value;
}

export function readNullableStringField(
  record: Record<string, unknown>,
  field: string
): string | null {
  const value = record[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }
  return value;
}

export function readIntegerField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }
  return value;
}

export function readFiniteNumberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }
  return value;
}

export function readJsonColumn(record: Record<string, unknown>, field: string): unknown {
  const value = record[field];
  if (typeof value !== "string") {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }
  return parseJsonColumn(value, field);
}

export function readNullableJsonColumn(record: Record<string, unknown>, field: string): unknown {
  if (record[field] === null) {
    return null;
  }
  return readJsonColumn(record, field);
}

export interface CountRow {
  readonly total: number;
}

export const CountRowParser: RowParser<CountRow> = {
  parse(value: unknown): CountRow {
    const record = readRecord(value, "count row");
    return { total: readNonNegativeIntField(record, "total") };
  }
};
