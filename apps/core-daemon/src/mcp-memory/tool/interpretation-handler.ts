import {
  SoulInterpretationResponseSchema,
  type SourceReferenceCatalog,
  type SourceSemanticPublishedInterpretation,
  type SourceSemanticWorkerRequest,
  type SourceSemanticWorkerResult,
  type SoulInterpretationRequest,
  type SoulInterpretationResponse
} from "@do-soul/alaya-protocol";
import { CoreError } from "@do-soul/alaya-core";
import { throwIfAborted } from "@do-soul/alaya-engine-gateway";
import { ToolUnavailableError, ToolValidationError } from "./tool-handler-support.js";
import type { McpMemoryToolCallContext } from "./tool-handler-types.js";

const IDLE = {
  discovery: "unexercised",
  h: "unexercised",
  q: "unexercised",
  a: "unexercised",
  computation: "unexercised",
  payload: "complete"
} as const;

const ZERO_WORK = {
  native_work: 0,
  native_bytes: 0,
  logical_memory_bytes: 0,
  rss_bytes: 0
} as const;

type PreparedSource = Readonly<{
  source_id: string;
  source_version: string;
  content_digest: string;
  catalog: SourceReferenceCatalog;
  workspaceId: string;
  principal: string;
}>;

export type SourceSemanticHostPort = Readonly<{
  execute(input: Readonly<{
    workspace_id: string;
    as_of: string;
    authorized_scopes: { readonly mode: "unrestricted" };
    principal?: string;
    expires_at?: string;
    request: SourceSemanticWorkerRequest;
  }>): Promise<SourceSemanticWorkerResult>;
}>;

export type SourceSemanticPublicationPort = Readonly<{
  publish(input: Readonly<{
    workspaceId: string;
    runId: string;
    artifactKey: string;
    source: string;
    catalog: SourceReferenceCatalog;
    provenance: Readonly<{
      producer_id: string;
      principal?: string;
      preparation_handle?: string;
    }>;
    draft: unknown;
    producer_version: string;
    contract_version: string;
  }>): Promise<Readonly<{
    bound: SourceSemanticPublishedInterpretation;
    evidence: Readonly<{ object_id: string }>;
  }>>;
  resolveSource(workspaceId: string, sourceId: string, contentDigest: string): Readonly<{
    content_bytes: string;
  }>;
}>;

export function createSourceSemanticInterpretationHandler(input: Readonly<{
  readonly now: () => string;
  readonly sourceSemanticsPort?: SourceSemanticHostPort;
  readonly publication?: SourceSemanticPublicationPort;
}>): (
  request: SoulInterpretationRequest,
  context: McpMemoryToolCallContext
) => Promise<SoulInterpretationResponse> {
  const prepared = new Map<string, PreparedSource>();
  return async (request, context) => {
    throwIfAborted(context.abortSignal);
    if (request.operation === "prepare_source") {
      return await prepareSource(input, request, context, prepared);
    }
    if (request.operation === "propose") {
      return await propose(input, request, context, prepared);
    }
    if (request.operation === "prepare_query") {
      return await prepareQuery(input, request, context);
    }
    return await reason(input, request, context);
  };
}

async function prepareSource(
  input: Readonly<{ now: () => string; sourceSemanticsPort?: SourceSemanticHostPort }>,
  request: Extract<SoulInterpretationRequest, { operation: "prepare_source" }>,
  context: McpMemoryToolCallContext,
  prepared: Map<string, PreparedSource>
): Promise<SoulInterpretationResponse> {
  try {
    const result = await executeWorker(input, context, {
      kind: "prepare_source",
      source_id: request.source_id,
      budget: request.budget
    });
    if (result.kind === "prepare_source") {
      prepared.set(result.source_handle, {
        source_id: result.source_id,
        source_version: result.source_version,
        content_digest: result.content_digest,
        catalog: result.catalog,
        workspaceId: context.workspaceId,
        principal: context.agentTarget
      });
    }
    return mcpFromWorker(result);
  } catch (error) {
    if (isMissingSource(error)) {
      return SoulInterpretationResponseSchema.parse({
        operation: "prepare_source",
        outcome: { status: "no_eligible_source", provider_attempts: 0 },
        coverage: { ...IDLE, discovery: "complete" },
        work: ZERO_WORK,
        provider_attempts: 0
      });
    }
    throw error;
  }
}

async function propose(
  input: Readonly<{
    now: () => string;
    sourceSemanticsPort?: SourceSemanticHostPort;
    publication?: SourceSemanticPublicationPort;
  }>,
  request: Extract<SoulInterpretationRequest, { operation: "propose" }>,
  context: McpMemoryToolCallContext,
  prepared: Map<string, PreparedSource>
): Promise<SoulInterpretationResponse> {
  const publication = requirePublication(input.publication);
  if (context.runId === null) {
    throw new ToolValidationError("soul.interpretation propose requires a runId in the MCP call context.");
  }
  const handle = prepared.get(request.source_handle);
  if (handle === undefined || handle.workspaceId !== context.workspaceId || handle.principal !== context.agentTarget) {
    return SoulInterpretationResponseSchema.parse({
      operation: "propose",
      outcome: { status: "invalid", reason: "expired_handle" },
      coverage: IDLE,
      work: ZERO_WORK,
      provider_attempts: 0
    });
  }
  try {
    await executeWorker(input, context, {
      kind: "prepare_query",
      original_query: handle.source_id,
      source_handle: request.source_handle,
      budget: {
        schema_version: 1, work_units: 32, memory_bytes: 65536,
        page_budget: 32, finalization_reserve: 8, min_envelope: 10
      }
    });
  } catch (error) {
    if (isExpiredHandle(error)) {
      prepared.delete(request.source_handle);
      return SoulInterpretationResponseSchema.parse({
        operation: "propose",
        outcome: { status: "invalid", reason: "expired_handle" },
        coverage: IDLE,
        work: ZERO_WORK,
        provider_attempts: 0
      });
    }
    throw error;
  }
  try {
    const stored = publication.resolveSource(context.workspaceId, handle.source_id, handle.content_digest);
    const published = await publication.publish({
      workspaceId: context.workspaceId,
      runId: context.runId,
      artifactKey: handle.source_id,
      source: stored.content_bytes,
      catalog: handle.catalog,
      provenance: {
        producer_id: request.producer_id,
        principal: context.agentTarget,
        preparation_handle: request.source_handle
      },
      draft: request.draft,
      producer_version: request.producer_version,
      contract_version: request.contract_version
    });
    return SoulInterpretationResponseSchema.parse({
      operation: "propose",
      outcome: {
        status: "interpreted",
        gaps: published.bound.interpretation.gaps
      },
      published: published.bound,
      evidence_object_id: published.evidence.object_id,
      coverage: { ...IDLE, discovery: "complete", h: "complete" },
      work: ZERO_WORK,
      provider_attempts: 0
    });
  } catch (error) {
    if (error instanceof CoreError && error.code === "VALIDATION") {
      return SoulInterpretationResponseSchema.parse({
        operation: "propose",
        outcome: { status: "invalid", reason: invalidReason(error.message) },
        coverage: { ...IDLE, discovery: "complete" },
        work: ZERO_WORK,
        provider_attempts: 0
      });
    }
    throw error;
  }
}

async function prepareQuery(
  input: Readonly<{ now: () => string; sourceSemanticsPort?: SourceSemanticHostPort }>,
  request: Extract<SoulInterpretationRequest, { operation: "prepare_query" }>,
  context: McpMemoryToolCallContext
): Promise<SoulInterpretationResponse> {
  return mcpFromWorker(await executeWorker(input, context, {
    kind: "prepare_query",
    original_query: request.original_query,
    budget: request.budget,
    ...(request.q === undefined ? {} : { q: request.q }),
    ...(request.source_handle === undefined ? {} : { source_handle: request.source_handle })
  }));
}

async function reason(
  input: Readonly<{ now: () => string; sourceSemanticsPort?: SourceSemanticHostPort }>,
  request: Extract<SoulInterpretationRequest, { operation: "reason" }>,
  context: McpMemoryToolCallContext
): Promise<SoulInterpretationResponse> {
  if (request.a === undefined) {
    const missing = request.q === undefined && request.query_handle === undefined ? "q_and_a" : "a";
    return SoulInterpretationResponseSchema.parse({
      operation: "reason",
      outcome: { status: "preparation_required", missing },
      coverage: { ...IDLE, a: "open" },
      work: ZERO_WORK,
      provider_attempts: 0
    });
  }
  const leased = request.query_handle !== undefined;
  const oneshot = request.h_id !== undefined && request.q !== undefined && request.original_query !== undefined;
  if (!leased && !oneshot) {
    return SoulInterpretationResponseSchema.parse({
      operation: "reason",
      outcome: { status: "preparation_required", missing: "q" },
      coverage: { ...IDLE, q: "open" },
      work: ZERO_WORK,
      provider_attempts: 0
    });
  }
  return mcpFromWorker(await executeWorker(input, context, {
    kind: "reason",
    accepts_unreviewed_conditional_results: true,
    a: request.a,
    budget: request.budget,
    output_byte_limit: request.output_byte_limit,
    ...(request.query_handle === undefined ? {} : { query_handle: request.query_handle }),
    ...(request.h_id === undefined ? {} : { h_id: request.h_id }),
    ...(request.q === undefined ? {} : { q: request.q }),
    ...(request.original_query === undefined ? {} : { original_query: request.original_query })
  }));
}

async function executeWorker(
  input: Readonly<{ now: () => string; sourceSemanticsPort?: SourceSemanticHostPort }>,
  context: McpMemoryToolCallContext,
  request: SourceSemanticWorkerRequest
): Promise<SourceSemanticWorkerResult> {
  const port = input.sourceSemanticsPort;
  if (port === undefined) {
    throw new ToolUnavailableError("soul.interpretation worker is not wired into this daemon");
  }
  const asOf = input.now();
  return await port.execute({
    workspace_id: context.workspaceId,
    as_of: asOf,
    authorized_scopes: { mode: "unrestricted" },
    principal: context.agentTarget,
    expires_at: new Date(Date.parse(asOf) + 10 * 60_000).toISOString(),
    request
  });
}

function mcpFromWorker(result: SourceSemanticWorkerResult): SoulInterpretationResponse {
  const { kind, ...rest } = result;
  return SoulInterpretationResponseSchema.parse({
    operation: kind,
    ...rest,
    provider_attempts: 0
  });
}

function requirePublication(publication: SourceSemanticPublicationPort | undefined): SourceSemanticPublicationPort {
  if (publication === undefined) {
    throw new ToolUnavailableError("soul.interpretation publication is not wired into this daemon");
  }
  return publication;
}

function isMissingSource(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not currently admitted|current source body is not available/u.test(message);
}

function isExpiredHandle(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /preparation handle expired|bound to another principal/u.test(message);
}

function invalidReason(message: string): "expired_handle" | "source_not_current" | "malformed_interpretation" {
  if (/expired|preparation handle/u.test(message)) return "expired_handle";
  if (/not current|not currently admitted/u.test(message)) return "source_not_current";
  return "malformed_interpretation";
}
