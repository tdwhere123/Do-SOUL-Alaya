import {
  classifyFieldValidTime,
  type FieldValidTimeClass
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { ensureIsoDatetime } from "../../shared/time.js";

export type TimeGrounding = "source" | "unknown" | "storage";

export type DualTimeFields = Readonly<{
  readonly recorded_at: string;
  readonly event_time: string | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
}>;

export type CompetingState = DualTimeFields & Readonly<{
  readonly id: string;
  readonly fallback_recorded_at: boolean;
}>;

export function requireRecordedAt(value: string | null | undefined, fieldName = "recorded_at"): string {
  if (value === null || value === undefined || value.trim().length === 0) {
    throw new CoreError("VALIDATION", `${fieldName} is required`);
  }
  return ensureIsoDatetime(value, fieldName);
}

export function groundDualTime(input: Readonly<{
  readonly recorded_at: string;
  readonly event_time: string | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly event_time_source: TimeGrounding;
  readonly valid_time_source: TimeGrounding;
}>): DualTimeFields {
  const recorded_at = requireRecordedAt(input.recorded_at);
  const event_time = sourceOrNull(input.event_time, input.event_time_source, "event_time");
  const valid_from = sourceOrNull(input.valid_from, input.valid_time_source, "valid_from");
  if (input.valid_time_source === "source" && valid_from === null && input.valid_to !== null) {
    throw new CoreError("VALIDATION", "valid_to requires a source-grounded valid_from");
  }
  const valid_to = valid_from === null ? null : parseOptionalTime(input.valid_to, "valid_to");
  if (valid_from !== null && valid_to !== null && valid_to <= valid_from) {
    throw new CoreError("VALIDATION", "valid interval must be half-open");
  }
  return Object.freeze({ recorded_at, event_time, valid_from, valid_to });
}

export function classifyGovernedValidity(
  time: Pick<DualTimeFields, "valid_from" | "valid_to">,
  asOf: string
): FieldValidTimeClass {
  return classifyFieldValidTime({
    valid_from: time.valid_from,
    valid_to: time.valid_to
  }, ensureIsoDatetime(asOf, "asOf"));
}

export function isHardActive(
  time: Pick<DualTimeFields, "valid_from" | "valid_to">,
  asOf: string
): boolean {
  return classifyGovernedValidity(time, asOf) === "hard_active";
}

export function orderCompetingStates(
  states: readonly (DualTimeFields & { readonly id: string })[]
): readonly CompetingState[] {
  return Object.freeze(
    states
      .map((state) => Object.freeze({
        ...state,
        fallback_recorded_at: state.valid_from === null && state.event_time === null
      }))
      .sort(compareCompetingStates)
  );
}

function sourceOrNull(
  value: string | null,
  source: TimeGrounding,
  fieldName: string
): string | null {
  if (source !== "source") return null;
  return parseOptionalTime(value, fieldName);
}

function parseOptionalTime(value: string | null, fieldName: string): string | null {
  if (value === null) return null;
  return ensureIsoDatetime(value, fieldName);
}

function compareCompetingStates(left: CompetingState, right: CompetingState): number {
  return compareOptionalIso(left.valid_from, right.valid_from)
    || compareOptionalIso(left.event_time, right.event_time)
    || left.recorded_at.localeCompare(right.recorded_at)
    || left.id.localeCompare(right.id);
}

function compareOptionalIso(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}
