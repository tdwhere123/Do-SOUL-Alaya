import {
  KIND_PROJECTION_DRAFT_PRODUCER_ID,
  KIND_PROJECTION_KIND_VALUE_LIMIT
} from "@do-soul/alaya-protocol";
import { z } from "zod";

export const OFFICIAL_API_KIND_PROJECTION_PRODUCER =
  KIND_PROJECTION_DRAFT_PRODUCER_ID;

const KindProjectionDraftSchema = z.object({
  factor_id: z.string().trim().min(1).max(128),
  kind_values: z.array(z.string().trim().min(1).max(200))
    .min(1)
    .max(KIND_PROJECTION_KIND_VALUE_LIMIT)
}).strict().readonly();

export type OfficialApiKindProjectionDraft = Readonly<{
  readonly factor_id: string;
  readonly kind_values: readonly string[];
}>;

// Independent of the base graph parse so a bad kind cannot drop a valid signal.
export function readOfficialApiKindProjectionDraft(
  value: unknown
): OfficialApiKindProjectionDraft | undefined {
  const parsed = KindProjectionDraftSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const kindValues = uniqueKindValues(parsed.data.kind_values);
  return kindValues.length === 0
    ? undefined
    : Object.freeze({
      factor_id: parsed.data.factor_id,
      kind_values: Object.freeze(kindValues)
    });
}

function uniqueKindValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
    if (unique.length >= KIND_PROJECTION_KIND_VALUE_LIMIT) break;
  }
  return unique;
}
