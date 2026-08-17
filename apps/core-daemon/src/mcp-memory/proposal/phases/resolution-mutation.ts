import type { EventLogEntry } from "@do-soul/alaya-protocol";

type ResolutionEvent = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;
type ResolutionMutation = () => readonly ResolutionEvent[];

export function combineResolutionMutations(
  ...mutations: readonly (ResolutionMutation | undefined)[]
): ResolutionMutation | undefined {
  const present = mutations.filter(
    (mutation): mutation is ResolutionMutation => mutation !== undefined
  );
  if (present.length === 0) return undefined;
  return () => present.flatMap((mutation) => mutation());
}
