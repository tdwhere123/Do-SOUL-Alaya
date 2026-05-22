import {
  SoulResolveRequestSchema,
  SoulResolveResponseSchema,
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
  // invariant: delivered object identities gate which objects the agent may
  // resolve against this delivery. Bare object_id is insufficient now that
  // memory_entry and synthesis_capsule can share an id in recall competition.
  readonly trustStateRecorder: {
    findDeliveryById(
      deliveryId: string
    ): Promise<Readonly<{
      readonly delivery_id: string;
      readonly agent_target: string;
      readonly workspace_id: string | null;
      readonly run_id: string | null;
      readonly delivered_object_ids: readonly string[];
      readonly delivered_objects?: readonly {
        readonly object_id: string;
        readonly object_kind: string;
      }[];
    }> | null>;
  };
  // invariant: indirect scope check for claim_form resolutions. Recall
  // delivers MemoryEntry rows; draft claim_form rows are not directly
  // deliverable but are reachable through their source_object_refs.
  // When target_object_id resolves to a claim_form and at least one of
  // its source_object_refs was delivered as a memory_entry, the agent has
  // legitimate context to resolve the claim. Absent reader degrades to
  // direct memory_entry-membership only.
  // see also: packages/protocol/src/soul/recall-candidate.ts
  //   (object_kind = "memory_entry")
  readonly claimSourceReader?: {
    findSourceObjectRefs(targetObjectId: string): Promise<readonly string[] | null>;
  };
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
      await assertDeliveryInScope(
        deps.trustStateRecorder,
        deps.claimSourceReader,
        request.delivery_id,
        request.target_object_id,
        context
      );
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
        ...(request.policy_classification === undefined
          ? {}
          : { policyClassification: request.policy_classification })
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

async function assertDeliveryInScope(
  trustStateRecorder: SoulResolveHandlerDependencies["trustStateRecorder"],
  claimSourceReader: SoulResolveHandlerDependencies["claimSourceReader"],
  deliveryId: string,
  targetObjectId: string,
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
  // invariant: agent may only resolve objects the cited delivery
  // actually delivered. Anything else is scope-confusion: a valid
  // delivery_id paired with an arbitrary target_object_id would let
  // the agent mutate workspace objects it never saw via recall.
  const sourceRefs =
    claimSourceReader === undefined
      ? null
      : await claimSourceReader.findSourceObjectRefs(targetObjectId);
  const targetObjectKind = sourceRefs === null ? "memory_entry" : "claim_form";

  if (isDeliveredObjectInScope(delivery, targetObjectId, targetObjectKind)) {
    return;
  }
  // invariant: indirect scope path — recall delivers MemoryEntry rows,
  // but a draft claim_form is reachable through its source_object_refs.
  // If the target is a claim whose source memories intersect what was
  // delivered, the agent has legitimate context to resolve it.
  if (sourceRefs !== null) {
    if (sourceRefs.some((ref) => isDeliveredObjectInScope(delivery, ref, "memory_entry"))) {
      return;
    }
  }
  // The kind is named so an operator sees WHICH (object_id, object_kind)
  // tuple was checked: a same-id synthesis_capsule can be in the delivery
  // yet still fail here because only memory_entry / claim_form targets are
  // resolvable.
  throw new SoulResolveScopeError(
    "VALIDATION",
    `target_object_id ${targetObjectId} (${targetObjectKind}) was not in the resolvable scope of delivery ${deliveryId}`
  );
}

function isDeliveredObjectInScope(
  delivery: Readonly<{
    readonly delivered_object_ids: readonly string[];
    readonly delivered_objects?: readonly {
      readonly object_id: string;
      readonly object_kind: string;
    }[];
  }>,
  objectId: string,
  objectKind: string
): boolean {
  if (delivery.delivered_objects === undefined) {
    return delivery.delivered_object_ids.includes(objectId);
  }
  return delivery.delivered_objects.some(
    (object) =>
      object.object_id === objectId &&
      object.object_kind === objectKind
  );
}
