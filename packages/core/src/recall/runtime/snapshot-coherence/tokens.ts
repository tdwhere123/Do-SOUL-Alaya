import { isSnapshotInstant } from "./digest.js";
import { rejectSnapshotCoherence } from "./types.js";

export function requireSnapshotToken(
  value: string,
  code: Parameters<typeof rejectSnapshotCoherence>[0]
): string {
  if (value.length === 0 || value.trim() !== value) rejectSnapshotCoherence(code);
  return value;
}

export function requireSnapshotInstant(value: string): string {
  const token = requireSnapshotToken(value, "malformed_time");
  if (!isSnapshotInstant(token)) rejectSnapshotCoherence("malformed_time");
  return token;
}
