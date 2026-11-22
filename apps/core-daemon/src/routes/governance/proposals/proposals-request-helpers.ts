import { CoreError } from "@do-soul/alaya-core";

const MAX_PENDING_LIST_LIMIT = 500;

export function parsePendingListLimit(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
    throw new CoreError("VALIDATION", `limit must be a positive integer up to ${MAX_PENDING_LIST_LIMIT}`);
  }
  return Math.min(parsed, MAX_PENDING_LIST_LIMIT);
}

export function parseProposalListState(value: string | undefined): "all" | "pending" {
  if (value === undefined || value.trim().length === 0) {
    return "pending";
  }
  const trimmed = value.trim();
  if (trimmed === "all" || trimmed === "pending") {
    return trimmed;
  }
  throw new CoreError("VALIDATION", "Invalid state query parameter");
}

export function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return Number(value.toFixed(6));
}
