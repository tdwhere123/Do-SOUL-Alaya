import { sourceDisclosure, sourceSemanticExecution, SoulInterpretationResponseSchema, verifySourceSemanticDisposition, SourceSemanticHostBoundDraftSchema, SourceSemanticWorkerWorkSchema, SourceSemanticResourceLedger, SourceSemanticResourceExhausted, sourceReferencePreparationCost, type SourceReferenceCatalog, type SourceSemanticPublishedInterpretation,
  type SourceSemanticWorkerRequest, type SourceSemanticWorkerResult, type SourceSemanticInterpretation, type SoulInterpretationRequest,
  type SoulInterpretationResponse, type RequestBudget, type SourceSemanticWorkerWork, type SourceSemanticReadableWorkerRequest,
  type AuthorizedScopesAdmission, type SourceRecordIdentity, type SourceInterpretationInvalidation,
  type SourceInterpretationInvalidationResult } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION } from "@do-soul/alaya-protocol";
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
  acknowledge?: import("../../runtime/recall/recall-read-worker-client.js").SourceSemanticsExecutionPort["acknowledge"];
  discard?(preparationId: string): Promise<void>;
}>;
export type SourceSemanticPublicationPort = Readonly<{
  invalidate?(input: Readonly<{ request: SourceInterpretationInvalidation; budget: RequestBudget }>): Promise<Readonly<{
    invalidation: SourceInterpretationInvalidationResult;
    resource_usage: Readonly<{ work_units: number; memory_bytes: number; native_work: number; native_bytes: number }>;
  }>>;
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
    if (request.operation === "invalidate") return invalidate(input, request, context);
    if (request.operation === "reason" && request.source_interpretation_id === undefined &&
        request.semantic_correspondence === undefined) {
      const result = { kind: "reason" as const, execution: sourceSemanticExecution(),
        result: { contract: "source-interpretation-reasoning-v5" as const, semantic_status: "unreviewed" as const,
          conclusion_scope: "conditional_on_interpretation" as const, world_claim: "unknown" as const,
          outcome: { status: "preparation_required" as const,
            missing: request.query_semantics === undefined && request.query_handle === undefined
              ? "query_semantics_and_correspondence" as const : "semantic_correspondence" as const }, consumed_leaves: [] },
        source_disclosure: projectSourceDisclosure({ material_kind: "interpretation",
          evaluated_as_of: input.interpretationClock ?? input.now() }), coverage: IDLE, work: ZERO_WORK };
      return mcpFromWorker(finalizeSourceSemanticReason(result, request.output_byte_limit,
        value => JSON.stringify(mcpFromWorker(value))));
    }
    const { operation, authorized_scopes, ...rest } = request;
    try {
      const result = await executeWorker(input, context, { kind: operation, ...rest } as SourceSemanticWorkerRequest,
        authorized_scopes ?? { mode: "unrestricted" });
      const fitted = request.operation === "reason" && result.kind === "reason"
        ? finalizeSourceSemanticReason(result, request.output_byte_limit, value => JSON.stringify(mcpFromWorker(value))) : result;
      return await settleRecallPage(input.sourceSemanticsPort, fitted, context.abortSignal);
    } catch (error) {
      if (request.operation === "prepare_source" && error instanceof CoreError) {
        const work = measuredFailure(error);
        if (error.subCode === "RETRYABLE_BACKPRESSURE") {
          return SoulInterpretationResponseSchema.parse({ execution: sourceSemanticExecution(), operation: request.operation,
            outcome: { status: "resource_exhausted" }, coverage: IDLE, work });
        }
        if (error.code === "NOT_FOUND" || admissionOf(error) === "no_eligible_source") {
          return SoulInterpretationResponseSchema.parse({ execution: sourceSemanticExecution(), operation: request.operation,
            outcome: { status: "no_eligible_source", provider_attempts: 0 }, coverage: { ...IDLE, discovery: "complete" }, work });
        }
        if (admissionOf(error) === "unavailable") {
          return SoulInterpretationResponseSchema.parse({ execution: sourceSemanticExecution(), operation: request.operation,
            outcome: { status: "unavailable", reason: unavailableReason(error) }, coverage: { ...IDLE, discovery: "open" }, work });
        }
      }
      throw error;
    }
  };
}

async function invalidate(input: Dependencies, request: Extract<SoulInterpretationRequest, { operation: "invalidate" }>,
  context: McpMemoryToolCallContext): Promise<SoulInterpretationResponse> {
  if (input.publication?.invalidate === undefined) throw new ToolUnavailableError("soul.interpretation invalidation is not wired into this daemon");
  if (context.runId === null) throw new ToolValidationError("soul.interpretation invalidate requires a runId in the MCP call context.");
  const authorizedScopes = request.authorized_scopes ?? { mode: "unrestricted" as const };
  let preparedWork: SourceSemanticWorkerWork = ZERO_WORK;
  try {
    const prepared = await executeWorker(input, context, { kind: "validate_source", source_handle: request.source_handle,
      budget: request.budget }, authorizedScopes);
    if (prepared.kind !== "validate_source") throw new CoreError("OBLIGATION_VIOLATION", "worker returned the wrong preparation operation");
    preparedWork = prepared.work;
    throwIfAborted(context.abortSignal);
    const usedWork = preparedWork.logical_work ?? preparedWork.native_work;
    const remaining = { ...request.budget, work_units: request.budget.work_units - usedWork,
      memory_bytes: request.budget.memory_bytes - preparedWork.logical_memory_bytes };
    if (remaining.work_units < 0 || remaining.memory_bytes < 0) throw new SourceSemanticResourceExhausted("invalidation preparation");
    const committed = await input.publication.invalidate({ budget: remaining, request: {
      workspace_id: context.workspaceId, run_id: context.runId, source_interpretation_id: request.source_interpretation_id,
      source: { source_id: prepared.source_id, source_version: prepared.source_version, content_digest: prepared.content_digest },
      error_basis: request.error_basis,
      provenance: { reporter_id: request.reporter_id, principal: context.agentTarget, preparation_handle: request.source_handle },
      authorized_scopes: authorizedScopes } });
    return SoulInterpretationResponseSchema.parse({ execution: sourceSemanticExecution(), operation: "invalidate", invalidation: committed.invalidation,
      coverage: { ...IDLE, discovery: "complete", source_interpretation: "open" },
      work: { ...preparedWork, native_work: preparedWork.native_work + committed.resource_usage.native_work,
        native_bytes: preparedWork.native_bytes + committed.resource_usage.native_bytes,
        logical_work: usedWork + committed.resource_usage.work_units,
        logical_memory_bytes: preparedWork.logical_memory_bytes + committed.resource_usage.memory_bytes } });
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted || error instanceof CoreError && error.subCode === "RETRYABLE_BACKPRESSURE")) throw error;
    const failed: SourceSemanticWorkerWork = error instanceof CoreError ? measuredFailure(error) : ZERO_WORK;
    return SoulInterpretationResponseSchema.parse({ execution: sourceSemanticExecution(), operation: "invalidate", outcome: { status: "resource_exhausted" },
      coverage: IDLE, work: {
        native_work: preparedWork.native_work + failed.native_work, native_bytes: preparedWork.native_bytes + failed.native_bytes,
        logical_work: (preparedWork.logical_work ?? preparedWork.native_work) + (failed.logical_work ?? failed.native_work),
        logical_memory_bytes: preparedWork.logical_memory_bytes + failed.logical_memory_bytes,
        rss_bytes: Math.max(preparedWork.rss_bytes, failed.rss_bytes) } });
  }
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
      return SoulInterpretationResponseSchema.parse({ execution: sourceSemanticExecution(), operation: "propose", outcome, semantic_status: "unreviewed",
        source_disclosure: projectSourceDisclosure({ material_kind: "interpretation",
          evaluated_as_of: sourceDisclosure(prepared.source_disclosure).evaluated_as_of,
          source: checkedSourceFromDisclosure(prepared.source_disclosure) }),
        source_binding: { source_id: prepared.source_id, source_version: prepared.source_version, content_digest: prepared.content_digest,
          attribution_context: prepared.attribution_context },
        coverage: { ...IDLE, discovery: "complete", source_interpretation: "open" }, work: { ...prepared.work, logical_work: preparedWork.logical_work + meter.spentWork, logical_memory_bytes: prepared.work.logical_memory_bytes + meter.spentBytes } });
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
    return SoulInterpretationResponseSchema.parse({ execution: sourceSemanticExecution(), operation: "propose",
      outcome: { status: "interpreted", gaps: published.bound.interpretation.gaps }, published: published.bound,
      source_disclosure: projectSourceDisclosure({ material_kind: "interpretation", evaluated_as_of: input.interpretationClock ?? input.now(),
        ...(published.source_record === undefined ? { source: checkedSourceFromDisclosure(prepared.source_disclosure) }
          : { source: published.source_record }) }),
      evidence_object_id: published.evidence.object_id, coverage: { ...IDLE, discovery: "complete", source_interpretation: "open" },
      work: { ...prepared.work, native_work: prepared.work.native_work + (published.resource_usage?.native_work ?? 0),
        native_bytes: prepared.work.native_bytes + (published.resource_usage?.native_bytes ?? 0), logical_work: usedWork + (published.resource_usage?.work_units ?? 0),
        logical_memory_bytes: prepared.work.logical_memory_bytes + (published.resource_usage?.memory_bytes ?? 0) } });
  } catch (error) {
    const secondary = error instanceof CoreError ? measuredFailure(error) : { ...ZERO_WORK,
      logical_work: dispositionMeter?.spentWork ?? 0, logical_memory_bytes: dispositionMeter?.spentBytes ?? 0 };
    const work = { native_work: preparedWork.native_work + secondary.native_work,
      native_bytes: preparedWork.native_bytes + secondary.native_bytes,
      logical_work: preparedWork.logical_work + (secondary.logical_work ?? secondary.native_work),
      logical_memory_bytes: preparedWork.logical_memory_bytes + secondary.logical_memory_bytes,
      rss_bytes: Math.max(preparedWork.rss_bytes, secondary.rss_bytes) };
    if (error instanceof SourceSemanticResourceExhausted || error instanceof CoreError && error.subCode === "RETRYABLE_BACKPRESSURE") {
      return SoulInterpretationResponseSchema.parse({ execution: sourceSemanticExecution(), operation: "propose", outcome: { status: "resource_exhausted" },
        coverage: IDLE, work });
    }
    if (error instanceof CoreError && admissionOf(error) === "unavailable") {
      return SoulInterpretationResponseSchema.parse({ execution: sourceSemanticExecution(), operation: "propose",
        outcome: { status: "unavailable", reason: unavailableReason(error) }, coverage: { ...IDLE, discovery: "open" }, work });
    }
    if (error instanceof CoreError && error.code === "VALIDATION") {
      const admission = admissionOf(error);
      const reason = admission === "expired" ? "expired_handle"
        : admission === "filtered" || admission === "no_eligible_source" ? "source_not_current" : "malformed_interpretation";
      return SoulInterpretationResponseSchema.parse({ execution: sourceSemanticExecution(), operation: "propose", outcome: { status: "invalid", reason },
        coverage: IDLE, work });
    }
    throw error;
  }
}

function checkedSourceFromDisclosure(wire: Extract<SourceSemanticWorkerResult, { kind: "validate_source" }>["source_disclosure"]):
  Parameters<typeof projectSourceDisclosure>[0]["source"] {
  const disclosure = sourceDisclosure(wire);
  if (disclosure.source_binding === "unbound") return undefined;
  const sourceTime = disclosure.source_time;
  const event_time = sourceTime?.kind === "known" ? { event_time: sourceTime.at }
    : sourceTime?.reason === "not_recorded" ? { event_time: null } : {};
  const metadata = { ...event_time,
    ...(disclosure.source_representation === undefined ? {} : { source_representation: disclosure.source_representation }) };
  const validity = disclosure.validity;
  if (validity.kind === "bounded") return { ...metadata, valid_from: validity.from, valid_to: validity.to_exclusive };
  if (validity.kind === "open") return { ...metadata, valid_from: validity.from, valid_to: null };
  return validity.reason === "not_recorded" ? { ...metadata, valid_from: null, valid_to: null } : metadata;
}

async function executeWorker(input: Dependencies, context: McpMemoryToolCallContext, request: SourceSemanticWorkerRequest,
  authorized_scopes: AuthorizedScopesAdmission): Promise<SourceSemanticWorkerResult> {
  if (input.sourceSemanticsPort === undefined) throw new ToolUnavailableError("soul.interpretation worker is not wired into this daemon");
  return input.sourceSemanticsPort.execute(buildSourceSemanticWorkerPayload(input, context, request, authorized_scopes));
}

/** Pure private payload construction shared by the handler and guarded acquisition consumer. */
export function buildSourceSemanticWorkerPayload<Request extends SourceSemanticReadableWorkerRequest>(input: Pick<Dependencies, "now" | "interpretationClock">,
  context: Pick<McpMemoryToolCallContext, "workspaceId" | "agentTarget" | "sessionId" | "runId">,
  request: Request, authorized_scopes: AuthorizedScopesAdmission) {
  const now = input.now();
  return { workspace_id: context.workspaceId, as_of: input.interpretationClock ?? now, lifetime_now: now,
    authorized_scopes, principal: JSON.stringify([context.agentTarget, context.sessionId, context.runId]),
    expires_at: new Date(Date.parse(now) + 600_000).toISOString(), request };
}
/** The library page is prepared by the worker's delivery owner: the public
 * envelope must encode before the page is acknowledged, and a failed encode
 * discards it rather than leaving an unissued preparation. A cancellation that
 * arrives after the worker prepared the page must discard it instead of
 * acknowledging exposure the caller already abandoned.
 */
async function settleRecallPage(port: SourceSemanticHostPort | undefined,
  result: SourceSemanticWorkerResult, signal?: AbortSignal): Promise<SoulInterpretationResponse> {
  if (result.kind !== "recall" || result.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION
    || result.preparation_id === undefined) return mcpFromWorker(result);
  if (port?.acknowledge === undefined || port.discard === undefined) {
    throw new CoreError("OBLIGATION_VIOLATION", "library delivery acknowledgment port missing");
  }
  let response: SoulInterpretationResponse;
  try {
    response = mcpFromWorker(result);
  } catch (error) {
    await port.discard(result.preparation_id);
    throw error;
  }
  // Encoding is local; acknowledgement is the exposure boundary. Do not publish a
  // page the caller cancelled, and keep the incurred execution cost on the refusal.
  if (signal?.aborted === true) {
    await port.discard(result.preparation_id);
    attachIncurredWork(signal.reason, result.work);
    throwIfAborted(signal);
  }
  const index = "index" in response && response.index !== undefined ? response.index : result.index;
  try {
    // The acknowledgment adapter preserves its final receipt independently in the
    // request-scoped observation channel. Do not rewrite this fitted preparation
    // envelope or add physical visits to its logical preparation work.
    await port.acknowledge(result.preparation_id, index,
      new Map(Object.entries(result.previews ?? {})), signal);
  } catch (error) {
    attachIncurredWork(error, result.work);
    // Only the worker can decide whether cancellation beat issuance. A transport
    // failure is unknown, not permission to claim rollback or successful discard.
    throw error;
  }
  return response;
}

/** Cancellation is not a free request: the envelope keeps its incurred work. */
function attachIncurredWork(reason: unknown, work: SourceSemanticWorkerWork): void {
  if (!(reason instanceof Error)) return;
  const target = reason as Error & { details?: Readonly<Record<string, unknown>> };
  const details = target.details ?? {};
  if (Object.prototype.hasOwnProperty.call(details, "work")) return;
  try { target.details = Object.freeze({ ...details, work }); } catch { /* Classification wins. */ }
}

/** Private bench feedback projection also consumes this conversion, never another worker call. */
export function mcpFromWorker(result: SourceSemanticWorkerResult): SoulInterpretationResponse {
  if (result.kind === "validate_source") throw new CoreError("OBLIGATION_VIOLATION", "internal preparation cannot escape as an MCP response");
  if (result.kind === "recall") {
    return encodeSourceSemanticLibraryResponse(result);
  }
  if (result.execution === undefined) throw new CoreError("VALIDATION", "Source worker v2 requires actual execution accounting");
  const { kind, ...rest } = result;
  return SoulInterpretationResponseSchema.parse({ operation: kind, ...rest });
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
