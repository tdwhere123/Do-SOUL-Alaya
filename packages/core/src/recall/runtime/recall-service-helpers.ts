import { IsoDatetimeStringSchema, type ManifestationState, type RecallCandidate, type RecallOriginPlane } from "@do-soul/alaya-protocol";

export function buildRecallCandidateDedupeKey(candidate: Readonly<{
  readonly entry: Readonly<{ readonly object_id: string }>;
  readonly originPlane?: RecallOriginPlane;
  readonly objectKind?: RecallCandidate["object_kind"];
}>): string {
  return `${candidate.originPlane ?? "workspace_local"}:${candidate.objectKind ?? "memory_entry"}:${candidate.entry.object_id}`;
}

export function createContentPreview(
  content: string,
  manifestation?: ManifestationState
): string {
  if (manifestation === "full_eligible" || content.length <= 160) return content;
  return `${content.slice(0, 157)}...`;
}

export function normalizeQueryText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function captureEffectiveAsOf(explicit: string | undefined, now: () => string): string {
  const value = explicit === undefined ? now() : explicit;
  const parsed = IsoDatetimeStringSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!/(?:z|[+-]\d{2}:\d{2})$/iu.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("recall reference time must be a valid date-time with a timezone offset");
  }
  return IsoDatetimeStringSchema.parse(new Date(value).toISOString());
}

export type RecallTimeFilter = Readonly<{
  readonly since?: string | null;
  readonly until?: string | null;
  readonly field?: "created_at" | "last_used_at";
}>;
