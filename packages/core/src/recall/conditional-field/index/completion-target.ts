/** Explains an existing response. It does not add a public field or change stopping. */

type CompletionTarget = "none" | "reliable_partial" | "certified_prefix" | "complete_membership";

type CompletionObligation =
  | "membership"
  | "observed"
  | "order"
  | "order_tail"
  | "interpretation"
  | "source_only"
  | "resource"
  | "support"
  | "continuation";

export type CompletionAccount = Readonly<{
  achieved: CompletionTarget;
  remaining_obligations: readonly CompletionObligation[];
}>;

const BLOCKING_OUTCOMES = new Set([
  "resource_exhausted", "unavailable", "invalid", "quarantine", "truncated", "transport_failure",
  "unexercised", "preparation_required", "abstained", "no_eligible_source"
]);

/** Missing and every other status stay open. Exclusion of a few unfinished names is not completion. */
const CLOSED_INTERPRETATION = new Set(["complete", "not_applicable"]);

export type CompletionExplanationInput = Readonly<{
  outcome_status?: string;
  logical_index?: string;
  observed_coverage?: string;
  interpretation_coverage?: string;
  order_status?: string;
  order_coverage?: string;
  continuation_present?: boolean;
  delivered_count?: number;
  source_only?: boolean;
  supported_delivery?: boolean;
}>;

/** Library pages stay partial until the whole relevant set is on the response. Certified prefixes stay in order-closure. */
export function libraryPageOrder(input: Readonly<{
  open_residuals: boolean;
  truncated: boolean;
  more_roots: boolean;
  page_remainder: boolean;
}>): { order_status: "open" | "complete"; order_coverage: "open" | "complete" } {
  const open = input.open_residuals || input.truncated || input.more_roots || input.page_remainder;
  return open
    ? { order_status: "open", order_coverage: "open" }
    : { order_status: "complete", order_coverage: "complete" };
}

function unique(values: readonly CompletionObligation[]): readonly CompletionObligation[] {
  return [...new Set(values)];
}

/** Payload completion, a null continuation and an empty queue are not certificates by themselves. */
export function explainCompletionTarget(input: CompletionExplanationInput): CompletionAccount {
  const blocking = input.outcome_status !== undefined && BLOCKING_OUTCOMES.has(input.outcome_status);
  const orderClosed = input.order_status === "complete" && input.order_coverage === "complete";
  const membershipClosed = input.logical_index === "complete" || input.logical_index === "exhausted_empty";
  const observedClosed = input.observed_coverage === "complete";
  const interpretationClosed = input.interpretation_coverage !== undefined
    && CLOSED_INTERPRETATION.has(input.interpretation_coverage);
  const delivered = input.delivered_count ?? 0;
  const supportOpen = delivered > 0 && input.supported_delivery !== true && input.source_only !== true;
  const obligations: CompletionObligation[] = [];
  if (!membershipClosed) obligations.push("membership");
  if (!observedClosed) obligations.push("observed");
  if (input.order_status === "certified_prefix") obligations.push("order_tail");
  else if (!orderClosed) obligations.push("order");
  if (!interpretationClosed) obligations.push("interpretation");
  if (input.source_only === true) obligations.push("source_only");
  if (blocking || input.logical_index === "resource_rejected") obligations.push("resource");
  if (supportOpen) obligations.push("support");
  if (input.continuation_present === true) obligations.push("continuation");
  const admitted = input.outcome_status === undefined || input.outcome_status === "interpreted";
  if (obligations.length === 0 && admitted) {
    return { achieved: "complete_membership", remaining_obligations: [] };
  }
  if (input.order_status === "certified_prefix" && !blocking) {
    return { achieved: "certified_prefix", remaining_obligations: unique(obligations) };
  }
  if (delivered > 0 && (input.supported_delivery === true || input.source_only === true)) {
    return { achieved: "reliable_partial", remaining_obligations: unique(obligations) };
  }
  return { achieved: "none", remaining_obligations: unique(obligations.length === 0 ? ["membership"] : obligations) };
}
