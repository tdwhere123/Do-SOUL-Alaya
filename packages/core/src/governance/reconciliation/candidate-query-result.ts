import type { QueryAvailability } from "@do-soul/alaya-protocol";

export type CandidateQueryResult<T> =
  | { readonly availability: Extract<QueryAvailability, "ok">; readonly items: readonly T[] }
  | {
      readonly availability: Extract<QueryAvailability, "unavailable">;
      readonly error: unknown;
    };

export async function readCandidateQuery<T>(
  fetch: () => Promise<readonly T[]>
): Promise<CandidateQueryResult<T>> {
  try {
    return { availability: "ok", items: await fetch() };
  } catch (error) {
    return { availability: "unavailable", error };
  }
}
