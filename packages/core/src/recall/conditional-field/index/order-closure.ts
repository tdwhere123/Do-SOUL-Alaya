import {
  ASSOCIATION_DOMAIN_ID,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type CoverageRegion,
  type ClosureCertificate,
  type EnumerationPolicy,
  type OrderStatus,
  type QueryView,
  type ResultKindView
} from "@do-soul/alaya-protocol";
import {
  classifyResidualInfluence,
  type ObserverCoverage
} from "./completeness.js";

export type OrderCoveragePremise = "closed" | "open";

export type OrderClosureInput = Readonly<{
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly interpretation_id?: string;
  readonly enumeration_policy: EnumerationPolicy;
  readonly result_kind_view?: ResultKindView;
  readonly residuals?: readonly CoverageRegion[];
  readonly observer?: ObserverCoverage;
  readonly remaining: number;
  readonly resource_open: boolean;
  readonly pending_semantic_work: boolean;
  readonly unseen_identity_coverage: OrderCoveragePremise;
  readonly unseen_grade_coverage: OrderCoveragePremise;
  readonly known_revision_coverage: OrderCoveragePremise;
  readonly equal_grade_tie_closed: boolean;
  readonly claim_eligibility_closed: boolean;
  readonly raw_source_residual: boolean;
}>;

export type OrderClosureResult = Readonly<{
  readonly order_status: Extract<OrderStatus, "open" | "certified_prefix" | "complete">;
  readonly certificate?: ClosureCertificate;
}>;

export function evaluateOrderClosure(input: OrderClosureInput): OrderClosureResult {
  if (input.pending_semantic_work || input.resource_open || input.raw_source_residual) {
    return { order_status: "open" };
  }
  if (input.unseen_identity_coverage !== "closed" || input.known_revision_coverage !== "closed") {
    return { order_status: "open" };
  }
  if (!input.claim_eligibility_closed) return { order_status: "open" };
  if (input.enumeration_policy === "associative") {
    if (input.unseen_grade_coverage !== "closed" || !input.equal_grade_tie_closed) {
      return { order_status: "open" };
    }
  }
  const residuals = input.residuals ?? input.observer?.open_regions ?? [];
  if (residuals.some((region) => classifyResidualInfluence(region, {}, "order") !== "irrelevant")) {
    return { order_status: "open" };
  }
  const certificate = orderCertificate(input);
  if (input.remaining > 0) return { order_status: "certified_prefix", certificate };
  return { order_status: "complete", certificate };
}

function orderCertificate(input: OrderClosureInput): ClosureCertificate {
  const operator_id = input.enumeration_policy === "associative" ? "associative-prefix" : "canonical-prefix";
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    certificate_id: [input.query_id, "order", operator_id, ASSOCIATION_DOMAIN_ID].join(":").slice(0, 256),
    query_id: input.query_id,
    predicate_id: "order",
    operator_id,
    domain_id: ASSOCIATION_DOMAIN_ID,
    coverage_premise: "required_regions_irrelevant",
    closed_effects: ["order"],
    closed_obligations: ["order"],
    ...(input.interpretation_id === undefined ? {} : { program_id: input.interpretation_id }),
    ...(input.result_kind_view === undefined ? {} : { result_kind_view: input.result_kind_view })
  };
}

export function orderClosureFromProjection(input: Readonly<{
  readonly view: QueryView;
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly interpretation_id?: string;
  readonly observer?: ObserverCoverage;
  readonly residuals?: readonly CoverageRegion[];
  readonly remaining: number;
  readonly resource_open: boolean;
  readonly pending_semantic_work: boolean;
  readonly claim_work?: "complete" | "open";
}>): OrderClosureResult {
  const residuals = input.residuals ?? input.observer?.open_regions ?? [];
  const observerClosed = input.observer?.outcome.status === "exhausted";
  const influential = residuals.some((region) =>
    classifyResidualInfluence(region, {}, "membership") !== "irrelevant"
    || classifyResidualInfluence(region, {}, "order") !== "irrelevant");
  const sourceOpen = residuals.some((region) =>
    region.kind === "source_domain"
    && region.status !== "exhausted"
    && region.status !== "not_applicable");
  const mixedOrSource = (input.view.result_kind_view ?? "mixed") !== "memory_only";
  const closed = observerClosed && !influential;
  return evaluateOrderClosure({
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    interpretation_id: input.interpretation_id,
    enumeration_policy: input.view.enumeration_policy ?? "canonical",
    result_kind_view: input.view.result_kind_view,
    residuals,
    observer: input.observer,
    remaining: input.remaining,
    resource_open: input.resource_open,
    pending_semantic_work: input.pending_semantic_work,
    unseen_identity_coverage: closed ? "closed" : "open",
    unseen_grade_coverage: closed ? "closed" : "open",
    known_revision_coverage: closed ? "closed" : "open",
    equal_grade_tie_closed: closed,
    claim_eligibility_closed: input.claim_work !== "open",
    raw_source_residual: mixedOrSource && sourceOpen
  });
}
