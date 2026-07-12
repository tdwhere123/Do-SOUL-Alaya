import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { parseOfficialApiTemporalProjection } from "../temporal/observed-projection.js";
import type { MemoryMaterializationInput } from "./contracts.js";

type MemoryTemporalProjection = Partial<Pick<
  MemoryMaterializationInput,
  | "event_time_start"
  | "event_time_end"
  | "valid_from"
  | "valid_to"
  | "time_precision"
  | "time_source"
  | "projection_schema_version"
>>;

export function readMemoryTemporalProjectionPayload(
  rawPayload: CandidateMemorySignal["raw_payload"]
): MemoryTemporalProjection {
  const value = rawPayload.temporal_projection === undefined
    ? rawPayload.time_concern
    : rawPayload.temporal_projection;
  const projection = parseOfficialApiTemporalProjection(value);
  return projection === null ? {} : projection;
}
