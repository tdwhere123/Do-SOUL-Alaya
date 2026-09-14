import { z } from "zod";
import { TimePrecisionSchema, TimeSourceSchema } from "@do-soul/alaya-protocol";
import { normalizeTemporalIsoString } from "../temporal-date.js";

const dateFields = ["event_time_start", "event_time_end", "valid_from", "valid_to"] as const;

/** Canonical generation shape; legacy date strings are normalized before admission. */
export const OfficialApiTemporalProjectionDraftSchema = z.object({
  projection_schema_version: z.literal(1),
  event_time_start: z.iso.datetime().optional().describe("Inclusive event window start; requires event_time_end."),
  event_time_end: z.iso.datetime().optional().describe("Inclusive event window end, including the final millisecond; requires event_time_start."),
  valid_from: z.iso.datetime().optional().describe("Inclusive validity start; may stand alone for open validity."),
  valid_to: z.iso.datetime().optional().describe("Inclusive validity end; requires valid_from and an explicit source end."),
  time_precision: TimePrecisionSchema,
  time_source: TimeSourceSchema
}).refine((dates) => {
  const eventPair = dates.event_time_start !== undefined && dates.event_time_end !== undefined;
  const partialEvent = (dates.event_time_start === undefined) !== (dates.event_time_end === undefined);
  const invalidOpenEnd = dates.valid_from === undefined && dates.valid_to !== undefined;
  return !partialEvent && !invalidOpenEnd && (eventPair || dates.valid_from !== undefined) &&
    isOrdered(dates.event_time_start, dates.event_time_end) && isOrdered(dates.valid_from, dates.valid_to);
});

export type OfficialApiTemporalProjectionDraft = Readonly<z.infer<typeof OfficialApiTemporalProjectionDraftSchema>>;

export function parseOfficialApiTemporalProjection(value: unknown): OfficialApiTemporalProjectionDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const version = record.projection_schema_version ?? record.version;
  const normalized: Record<string, unknown> = {
    projection_schema_version: version === "1" ? 1 : version,
    time_precision: record.time_precision,
    time_source: record.time_source
  };
  for (const field of dateFields) {
    if (record[field] === undefined) continue;
    if (typeof record[field] !== "string") return null;
    const date = normalizeTemporalIsoString(record[field]);
    if (date === null) return null;
    normalized[field] = date;
  }
  const parsed = OfficialApiTemporalProjectionDraftSchema.safeParse(normalized);
  return parsed.success ? Object.freeze(parsed.data) : null;
}

function isOrdered(start: string | undefined, end: string | undefined): boolean {
  return start === undefined || end === undefined || Date.parse(start) <= Date.parse(end);
}
