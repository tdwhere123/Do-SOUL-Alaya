import {
  SoulResolveRequestSchema,
  SoulResolveResponseSchema,
  type GovernanceResolutionPolicyClassification,
  type SoulResolveRequest,
  type SoulResolveResponse
} from "@do-soul/alaya-protocol";
import type { ResolutionService } from "@do-soul/alaya-core";

// invariant: trusted MCP call context fields the handler binds onto
// the protocol-stripped agent-facing request before calling
// ResolutionService.resolve. Mirrors the shape McpMemoryToolCallContext
// uses elsewhere in apps/core-daemon/src/mcp-memory-tool-handler.ts.
// see also: apps/core-daemon/src/mcp-memory-tool-handler.ts
//   McpMemoryToolCallContext
export interface SoulResolveCallContext {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly agentTarget: string;
}

export interface SoulResolveHandlerDependencies {
  readonly resolutionService: ResolutionService;
  readonly trustStateRecorder: {
    findDeliveryById(
      deliveryId: string
    ): Promise<Readonly<{
      readonly delivery_id: string;
      readonly agent_target: string;
      readonly workspace_id: string | null;
      readonly run_id: string | null;
    }> | null>;
  };
  // invariant: optional classification echo. The MCP layer does not
  // own GovernancePolicy state (that is per-turn agent-side or per
  // recall on the daemon-side); the resolve handler is given an
  // already-classified outcome by the caller when one exists so the
  // audit event can be correlated with the policy decision.
  readonly classifyResolution?: (
    request: SoulResolveRequest,
    context: SoulResolveCallContext
  ) => GovernanceResolutionPolicyClassification | undefined;
}

export class SoulResolveScopeError extends Error {
  public readonly code: "VALIDATION" | "NEEDS_CONTEXT";
  public constructor(code: "VALIDATION" | "NEEDS_CONTEXT", message: string) {
    super(message);
    this.code = code;
    this.name = "SoulResolveScopeError";
  }
}

export function createSoulResolveHandler(deps: SoulResolveHandlerDependencies) {
  return {
    async resolve(
      rawArguments: unknown,
      context: SoulResolveCallContext
    ): Promise<SoulResolveResponse> {
      const request = SoulResolveRequestSchema.parse(rawArguments);
      await assertDeliveryInScope(deps.trustStateRecorder, request.delivery_id, context);
      const outcome = await deps.resolutionService.resolve({
        targetObjectId: request.target_object_id,
        resolution: request.resolution,
        workspaceId: context.workspaceId,
        runId: context.runId,
        agentTarget: context.agentTarget,
        deliveryId: request.delivery_id,
        ...(request.policy === undefined ? {} : { policy: request.policy }),
        ...(request.correction === undefined ? {} : { correction: request.correction }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.defer_until === undefined ? {} : { deferUntil: request.defer_until }),
        ...buildClassification(deps, request, context)
      });
      return SoulResolveResponseSchema.parse({
        target_object_id: request.target_object_id,
        resolution: outcome.resolution,
        status: outcome.status,
        audit_event_type: outcome.auditEventType,
        audit_event_id: outcome.auditEventId,
        ...(outcome.obligationId === undefined ? {} : { obligation_id: outcome.obligationId }),
        ...(outcome.activatedClaimId === undefined
          ? {}
          : { activated_claim_id: outcome.activatedClaimId })
      });
    }
  };
}

function buildClassification(
  deps: SoulResolveHandlerDependencies,
  request: SoulResolveRequest,
  context: SoulResolveCallContext
): { readonly policyClassification?: GovernanceResolutionPolicyClassification } {
  if (deps.classifyResolution === undefined) {
    return {};
  }
  const classification = deps.classifyResolution(request, context);
  return classification === undefined ? {} : { policyClassification: classification };
}

async function assertDeliveryInScope(
  trustStateRecorder: SoulResolveHandlerDependencies["trustStateRecorder"],
  deliveryId: string,
  context: SoulResolveCallContext
): Promise<void> {
  const delivery = await trustStateRecorder.findDeliveryById(deliveryId);
  if (delivery === null) {
    throw new SoulResolveScopeError(
      "VALIDATION",
      `delivery_id ${deliveryId} is not a recorded recall delivery in this context`
    );
  }
  if (
    delivery.agent_target !== context.agentTarget ||
    delivery.workspace_id !== context.workspaceId ||
    delivery.run_id !== context.runId
  ) {
    throw new SoulResolveScopeError(
      "NEEDS_CONTEXT",
      `delivery_id ${deliveryId} is not in the calling agent's recall scope`
    );
  }
}
