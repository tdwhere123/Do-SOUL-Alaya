import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type CompletenessReport,
  type CompletenessStatus,
  type Continuation,
  type CoverageRegion,
  type ObserverOutcome,
  type QueryInterpretationStatus,
  type RequestBudget
} from "@do-soul/alaya-protocol";

export type ObserverCoverage = Readonly<{
  readonly outcome: ObserverOutcome;
  readonly open_regions?: readonly CoverageRegion[];
}>;

export type CompletenessInput = Readonly<{
  readonly observer?: ObserverCoverage;
  readonly interpretation_status?: QueryInterpretationStatus;
  readonly total: number;
  readonly remaining: number;
  readonly omitted_payload: boolean;
  readonly expand_payload: boolean;
  readonly mixed_generation?: boolean;
  readonly explanation_work?: "complete" | "open";
  readonly resource_work?: "complete" | "open";
}>;

const INCOMPLETE_OBSERVER_STATUSES = [
  "cancelled",
  "unknown",
  "not_applicable",
  "invalidated"
] as const;

type IncompleteObserverStatus = (typeof INCOMPLETE_OBSERVER_STATUSES)[number];

export function admitIndexBudget(budget: RequestBudget): "admit" | "resource_rejected" {
  // page_budget is later transport width; it is not an envelope comparison.
  if (budget.finalization_reserve > budget.work_units) return "resource_rejected";
  const exploration = budget.work_units - budget.finalization_reserve;
  if (budget.min_envelope > exploration) return "resource_rejected";
  if (budget.min_envelope > budget.memory_bytes) return "resource_rejected";
  return "admit";
}

export function resourceRejectedCompleteness(): CompletenessReport {
  return uniformCompleteness("resource_rejected");
}

export function invalidatedCompleteness(): CompletenessReport {
  return uniformCompleteness("invalidated");
}

export function completenessForInterpretationStatus(
  status: QueryInterpretationStatus
): CompletenessReport | undefined {
  if (status === "resource_rejected") return resourceRejectedCompleteness();
  if (status === "unsupported" || status === "malformed") {
    return uniformCompleteness("unavailable");
  }
  return undefined;
}

export function interpretationMayEmitCompleteEmpty(
  status: QueryInterpretationStatus
): boolean {
  return status === "resolved";
}

export function interpretationCoverageOf(
  status: QueryInterpretationStatus | undefined
): CompletenessStatus | undefined {
  if (status === undefined) return undefined;
  if (status === "resolved") return "complete";
  if (status === "hypotheses" || status === "partial") return "open";
  if (status === "resource_rejected") return "resource_rejected";
  return "unavailable";
}

export function continuationInvalidated(input: Readonly<{
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly result_version: string;
  readonly expires_at?: string;
  readonly as_of?: string;
  readonly interpretation_id?: string;
  readonly prior_continuation?: Continuation | null;
}>): boolean {
  if (input.as_of !== undefined && input.expires_at !== undefined && input.expires_at < input.as_of) {
    return true;
  }
  const prior = input.prior_continuation;
  if (prior === undefined || prior === null) return false;
  if (prior.query_id !== input.query_id) return true;
  if (prior.snapshot_id !== input.snapshot_id) return true;
  if (prior.result_version !== input.result_version) return true;
  if (prior.interpretation_id !== input.interpretation_id) return true;
  return input.as_of !== undefined && prior.expires_at < input.as_of;
}

export function composeCompleteness(input: CompletenessInput): CompletenessReport {
  const report = attachInterpretationCoverage(
    composeCompletenessDimensions(input),
    input.interpretation_status
  );
  if (input.mixed_generation !== true) return report;
  return { ...report, payload: "omitted" };
}

function composeCompletenessDimensions(input: CompletenessInput): CompletenessReport {
  const observed = observerCompleteness(input);
  if (observed !== undefined) return observed;
  if (input.explanation_work === "open" || input.resource_work === "open") {
    return dimensionReport({
      logical_index: "open",
      observed_coverage: "open",
      remaining: input.remaining,
      omitted_payload: input.omitted_payload,
      expand_payload: input.expand_payload,
      closed: "open",
      representation: "open"
    });
  }
  if (input.total === 0) return emptyCompleteness(input);
  return dimensionReport({
    logical_index: "complete",
    observed_coverage: "complete",
    remaining: input.remaining,
    omitted_payload: input.omitted_payload,
    expand_payload: input.expand_payload,
    closed: "complete"
  });
}

function observerCompleteness(input: CompletenessInput): CompletenessReport | undefined {
  const observerStatus = input.observer?.outcome.status;
  if (observerStatus === "unavailable") {
    return dimensionReport({
      logical_index: "unavailable",
      observed_coverage: "unavailable",
      remaining: input.remaining,
      omitted_payload: input.omitted_payload,
      expand_payload: input.expand_payload,
      closed: "unavailable"
    });
  }
  if (isIncompleteObserverStatus(observerStatus)) {
    return dimensionReport({
      logical_index: "open",
      observed_coverage: observerStatus,
      remaining: input.remaining,
      omitted_payload: input.omitted_payload,
      expand_payload: input.expand_payload,
      closed: "open"
    });
  }
  if (observerStatus === "interrupted" || observerIsOpen(input.observer)) {
    return dimensionReport({
      logical_index: "open",
      observed_coverage: observerStatus === "interrupted" ? "interrupted" : "open",
      remaining: input.remaining,
      omitted_payload: input.omitted_payload,
      expand_payload: input.expand_payload,
      closed: "open",
      representation: "open"
    });
  }
  return undefined;
}

function emptyCompleteness(input: CompletenessInput): CompletenessReport {
  const status = input.interpretation_status;
  if (status !== undefined && !interpretationMayEmitCompleteEmpty(status)) {
    return dimensionReport({
      logical_index: "unavailable",
      observed_coverage: "unavailable",
      remaining: 0,
      omitted_payload: false,
      expand_payload: true,
      closed: "unavailable"
    });
  }
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    logical_index: "complete",
    observed_coverage: "exhausted_empty",
    transport: "complete",
    payload: "complete",
    representation: "complete"
  };
}

function attachInterpretationCoverage(
  report: CompletenessReport,
  status: QueryInterpretationStatus | undefined
): CompletenessReport {
  const coverage = interpretationCoverageOf(status);
  if (coverage === undefined) return report;
  return { ...report, interpretation_coverage: coverage };
}

function dimensionReport(input: Readonly<{
  readonly logical_index: CompletenessStatus;
  readonly observed_coverage: CompletenessStatus;
  readonly remaining: number;
  readonly omitted_payload: boolean;
  readonly expand_payload: boolean;
  readonly closed: CompletenessStatus;
  readonly representation?: CompletenessStatus;
}>): CompletenessReport {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    logical_index: input.logical_index,
    observed_coverage: input.observed_coverage,
    transport: input.remaining > 0 ? "partial" : input.closed,
    payload: payloadStatus(input),
    representation: input.representation ?? "complete"
  };
}

function payloadStatus(input: Readonly<{
  readonly remaining: number;
  readonly omitted_payload: boolean;
  readonly expand_payload: boolean;
  readonly closed: CompletenessStatus;
}>): CompletenessStatus {
  if (!input.expand_payload) return "open";
  if (input.remaining > 0 || input.omitted_payload) return "partial";
  return input.closed;
}

function observerIsOpen(observer: ObserverCoverage | undefined): boolean {
  if (observer === undefined) return false;
  if (observer.outcome.status === "open") return true;
  return (observer.open_regions ?? []).some((region) => region.status === "open");
}

function isIncompleteObserverStatus(
  status: ObserverOutcome["status"] | undefined
): status is IncompleteObserverStatus {
  return status !== undefined
    && (INCOMPLETE_OBSERVER_STATUSES as readonly string[]).includes(status);
}

function uniformCompleteness(status: CompletenessStatus): CompletenessReport {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    logical_index: status,
    observed_coverage: status,
    interpretation_coverage: status,
    transport: status,
    payload: status,
    representation: status
  };
}
