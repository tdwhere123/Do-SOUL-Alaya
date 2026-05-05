import {
  type ActivationCandidate,
  ComputeProviderRoutedPayloadSchema,
  RuntimeGovernanceEventType,
  type ComputeRoutingDecision,
  type EventLogEntry,
  type ExecutionStanceModelRef,
  type ExecutionStanceResolution
} from "@do-soul/alaya-protocol";

export interface ConversationExecutionStanceResolverParams {
  readonly workspaceId: string;
  readonly runId: string;
  readonly candidates: readonly Readonly<ActivationCandidate>[];
  readonly modelRef?: ExecutionStanceModelRef | null;
}

export interface ConversationExecutionStanceResolverPort {
  resolve(
    params: Readonly<ConversationExecutionStanceResolverParams>
  ): Promise<Readonly<ExecutionStanceResolution>>;
}

interface ComputeRoutingPort {
  route(workspaceId: string): Promise<Readonly<ComputeRoutingDecision>>;
  toModelRef(decision: Readonly<ComputeRoutingDecision>): ConversationExecutionStanceResolverParams["modelRef"];
}

interface ComputeRoutingEventLogWriterPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
}

interface StanceResolutionResolverPort {
  resolve(
    params: Readonly<ConversationExecutionStanceResolverParams>
  ): Promise<Readonly<ExecutionStanceResolution>>;
}

export interface ComputeRoutingExecutionStanceResolverDependencies {
  readonly computeRoutingService: ComputeRoutingPort;
  readonly eventLogWriter: ComputeRoutingEventLogWriterPort;
  readonly stanceResolutionService: StanceResolutionResolverPort;
}

export function createComputeRoutingExecutionStanceResolver(
  deps: ComputeRoutingExecutionStanceResolverDependencies
): ConversationExecutionStanceResolverPort {
  return {
    async resolve(
      params: Readonly<ConversationExecutionStanceResolverParams>
    ): Promise<Readonly<ExecutionStanceResolution>> {
      const decision = await deps.computeRoutingService.route(params.workspaceId);
      const resolution = await deps.stanceResolutionService.resolve({
        ...params,
        modelRef: deps.computeRoutingService.toModelRef(decision)
      });

      await deps.eventLogWriter.append({
        event_type: RuntimeGovernanceEventType.COMPUTE_PROVIDER_ROUTED,
        entity_type: "compute_provider_route",
        entity_id: decision.decision_id,
        workspace_id: params.workspaceId,
        run_id: params.runId,
        caused_by: "deterministic_rule",
        payload_json: ComputeProviderRoutedPayloadSchema.parse({
          decision_id: decision.decision_id,
          workspace_id: decision.workspace_id,
          selected_provider: decision.selected_provider,
          model_id: decision.model_id,
          selection_reason: decision.selection_reason,
          decided_at: decision.decided_at
        })
      });

      return resolution;
    }
  };
}
