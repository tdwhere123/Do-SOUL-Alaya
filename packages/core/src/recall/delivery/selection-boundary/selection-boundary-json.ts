import { createHash } from "node:crypto";

const FIDELITY_ERROR = "selection boundary fidelity mismatch";

export function assertSelectionBoundaryJsonValue(
  value: unknown,
  path = "$"
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${FIDELITY_ERROR}: non-finite number at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item === undefined) {
        throw new Error(`${FIDELITY_ERROR}: undefined array value at ${path}[${index}]`);
      }
      assertSelectionBoundaryJsonValue(item, `${path}[${index}]`);
    });
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error(`${FIDELITY_ERROR}: non-JSON value at ${path}`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    assertSelectionBoundaryJsonValue(item, `${path}.${key}`);
  }
}

export function cloneSelectionBoundaryJson<T>(value: T): T {
  assertSelectionBoundaryJsonValue(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function selectionBoundaryJsonSha256(
  value: unknown
): `sha256:${string}` {
  assertSelectionBoundaryJsonValue(value);
  return `sha256:${createHash("sha256")
    .update(canonicalSelectionBoundaryJson(value), "utf8")
    .digest("hex")}`;
}

function canonicalSelectionBoundaryJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSelectionBoundaryJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${canonicalSelectionBoundaryJson(record[key])}`
    );
  return `{${entries.join(",")}}`;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
