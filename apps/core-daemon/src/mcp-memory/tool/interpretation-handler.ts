import { SoulInterpretationResponseSchema, verifySourceSemanticDisposition, SourceSemanticHostBoundDraftSchema, SourceSemanticWorkerWorkSchema, SourceSemanticResourceLedger, SourceSemanticResourceExhausted, sourceReferencePreparationCost, type SourceReferenceCatalog, type SourceSemanticPublishedInterpretation,
  type SourceSemanticWorkerRequest, type SourceSemanticWorkerResult, type SourceSemanticInterpretation, type SoulInterpretationRequest,
  type SoulInterpretationResponse, type RequestBudget, type SourceSemanticWorkerWork,
  type AuthorizedScopesAdmission, type SourceRecordIdentity } from "@do-soul/alaya-protocol";
import { CoreError, encodeSourceSemanticLibraryResponse, fieldContractSha256, projectSourceDisclosure } from "@do-soul/alaya-core";
import { finalizeSourceSemanticReason } from "../../runtime/recall-read-worker/source-semantic-reason-finalization.js";
import { throwIfAborted } from "@do-soul/alaya-engine-gateway";
import { ToolUnavailableError, ToolValidationError } from "./tool-handler-support.js";
import type { McpMemoryToolCallContext } from "./tool-handler-types.js";

const IDLE = {
  discovery: "unexercised", source_interpretation: "unexercised", query_semantics: "unexercised",
  semantic_correspondence: "unexercised", conditional_computation: "unexercised", payload: "complete"
} as const;
const ZERO_WORK = { native_work: 0, native_bytes: 0, logical_memory_bytes: 0, rss_bytes: 0 } as const;
const DEFAULT_BUDGET: RequestBudget = { schema_version: 1, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 };

export type SourceSemanticHostPort = Readonly<{
  execute(input: Readonly<{ workspace_id: string; as_of: string; authorized_scopes: AuthorizedScopesAdmission;
    principal?: string; expires_at?: string; lifetime_now?: string; request: SourceSemanticWorkerRequest }>): Promise<SourceSemanticWorkerResult>;
}>;
export type SourceSemanticPublicationPort = Readonly<{
  publish(input: Readonly<{
    workspaceId: string; runId: string; artifactKey: string; source: string; catalog: SourceReferenceCatalog;
    assertion_locations: NonNullable<SourceSemanticInterpretation["source"]["assertion_locations"]>;
    attribution_context: SourceSemanticInterpretation["source"]["attribution_context"];
    provenance: Readonly<{ producer_id: string; principal?: string; preparation_handle?: string }>;
    draft: unknown; producer_version: string; contract_version: string; budget?: RequestBudget;
  }>): Promise<Readonly<{ bound: SourceSemanticPublishedInterpretation; evidence: Readonly<{ object_id: string }>;
    source_record?: SourceRecordIdentity;
    resource_usage?: Readonly<{ work_units: number; memory_bytes: number; native_work?: number; native_bytes?: number }> }>>;
}>;
type Dependencies = Readonly<{ now: () => string; interpretationClock?: string; sourceSemanticsPort?: SourceSemanticHostPort; publication?: SourceSemanticPublicationPort }>;

/** Preparation state lives in the bounded worker owner, never in a second main-thread catalog map. */
export function createSourceSemanticInterpretationHandler(input: Dependencies):
(request: SoulInterpretationRequest, context: McpMemoryToolCallContext) => Promise<SoulInterpretationResponse> {
  return async (request, context) => {
    throwIfAborted(context.abortSignal);
    if (request.operation === "propose") return propose(input, request, context);
    if (request.operation === "reason" && request.source_interpretation_id === undefined &&
        request.semantic_correspondence === undefined) {
      return SoulInterpretationResponseSchema.parse({ operation: "reason",
        outcome: { status: "preparation_required", missing: request.semantic_correspondence === undefined ? request.query_semantics === undefined && request.query_handle === undefined ? "query_semantics_and_correspondence" : "semantic_correspondence" : "query_semantics" },
        coverage: IDLE, work: ZERO_WORK, provider_attempts: 0 });
    }
    const { operation, authorized_scopes, ...rest } = request;
    try {
      const result = await executeWorker(input, context, { kind: operation, ...rest } as SourceSemanticWorkerRequest,
        authorized_scopes ?? { mode: "unrestricted" });
      const fitted = request.operation === "reason" && result.kind === "reason"
        ? finalizeSourceSemanticReason(result, request.output_byte_limit, value => JSON.stringify(mcpFromWorker(value))) : result;
      return mcpFromWorker(fitted);
    } catch (error) {
      if (request.operation === "prepare_source" && error instanceof CoreError) {
        const work = measuredFailure(error);
        if (error.subCode === "RETRYABLE_BACKPRESSURE") {
          return SoulInterpretationResponseSchema.parse({ operation: request.operation,
            outcome: { status: "resource_exhausted" }, coverage: IDLE, work, provider_attempts: 0 });
        }
        if (error.code === "NOT_FOUND" || admissionOf(error) === "no_eligible_source") {
          return SoulInterpretationResponseSchema.parse({ operation: request.operation,
            outcome: { status: "no_eligible_source", provider_attempts: 0 }, coverage: { ...IDLE, discovery: "complete" }, work, provider_attempts: 0 });
        }
        if (admissionOf(error) === "unavailable") {
          return SoulInterpretationResponseSchema.parse({ operation: request.operation,
            outcome: { status: "unavailable", reason: unavailableReason(error) }, coverage: { ...IDLE, discovery: "open" }, work, provider_attempts: 0 });
        }
      }
      throw error;
    }
  };
}

async function propose(input: Dependencies, request: Extract<SoulInterpretationRequest, { operation: "propose" }>,
  context: McpMemoryToolCallContext): Promise<SoulInterpretationResponse> {
  const publication = input.publication;
  if (publication === undefined) throw new ToolUnavailableError("soul.interpretation publication is not wired into this daemon");
  if (context.runId === null) throw new ToolValidationError("soul.interpretation propose requires a runId in the MCP call context.");
  const budget = request.budget ?? DEFAULT_BUDGET;
  let preparedWork: SourceSemanticWorkerWork & { logical_work: number } = { ...ZERO_WORK, logical_work: 0 };
  let dispositionMeter: SourceSemanticResourceLedger | undefined;
  try {
    const prepared = await executeWorker(input, context, { kind: "validate_source", source_handle: request.source_handle, budget },
      request.authorized_scopes ?? { mode: "unrestricted" });
    if (prepared.kind !== "validate_source") throw new CoreError("OBLIGATION_VIOLATION", "worker returned the wrong preparation operation");
    preparedWork = { ...prepared.work, logical_work: prepared.work.logical_work ?? prepared.work.native_work };
    if (request.disposition !== undefined) {
      const meter = new SourceSemanticResourceLedger({ work_units: budget.work_units - preparedWork.logical_work, memory_bytes: budget.memory_bytes - prepared.work.logical_memory_bytes });
      dispositionMeter = meter;
      const cost = sourceReferencePreparationCost(prepared.catalog.assertions.map((row) => ({ assertion_id: row.assertion_id, text: row.segments.map((part) => part.text).join("") })));
      meter.charge(cost.work_units, cost.memory_bytes, "disposition validation");
      const outcome = verifySourceSemanticDisposition(request.disposition, prepared.catalog, fieldContractSha256);
      return SoulInterpretationResponseSchema.parse({ operation: "propose", outcome, semantic_status: "unreviewed",
        source_disclosure: projectSourceDisclosure({ material_kind: "interpretation",
          evaluated_as_of: prepared.source_disclosure.evaluated_as_of,
          source: checkedSourceFromDisclosure(prepared.source_disclosure) }),
        source_binding: { source_id: prepared.source_id, source_version: prepared.source_version, content_digest: prepared.content_digest,
          attribution_context: prepared.attribution_context },
        coverage: { ...IDLE, discovery: "complete", source_interpretation: "open" }, work: { ...prepared.work, logical_work: preparedWork.logical_work + meter.spentWork, logical_memory_bytes: prepared.work.logical_memory_bytes + meter.spentBytes }, provider_attempts: 0 });
    }
    const usedWork = prepared.work.logical_work ?? prepared.work.native_work;
    const remaining = { ...budget, work_units: budget.work_units - usedWork,
      memory_bytes: budget.memory_bytes - prepared.work.logical_memory_bytes };
    if (remaining.work_units < 0 || remaining.memory_bytes < 0) throw new CoreError("CONFLICT", "publication preparation budget exhausted");
    const draft = request.generation_task === undefined || request.draft === undefined
      ? request.draft
      : SourceSemanticHostBoundDraftSchema.parse({ ...request.draft, generation_task: request.generation_task });
    const published = await publication.publish({ workspaceId: context.workspaceId, runId: context.runId,
      artifactKey: prepared.source_id, source: prepared.source, catalog: prepared.catalog,
      assertion_locations: prepared.assertion_locations, budget: remaining,
      attribution_context: prepared.attribution_context,
      provenance: { producer_id: request.producer_id, principal: context.agentTarget, preparation_handle: request.source_handle },
      draft, producer_version: request.producer_version, contract_version: request.contract_version });
    return SoulInterpretationResponseSchema.parse({ operation: "propose",
      outcome: { status: "interpreted", gaps: published.bound.interpretation.gaps }, published: published.bound,
      source_disclosure: projectSourceDisclosure({ material_kind: "interpretation", evaluated_as_of: input.interpretationClock ?? input.now(),
        ...(published.source_record === undefined ? { source: checkedSourceFromDisclosure(prepared.source_disclosure) }
          : { source: published.source_record }) }),
      evidence_object_id: published.evidence.object_id, coverage: { ...IDLE, discovery: "complete", source_interpretation: "open" },
      work: { ...prepared.work, native_work: prepared.work.native_work + (published.resource_usage?.native_work ?? 0),
        native_bytes: prepared.work.native_bytes + (published.resource_usage?.native_bytes ?? 0), logical_work: usedWork + (published.resource_usage?.work_units ?? 0),
        logical_memory_bytes: prepared.work.logical_memory_bytes + (published.resource_usage?.memory_bytes ?? 0) }, provider_attempts: 0 });
  } catch (error) {
    const secondary = error instanceof CoreError ? measuredFailure(error) : { ...ZERO_WORK,
      logical_work: dispositionMeter?.spentWork ?? 0, logical_memory_bytes: dispositionMeter?.spentBytes ?? 0 };
    const work = { native_work: preparedWork.native_work + secondary.native_work,
      native_bytes: preparedWork.native_bytes + secondary.native_bytes,
      logical_work: preparedWork.logical_work + (secondary.logical_work ?? secondary.native_work),
      logical_memory_bytes: preparedWork.logical_memory_bytes + secondary.logical_memory_bytes,
      rss_bytes: Math.max(preparedWork.rss_bytes, secondary.rss_bytes) };
    if (error instanceof SourceSemanticResourceExhausted || error instanceof CoreError && error.subCode === "RETRYABLE_BACKPRESSURE") {
      return SoulInterpretationResponseSchema.parse({ operation: "propose", outcome: { status: "resource_exhausted" },
        coverage: IDLE, work, provider_attempts: 0 });
    }
    if (error instanceof CoreError && admissionOf(error) === "unavailable") {
      return SoulInterpretationResponseSchema.parse({ operation: "propose",
        outcome: { status: "unavailable", reason: unavailableReason(error) }, coverage: { ...IDLE, discovery: "open" }, work, provider_attempts: 0 });
    }
    if (error instanceof CoreError && error.code === "VALIDATION") {
      const admission = admissionOf(error);
      const reason = admission === "expired" ? "expired_handle"
        : admission === "filtered" || admission === "no_eligible_source" ? "source_not_current" : "malformed_interpretation";
      return SoulInterpretationResponseSchema.parse({ operation: "propose", outcome: { status: "invalid", reason },
        coverage: IDLE, work, provider_attempts: 0 });
    }
    throw error;
  }
}

function checkedSourceFromDisclosure(disclosure: Extract<SourceSemanticWorkerResult, { kind: "validate_source" }>["source_disclosure"]):
  { event_time?: string | null; valid_from?: string | null; valid_to?: string | null } | undefined {
  if (disclosure.source_binding === "unbound") return undefined;
  const sourceTime = disclosure.source_time;
  const event_time = sourceTime?.kind === "known" ? { event_time: sourceTime.at }
    : sourceTime?.reason === "not_recorded" ? { event_time: null } : {};
  const validity = disclosure.validity;
  if (validity.kind === "bounded") return { ...event_time, valid_from: validity.from, valid_to: validity.to_exclusive };
  if (validity.kind === "open") return { ...event_time, valid_from: validity.from, valid_to: null };
  return validity.reason === "not_recorded" ? { ...event_time, valid_from: null, valid_to: null } : event_time;
}

async function executeWorker(input: Dependencies, context: McpMemoryToolCallContext, request: SourceSemanticWorkerRequest,
  authorized_scopes: AuthorizedScopesAdmission): Promise<SourceSemanticWorkerResult> {
  if (input.sourceSemanticsPort === undefined) throw new ToolUnavailableError("soul.interpretation worker is not wired into this daemon");
  const now = input.now();
  const asOf = input.interpretationClock ?? now;
  return input.sourceSemanticsPort.execute({ workspace_id: context.workspaceId, as_of: asOf,
    lifetime_now: now,
    authorized_scopes, principal: JSON.stringify([context.agentTarget, context.sessionId, context.runId]),
    expires_at: new Date(Date.parse(now) + 600_000).toISOString(), request });
}
function mcpFromWorker(result: SourceSemanticWorkerResult): SoulInterpretationResponse {
  if (result.kind === "validate_source") throw new CoreError("OBLIGATION_VIOLATION", "internal preparation cannot escape as an MCP response");
  if (result.kind === "recall") {
    return encodeSourceSemanticLibraryResponse(result);
  }
  const { kind, ...rest } = result;
  return SoulInterpretationResponseSchema.parse({ operation: kind, ...rest, provider_attempts: 0 });
}

function measuredFailure(error: CoreError): SourceSemanticWorkerWork {
  const parsed = SourceSemanticWorkerWorkSchema.safeParse(error.details?.work);
  return parsed.success ? parsed.data : ZERO_WORK;
}
function admissionOf(error: CoreError): string | undefined {
  const value = error.details?.admission;
  return typeof value === "string" ? value : undefined;
}
function unavailableReason(error: CoreError): string {
  const value = error.details?.unavailable;
  return typeof value === "string" && value.length > 0 ? value : "source_body";
}
