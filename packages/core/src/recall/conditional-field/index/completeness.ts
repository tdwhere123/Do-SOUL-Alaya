import {
  ASSOCIATION_DOMAIN_ID,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type ClosureCertificate,
  type ClosureComparison,
  type ClosureCoveragePremise,
  type CompletenessReport,
  type CompletenessStatus,
  type Continuation,
  type CoverageRegion,
  type ObserverOutcome,
  type QueryInterpretationStatus,
  type RecallTargetKind,
  type RequestBudget,
  type ResidualSemanticEffect,
  type ResultKindView
} from "@do-soul/alaya-protocol";
import { aggregateObserverStatus } from "../reference/accepting-projection.js";
import {
  classifyResidualInfluence,
  coverageRoleOf,
  membershipCoveredByCertificate,
  semanticEffectsOf,
  sufficientAlternatePaths,
  type ResidualClassificationContext
} from "./residual-influence.js";

export type { ResidualClassificationContext } from "./residual-influence.js";
export {
  classifyResidualInfluence,
  coverageRoleOf,
  residualAffectsGrade,
  residualGradeUpper,
  residualsInvalidateBounds,
  semanticEffectsOf,
  sufficientAlternatePaths
} from "./residual-influence.js";

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
  readonly claim_work?: "complete" | "open";
  readonly pending_computation?: "complete" | "open";
  readonly residuals?: readonly CoverageRegion[];
  readonly sufficient_alternate_paths?: boolean;
  readonly certificate?: ClosureCertificate;
  readonly query_id?: string;
  readonly predicate_id?: string;
  readonly operator_id?: string;
  readonly domain_id?: string;
  readonly program_id?: string;
  readonly result_kind_view?: ResultKindView;
  readonly target_kinds?: readonly RecallTargetKind[];
  readonly source_domains?: readonly string[];
  readonly hypothesis_id?: string;
  readonly binding?: string;
  readonly includes_source_only?: boolean;
}>;

export type CertifyClosureInput = Readonly<{
  readonly query_id: string;
  readonly predicate_id: string;
  readonly operator_id: string;
  readonly domain_id: string;
  readonly coverage_premise: ClosureCoveragePremise;
  readonly closed_effects: readonly ResidualSemanticEffect[];
  readonly residuals: readonly CoverageRegion[];
  readonly sufficient_alternate_paths?: boolean;
  readonly comparison?: ClosureComparison;
  readonly threshold_milligrades?: number;
  readonly upper_milligrades?: number;
  readonly uses_raw_predicate?: boolean;
  readonly quantized_cap_only?: boolean;
  readonly program_id?: string;
  readonly result_kind_view?: ResultKindView;
  readonly target_kinds?: readonly RecallTargetKind[];
  readonly source_domains?: readonly string[];
  readonly hypothesis_id?: string;
  readonly binding?: string;
  readonly includes_source_only?: boolean;
  readonly closed_obligations?: readonly ("membership" | "claim" | "order")[];
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
  readonly lifetime_now?: string;
  readonly interpretation_id?: string;
  readonly prior_continuation?: Continuation | null;
}>): boolean {
  const now = input.lifetime_now ?? input.as_of;
  if (now !== undefined && input.expires_at !== undefined && input.expires_at <= now) {
    return true;
  }
  const prior = input.prior_continuation;
  if (prior === undefined || prior === null) return false;
  if (prior.query_id !== input.query_id) return true;
  if (prior.snapshot_id !== input.snapshot_id) return true;
  if (prior.result_version !== input.result_version) return true;
  if (prior.interpretation_id !== input.interpretation_id) return true;
  return now !== undefined && prior.expires_at <= now;
}

export function upperExcludesPredicate(input: Readonly<{
  readonly comparison: ClosureComparison;
  readonly upper: number;
  readonly threshold: number;
  readonly uses_raw_predicate?: boolean;
  readonly quantized_cap_only?: boolean;
}>): boolean {
  if (input.quantized_cap_only === true && input.uses_raw_predicate !== true) return false;
  if (input.comparison === "gt") return input.upper <= input.threshold;
  if (input.comparison === "gte") return input.upper < input.threshold;
  if (input.comparison === "lt") return input.upper >= input.threshold;
  return input.upper > input.threshold;
}

export function certifyClosure(input: CertifyClosureInput): ClosureCertificate | undefined {
  if (input.closed_effects.length === 0) return undefined;
  if (input.residuals.some((region) => region.status === "invalidated")) return undefined;
  const context: ResidualClassificationContext = {};
  for (const effect of input.closed_effects) {
    const blocking = input.residuals.some((region) => {
      if (input.coverage_premise === "required_regions_irrelevant"
        && coverageRoleOf(region) === "optional_accelerator") {
        return false;
      }
      return classifyResidualInfluence(region, context, effect) !== "irrelevant";
    });
    if (blocking) return undefined;
  }
  if (!hasRequiredCoverage(input)) return undefined;
  if (input.coverage_premise === "upper_excludes_predicate") {
    if (input.comparison === undefined || input.threshold_milligrades === undefined
      || input.upper_milligrades === undefined) {
      return undefined;
    }
    if (!upperExcludesPredicate({
      comparison: input.comparison,
      upper: input.upper_milligrades,
      threshold: input.threshold_milligrades,
      uses_raw_predicate: input.uses_raw_predicate,
      quantized_cap_only: input.quantized_cap_only
    })) {
      return undefined;
    }
  }
  if (input.coverage_premise === "alternate_source_path"
    && !alternateSourcePathCovered(input)) {
    return undefined;
  }
  const certificate_id = [
    input.query_id,
    input.predicate_id,
    input.operator_id,
    input.domain_id,
    input.coverage_premise
  ].join(":").slice(0, 256);
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    certificate_id,
    query_id: input.query_id,
    predicate_id: input.predicate_id,
    operator_id: input.operator_id,
    domain_id: input.domain_id,
    coverage_premise: input.coverage_premise,
    closed_effects: input.closed_effects,
    ...coverageFieldsOf(input)
  };
}

export function composeCompleteness(input: CompletenessInput): CompletenessReport {
  const residuals = coverageRegionsOf(input);
  const certificate = input.certificate ?? membershipCertificate(input, residuals);
  const resolved: CompletenessInput = {
    ...input,
    residuals,
    sufficient_alternate_paths: sufficientAlternatePaths(residuals, certificate),
    certificate
  };
  const report = attachDistinguishableDimensions(
    attachInterpretationCoverage(
      composeCompletenessDimensions(resolved),
      resolved.interpretation_status
    ),
    resolved
  );
  if (resolved.mixed_generation !== true) return report;
  return { ...report, payload: "omitted" };
}

function membershipCertificate(
  input: CompletenessInput,
  residuals: readonly CoverageRegion[]
): ClosureCertificate | undefined {
  return certifyClosure({
    query_id: input.query_id ?? "query",
    predicate_id: input.predicate_id ?? "membership",
    operator_id: input.operator_id ?? "max-min",
    domain_id: input.domain_id ?? ASSOCIATION_DOMAIN_ID,
    coverage_premise: "required_regions_irrelevant",
    closed_effects: ["membership"],
    residuals,
    program_id: input.program_id,
    result_kind_view: input.result_kind_view,
    target_kinds: input.target_kinds,
    source_domains: input.source_domains,
    hypothesis_id: input.hypothesis_id,
    binding: input.binding,
    includes_source_only: input.includes_source_only
  });
}

function composeCompletenessDimensions(input: CompletenessInput): CompletenessReport {
  const observed = observerCompleteness(input);
  if (observed !== undefined) return observed;
  if (input.explanation_work === "open" || input.resource_work === "open"
    || input.pending_computation === "open") {
    return dimensionReport({
      logical_index: "open",
      observed_coverage: "complete",
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
  const observerStatus = influentialObserverStatus(input);
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
  if (observerStatus === "interrupted" || observerStatus === "open" || observerIsOpen(input)) {
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
  if (status === "partial" || status === "hypotheses") {
    return dimensionReport({
      logical_index: "open",
      observed_coverage: "exhausted_empty",
      remaining: 0,
      omitted_payload: false,
      expand_payload: true,
      closed: "open"
    });
  }
  if (status !== undefined && !interpretationMayEmitCompleteEmpty(status)) {
    return dimensionReport({
      logical_index: status === "resource_rejected" ? "resource_rejected" : "unavailable",
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

function attachDistinguishableDimensions(
  report: CompletenessReport,
  input: CompletenessInput
): CompletenessReport {
  const closedOrder = input.certificate?.closed_effects.includes("order") === true;
  const extras: Partial<CompletenessReport> = {
    ...(input.claim_work === undefined ? {} : {
      claim_coverage: input.claim_work === "open" ? "open" : "complete"
    }),
    ...(input.explanation_work === undefined ? {} : {
      explanation_coverage: input.explanation_work === "open" ? "open" : "complete"
    }),
    order_coverage: closedOrder ? "complete" : "open",
    ...(input.pending_computation === undefined && input.resource_work !== "open" ? {} : {
      pending_computation: input.pending_computation === "open" || input.resource_work === "open"
        ? "open"
        : "complete"
    }),
    ...(input.certificate === undefined ? {} : { certificate_id: input.certificate.certificate_id })
  };
  return { ...report, ...extras };
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

function coverageRegionsOf(input: CompletenessInput): readonly CoverageRegion[] {
  return input.residuals ?? input.observer?.open_regions ?? [];
}

function classificationContextOf(input: CompletenessInput): ResidualClassificationContext {
  return { certificate: input.certificate };
}

function influentialObserverStatus(input: CompletenessInput): ObserverOutcome["status"] | undefined {
  if (input.observer === undefined && (input.residuals === undefined || input.residuals.length === 0)) {
    return undefined;
  }
  const context = classificationContextOf(input);
  const regions = coverageRegionsOf(input);
  const active = regions.filter((region) =>
    classifyResidualInfluence(region, context, "membership") !== "irrelevant");
  if (active.length === 0) {
    if (input.observer === undefined) return "exhausted";
    if (regions.length > 0 && membershipCoveredByCertificate(context, "membership")) {
      return "exhausted";
    }
  }
  return aggregateObserverStatus(input.observer?.outcome.status, active);
}

function observerIsOpen(input: CompletenessInput): boolean {
  const context = classificationContextOf(input);
  if (input.observer?.outcome.status === "open") {
    const regions = coverageRegionsOf(input);
    if (regions.length === 0) return true;
    return regions.some((region) =>
      classifyResidualInfluence(region, context, "membership") !== "irrelevant");
  }
  return coverageRegionsOf(input).some((region) =>
    classifyResidualInfluence(region, context, "membership") !== "irrelevant"
    && region.status === "open");
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

function hasRequiredCoverage(input: CertifyClosureInput): boolean {
  return input.closed_effects.some((effect) => input.residuals.some((region) =>
    coverageRoleOf(region) === "required" && semanticEffectsOf(region).includes(effect)));
}

function alternateSourcePathCovered(input: CertifyClosureInput): boolean {
  if (input.result_kind_view === "memory_only") return true;
  return input.includes_source_only === true;
}

function coverageFieldsOf(input: CertifyClosureInput): Partial<ClosureCertificate> {
  const closed_obligations = input.closed_obligations ?? obligationsOf(input.closed_effects);
  const source_domains = input.source_domains ?? domainsOf(input.residuals);
  const hypothesis_id = input.hypothesis_id
    ?? input.residuals.find((region) => region.hypothesis_id !== undefined)?.hypothesis_id;
  const result_kind_view = input.result_kind_view;
  const target_kinds = input.target_kinds ?? targetKindsOf(result_kind_view);
  const includes_source_only = input.includes_source_only
    ?? includesSourceOnly(result_kind_view, input.residuals);
  return {
    ...(input.comparison === undefined ? {} : { comparison: input.comparison }),
    ...(input.threshold_milligrades === undefined ? {} : { threshold_milligrades: input.threshold_milligrades }),
    ...(input.uses_raw_predicate === undefined ? {} : { uses_raw_predicate: input.uses_raw_predicate }),
    ...(input.program_id === undefined ? {} : { program_id: input.program_id }),
    ...(result_kind_view === undefined ? {} : { result_kind_view }),
    ...(target_kinds === undefined ? {} : { target_kinds }),
    ...(source_domains.length === 0 ? {} : { source_domains }),
    ...(hypothesis_id === undefined ? {} : { hypothesis_id }),
    ...(input.binding === undefined ? {} : { binding: input.binding }),
    ...(includes_source_only === undefined ? {} : { includes_source_only }),
    ...(closed_obligations.length === 0 ? {} : { closed_obligations })
  };
}

function obligationsOf(
  effects: readonly ResidualSemanticEffect[]
): readonly ("membership" | "claim" | "order")[] {
  const obligations: ("membership" | "claim" | "order")[] = [];
  if (effects.includes("membership")) obligations.push("membership");
  if (effects.includes("claim") || effects.includes("refutation")) obligations.push("claim");
  if (effects.includes("order")) obligations.push("order");
  return obligations;
}

function domainsOf(residuals: readonly CoverageRegion[]): readonly string[] {
  const domains = new Set<string>();
  for (const region of residuals) {
    if (region.source_domain !== undefined) domains.add(region.source_domain);
  }
  return [...domains];
}

function targetKindsOf(view: ResultKindView | undefined): readonly RecallTargetKind[] | undefined {
  if (view === "memory_only") return ["memory_entry"];
  if (view === "source_only") return ["source_evidence"];
  if (view === "mixed") return ["memory_entry", "source_evidence"];
  return undefined;
}

function includesSourceOnly(
  view: ResultKindView | undefined,
  residuals: readonly CoverageRegion[]
): boolean | undefined {
  if (view === "memory_only") return false;
  if (view !== "mixed" && view !== "source_only") return undefined;
  const source = residuals.filter((region) =>
    region.kind === "source_domain" && coverageRoleOf(region) === "required");
  if (source.length === 0) return undefined;
  return source.every((region) => region.status === "exhausted" || region.status === "not_applicable");
}
