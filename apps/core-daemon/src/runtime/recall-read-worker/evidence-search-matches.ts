import { EvidenceSearchProjectionKindSchema } from "@do-soul/alaya-protocol";
import type { EvidenceSearchMatch } from "@do-soul/alaya-storage";

export function readEvidenceSearchMatches(
  value: unknown
): readonly EvidenceSearchMatch[] {
  if (!Array.isArray(value)) {
    throw new Error("worker payload matches must be an array");
  }
  return value.map(readEvidenceSearchMatch);
}

function readEvidenceSearchMatch(
  value: unknown,
  index: number
): EvidenceSearchMatch {
  const match = readRecord(value, `matches[${index}]`);
  const objectId = readString(match.object_id, `matches[${index}].object_id`);
  if (match.matched_projection === undefined) {
    return { object_id: objectId };
  }
  return {
    object_id: objectId,
    matched_projection: readProjectionIdentity(match.matched_projection, index)
  };
}

function readProjectionIdentity(
  value: unknown,
  index: number
): NonNullable<EvidenceSearchMatch["matched_projection"]> {
  const name = `matches[${index}].matched_projection`;
  const projection = readRecord(value, name);
  const projectionId = readNumber(projection.projection_id, `${name}.projection_id`);
  if (!Number.isInteger(projectionId) || projectionId <= 0) {
    throw new Error(`worker payload ${name}.projection_id must be a positive integer`);
  }
  const projectionKind = EvidenceSearchProjectionKindSchema.safeParse(
    projection.projection_kind
  );
  if (!projectionKind.success) {
    throw new Error(`worker payload ${name}.projection_kind must be valid`);
  }
  return {
    projection_id: projectionId,
    projection_kind: projectionKind.data
  };
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`worker payload ${name} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`worker payload ${name} must be a string`);
  }
  return value;
}

function readNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`worker payload ${name} must be a finite number`);
  }
  return value;
}
