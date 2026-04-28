import {
  assertIsoDatetime,
  assertNonNegativeInteger,
  assertObject,
  assertOneOf,
  assertText,
  assertTextArray
} from "../foundation/validation.js";
import { memoryDimensions, scopeClasses } from "../ontology/types.js";
import type { MemoryDimension, ScopeClass } from "../ontology/types.js";

export const providerCapabilities = ["embedding", "rerank", "proposal", "explain"] as const;
export type ProviderCapability = (typeof providerCapabilities)[number];

export const providerHealthStatuses = [
  "configured",
  "enabled",
  "disabled",
  "unavailable",
  "degraded"
] as const;
export type ProviderHealthStatus = (typeof providerHealthStatuses)[number];

export interface ProviderHealthState {
  readonly status: ProviderHealthStatus;
  readonly reason: string | null;
  readonly checked_at: string | null;
}

export interface ProviderRegistryEntry {
  readonly provider_id: string;
  readonly provider_kind: string;
  readonly priority: number;
  readonly capabilities: readonly ProviderCapability[];
  readonly model_ref: string;
  readonly config_ref: string;
  readonly health: ProviderHealthState;
  readonly scope_refs: readonly string[] | null;
}

export interface ProviderSelectionRequest {
  readonly capability: ProviderCapability;
  readonly required: boolean;
  readonly scope_ref: string | null;
  readonly allow_degraded?: boolean;
  readonly decision_id?: string | null;
}

export const providerSelectionStatuses = ["selected", "degraded", "failed_closed"] as const;
export type ProviderSelectionStatus = (typeof providerSelectionStatuses)[number];

export interface ProviderSelectionResult {
  readonly decision_id: string;
  readonly status: ProviderSelectionStatus;
  readonly capability: ProviderCapability;
  readonly required: boolean;
  readonly degraded: boolean;
  readonly selected_provider: ProviderRegistryEntry | null;
  readonly selection_reason: string;
  readonly rejected_provider_ids: readonly string[];
}

export const proposalSourceKinds = ["provider", "llm", "connected_agent", "subagent", "operator"] as const;
export type ProposalSourceKind = (typeof proposalSourceKinds)[number];

export interface ProposalSource {
  readonly kind: ProposalSourceKind;
  readonly ref: string;
}

export interface ProposalScope {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly scope_class: ScopeClass;
  readonly scope_ref: string;
}

export const proposalLifecycleStates = ["draft", "candidate", "pending_review", "rejected"] as const;
export type ProposalLifecycleState = (typeof proposalLifecycleStates)[number];

export const proposalGovernanceOutcomes = ["candidate", "pending_review", "not_promoted"] as const;
export type ProposalGovernanceOutcome = (typeof proposalGovernanceOutcomes)[number];

export interface ProposalRecord {
  readonly proposal_id: string;
  readonly created_at: string;
  readonly source: ProposalSource | null;
  readonly source_refs: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly scope: ProposalScope | null;
  readonly target_dimension: MemoryDimension;
  readonly proposed_content_ref: string;
  readonly provider_decision_id: string | null;
  readonly lifecycle_state: ProposalLifecycleState;
  readonly governance_outcome: ProposalGovernanceOutcome | null;
  readonly rejection_reason: string | null;
  readonly validation_errors: readonly string[];
  readonly durable_truth: false;
}

export interface ProposalValidationResult {
  readonly accepted: boolean;
  readonly auditable: true;
  readonly durable_truth: false;
  readonly lifecycle_state: ProposalLifecycleState;
  readonly reasons: readonly string[];
  readonly proposal: ProposalRecord;
}

export const backgroundProposalJobStatuses = ["completed", "failed", "degraded"] as const;
export type BackgroundProposalJobStatus = (typeof backgroundProposalJobStatuses)[number];

export interface BackgroundProposalJobInput {
  readonly job_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly provider_decision_id: string | null;
  readonly status: BackgroundProposalJobStatus;
  readonly proposal_results: readonly ProposalValidationResult[];
  readonly failure_reason?: string | null;
  readonly degraded_reason?: string | null;
}

export interface BackgroundProposalJobSummary {
  readonly job_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly provider_decision_id: string | null;
  readonly status: BackgroundProposalJobStatus;
  readonly main_turn_failed: false;
  readonly main_turn_outcome: "unchanged";
  readonly durable_truth_written: false;
  readonly proposal_count: number;
  readonly accepted_count: number;
  readonly rejected_count: number;
  readonly audit_reasons: readonly string[];
}

interface EvaluatedProvider {
  readonly entry: ProviderRegistryEntry;
  readonly eligible: boolean;
  readonly degraded: boolean;
  readonly rejection_reason: string | null;
}

export function selectProviderForCapability(
  providers: readonly ProviderRegistryEntry[],
  request: ProviderSelectionRequest
): ProviderSelectionResult {
  validateSelectionRequest(request);
  providers.forEach(validateProviderRegistryEntry);

  const evaluated = providers.map((entry) => evaluateProvider(entry, request));
  const healthyCandidates = sortEvaluatedProviders(
    evaluated.filter((candidate) => candidate.eligible && !candidate.degraded)
  );
  const selectedHealthy = healthyCandidates[0] ?? null;

  if (selectedHealthy !== null) {
    return selectedProviderResult(selectedHealthy, request, "selected", false, evaluated);
  }

  const degradedCandidates = sortEvaluatedProviders(
    evaluated.filter((candidate) => candidate.eligible && candidate.degraded)
  );
  const selectedDegraded = degradedCandidates[0] ?? null;

  if (!request.required && request.allow_degraded === true && selectedDegraded !== null) {
    return selectedProviderResult(selectedDegraded, request, "degraded", true, evaluated);
  }

  const status = request.required ? "failed_closed" : "degraded";
  const reason = request.required
    ? `fail_closed: required capability=${request.capability} has no enabled provider`
    : `optional_capability_degraded: capability=${request.capability} has no enabled provider`;

  return {
    capability: request.capability,
    decision_id: selectionDecisionId(request, null),
    degraded: !request.required,
    rejected_provider_ids: rejectedProviderIds(evaluated),
    required: request.required,
    selected_provider: null,
    selection_reason: reason,
    status
  };
}

export function validateProposalRecord(record: ProposalRecord): ProposalValidationResult {
  const reasons = proposalValidationReasons(record);
  const accepted = reasons.length === 0;

  if (accepted) {
    return {
      accepted: true,
      auditable: true,
      durable_truth: false,
      lifecycle_state: record.lifecycle_state,
      proposal: {
        ...record,
        durable_truth: false
      },
      reasons: []
    };
  }

  const rejected = createRejectedProposalRecord(record, reasons.join(","));
  return {
    accepted: false,
    auditable: true,
    durable_truth: false,
    lifecycle_state: "rejected",
    proposal: rejected,
    reasons
  };
}

export function createRejectedProposalRecord(record: ProposalRecord, rejectionReason: string): ProposalRecord {
  assertText(rejectionReason, "rejection_reason");
  const validationErrors = Array.isArray(record.validation_errors) ? record.validation_errors : [];

  return {
    ...record,
    durable_truth: false,
    governance_outcome: normalizeRejectedGovernanceOutcome(record),
    lifecycle_state: "rejected",
    rejection_reason: rejectionReason,
    validation_errors: uniqueTextValues([...validationErrors, rejectionReason])
  };
}

export function summarizeBackgroundProposalJob(input: BackgroundProposalJobInput): BackgroundProposalJobSummary {
  assertText(input.job_id, "job_id");
  assertText(input.workspace_id, "workspace_id");
  assertText(input.run_id, "run_id");
  assertOneOf(input.status, backgroundProposalJobStatuses, "status");
  if (input.provider_decision_id !== null) {
    assertText(input.provider_decision_id, "provider_decision_id");
  }
  if (!Array.isArray(input.proposal_results)) {
    throw new TypeError("proposal_results must be an array.");
  }

  const acceptedCount = input.proposal_results.filter((result) => result.accepted).length;
  const rejectedCount = input.proposal_results.length - acceptedCount;
  const statusReason = statusAuditReason(input);
  const auditReasons = uniqueTextValues([
    ...(statusReason === null ? [] : [statusReason]),
    ...input.proposal_results.flatMap((result) => result.reasons)
  ]);

  return {
    accepted_count: acceptedCount,
    audit_reasons: auditReasons,
    durable_truth_written: false,
    job_id: input.job_id,
    main_turn_failed: false,
    main_turn_outcome: "unchanged",
    proposal_count: input.proposal_results.length,
    provider_decision_id: input.provider_decision_id,
    rejected_count: rejectedCount,
    run_id: input.run_id,
    status: input.status,
    workspace_id: input.workspace_id
  };
}

function validateSelectionRequest(request: ProviderSelectionRequest): void {
  assertObject(request, "ProviderSelectionRequest");
  assertOneOf(request.capability, providerCapabilities, "capability");
  if (typeof request.required !== "boolean") {
    throw new TypeError("required must be boolean.");
  }
  if (request.scope_ref !== null) {
    assertText(request.scope_ref, "scope_ref");
  }
  if (request.decision_id !== undefined && request.decision_id !== null) {
    assertText(request.decision_id, "decision_id");
  }
  if (request.allow_degraded !== undefined && typeof request.allow_degraded !== "boolean") {
    throw new TypeError("allow_degraded must be boolean.");
  }
}

function validateProviderRegistryEntry(entry: ProviderRegistryEntry): void {
  assertObject(entry, "ProviderRegistryEntry");
  assertText(entry.provider_id, "provider_id");
  assertText(entry.provider_kind, "provider_kind");
  assertNonNegativeInteger(entry.priority, "priority");
  assertTextArray(entry.capabilities, "capabilities");
  entry.capabilities.forEach((capability, index) => {
    assertOneOf(capability, providerCapabilities, `capabilities[${index}]`);
  });
  assertText(entry.model_ref, "model_ref");
  assertText(entry.config_ref, "config_ref");
  validateProviderHealth(entry.health);
  if (entry.scope_refs !== null) {
    assertTextArray(entry.scope_refs, "scope_refs");
  }
}

function validateProviderHealth(health: ProviderHealthState): void {
  assertObject(health, "ProviderHealthState");
  assertOneOf(health.status, providerHealthStatuses, "health.status");
  if (health.reason !== null) {
    assertText(health.reason, "health.reason");
  }
  if (health.checked_at !== null) {
    assertIsoDatetime(health.checked_at, "health.checked_at");
  }
}

function evaluateProvider(
  entry: ProviderRegistryEntry,
  request: ProviderSelectionRequest
): EvaluatedProvider {
  if (!entry.capabilities.includes(request.capability)) {
    return rejectedProvider(entry, "capability_missing");
  }

  if (!matchesScope(entry, request.scope_ref)) {
    return rejectedProvider(entry, "scope_mismatch");
  }

  switch (entry.health.status) {
    case "enabled":
      return {
        degraded: false,
        eligible: true,
        entry,
        rejection_reason: null
      };
    case "degraded":
      if (!request.required && request.allow_degraded === true) {
        return {
          degraded: true,
          eligible: true,
          entry,
          rejection_reason: null
        };
      }
      return rejectedProvider(entry, request.required ? "health_degraded_required" : "health_degraded_not_allowed");
    case "configured":
      return rejectedProvider(entry, "provider_configured_not_enabled");
    case "disabled":
      return rejectedProvider(entry, "provider_disabled");
    case "unavailable":
      return rejectedProvider(entry, "health_unavailable");
  }
}

function rejectedProvider(entry: ProviderRegistryEntry, rejectionReason: string): EvaluatedProvider {
  return {
    degraded: false,
    eligible: false,
    entry,
    rejection_reason: rejectionReason
  };
}

function selectedProviderResult(
  selected: EvaluatedProvider,
  request: ProviderSelectionRequest,
  status: ProviderSelectionStatus,
  degraded: boolean,
  evaluated: readonly EvaluatedProvider[]
): ProviderSelectionResult {
  const statusReason = degraded ? "optional_degraded_provider_selected" : "enabled_provider_selected";

  return {
    capability: request.capability,
    decision_id: selectionDecisionId(request, selected.entry.provider_id),
    degraded,
    rejected_provider_ids: rejectedProviderIds(evaluated),
    required: request.required,
    selected_provider: selected.entry,
    selection_reason: [
      statusReason,
      `capability=${request.capability}`,
      `provider=${selected.entry.provider_id}`,
      `priority=${selected.entry.priority}`,
      `health=${selected.entry.health.status}`,
      `tie_break=${selected.entry.provider_id}`
    ].join("; "),
    status
  };
}

function matchesScope(entry: ProviderRegistryEntry, scopeRef: string | null): boolean {
  if (scopeRef === null || entry.scope_refs === null) {
    return true;
  }
  return entry.scope_refs.includes(scopeRef);
}

function sortEvaluatedProviders(candidates: readonly EvaluatedProvider[]): readonly EvaluatedProvider[] {
  return [...candidates].sort((left, right) => compareProviders(left.entry, right.entry));
}

function compareProviders(left: ProviderRegistryEntry, right: ProviderRegistryEntry): number {
  const priorityDelta = left.priority - right.priority;
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return providerTieBreakKey(left).localeCompare(providerTieBreakKey(right));
}

function providerTieBreakKey(entry: ProviderRegistryEntry): string {
  return [entry.provider_id, entry.provider_kind, entry.model_ref, entry.config_ref].join("|");
}

function rejectedProviderIds(evaluated: readonly EvaluatedProvider[]): readonly string[] {
  return evaluated
    .filter((candidate) => candidate.rejection_reason !== null)
    .map((candidate) => `${candidate.entry.provider_id}:${candidate.rejection_reason}`);
}

function selectionDecisionId(request: ProviderSelectionRequest, selectedProviderId: string | null): string {
  if (request.decision_id !== undefined && request.decision_id !== null) {
    return request.decision_id;
  }
  return [
    "provider-selection",
    request.capability,
    request.required ? "required" : "optional",
    request.scope_ref ?? "global",
    selectedProviderId ?? "none"
  ].join(":");
}

function proposalValidationReasons(record: ProposalRecord): readonly string[] {
  assertObject(record, "ProposalRecord");
  const reasons: string[] = [];

  collectTextReason(record.proposal_id, "proposal_id", "proposal_id_missing", reasons);
  collectIsoReason(record.created_at, "created_at_invalid", reasons);
  collectSourceReasons(record, reasons);
  collectTextArrayReason(record.source_refs, "source_refs_missing", reasons);
  collectTextArrayReason(record.evidence_refs, "evidence_missing", reasons);
  collectScopeReasons(record.scope, reasons);
  collectOneOfReason(record.target_dimension, memoryDimensions, "target_dimension_unsupported", reasons);
  collectTextReason(record.proposed_content_ref, "proposed_content_ref", "proposed_content_ref_missing", reasons);
  if (record.provider_decision_id !== null) {
    collectTextReason(record.provider_decision_id, "provider_decision_id", "provider_decision_id_missing", reasons);
  }

  if ((record as { readonly durable_truth?: unknown }).durable_truth !== false) {
    reasons.push("durable_truth_flag_invalid");
  }

  if (
    (record as { readonly durable_truth?: unknown }).durable_truth === true ||
    (record as { readonly lifecycle_state?: unknown }).lifecycle_state === "durable" ||
    (record as { readonly governance_outcome?: unknown }).governance_outcome === "durable"
  ) {
    reasons.push("durable_truth_bypass_attempt");
  }

  if ((record as { readonly lifecycle_state?: unknown }).lifecycle_state !== "durable") {
    collectOneOfReason(record.lifecycle_state, proposalLifecycleStates, "lifecycle_state_unsupported", reasons);
  }

  if (
    record.governance_outcome !== null &&
    (record as { readonly governance_outcome?: unknown }).governance_outcome !== "durable"
  ) {
    collectOneOfReason(record.governance_outcome, proposalGovernanceOutcomes, "governance_outcome_unsupported", reasons);
  }

  if (!Array.isArray(record.validation_errors)) {
    reasons.push("validation_errors_invalid");
  } else {
    record.validation_errors.forEach((entry, index) => {
      collectTextReason(entry, `validation_errors[${index}]`, "validation_errors_invalid", reasons);
    });
  }

  if (record.lifecycle_state === "rejected") {
    if (isNonEmptyText(record.rejection_reason)) {
      reasons.push(record.rejection_reason);
    } else {
      reasons.push("rejection_reason_missing");
    }
  } else if (record.rejection_reason !== null && !isNonEmptyText(record.rejection_reason)) {
    reasons.push("rejection_reason_invalid");
  }

  return uniqueTextValues(reasons);
}

function collectSourceReasons(record: ProposalRecord, reasons: string[]): void {
  if (record.source === null || typeof record.source !== "object" || Array.isArray(record.source)) {
    reasons.push("source_missing");
    return;
  }
  collectOneOfReason(record.source.kind, proposalSourceKinds, "source_kind_unsupported", reasons);
  collectTextReason(record.source.ref, "source.ref", "source_missing", reasons);
}

function collectScopeReasons(scope: ProposalScope | null, reasons: string[]): void {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
    reasons.push("scope_missing");
    return;
  }
  collectTextReason(scope.workspace_id, "scope.workspace_id", "scope_missing", reasons);
  collectTextReason(scope.run_id, "scope.run_id", "scope_missing", reasons);
  if (scope.surface_id !== null) {
    collectTextReason(scope.surface_id, "scope.surface_id", "scope_surface_invalid", reasons);
  }
  collectOneOfReason(scope.scope_class, scopeClasses, "scope_class_unsupported", reasons);
  collectTextReason(scope.scope_ref, "scope.scope_ref", "scope_missing", reasons);
}

function collectTextArrayReason(value: unknown, reason: string, reasons: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyText)) {
    reasons.push(reason);
  }
}

function collectTextReason(value: unknown, _label: string, reason: string, reasons: string[]): void {
  if (!isNonEmptyText(value)) {
    reasons.push(reason);
  }
}

function collectIsoReason(value: unknown, reason: string, reasons: string[]): void {
  if (!isNonEmptyText(value) || Number.isNaN(Date.parse(value))) {
    reasons.push(reason);
  }
}

function collectOneOfReason<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  reason: string,
  reasons: string[]
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    reasons.push(reason);
  }
}

function normalizeRejectedGovernanceOutcome(record: ProposalRecord): ProposalGovernanceOutcome | null {
  const outcome = (record as { readonly governance_outcome?: unknown }).governance_outcome;
  if (outcome === "durable") {
    return "not_promoted";
  }
  if (typeof outcome === "string" && proposalGovernanceOutcomes.includes(outcome as ProposalGovernanceOutcome)) {
    return outcome as ProposalGovernanceOutcome;
  }
  return null;
}

function statusAuditReason(input: BackgroundProposalJobInput): string | null {
  if (input.status === "failed") {
    return normalizeOptionalReason(input.failure_reason) ?? "background_job_failed";
  }
  if (input.status === "degraded") {
    return normalizeOptionalReason(input.degraded_reason) ?? "background_job_degraded";
  }
  return null;
}

function normalizeOptionalReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null || reason.trim().length === 0) {
    return null;
  }
  return reason;
}

function uniqueTextValues(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(isNonEmptyText))];
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
