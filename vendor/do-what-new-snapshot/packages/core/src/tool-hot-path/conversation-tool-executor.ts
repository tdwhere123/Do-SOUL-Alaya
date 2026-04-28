import { randomUUID } from "node:crypto";
import {
  ExtensionGovernanceCheckedPayloadSchema,
  PhaseCEventType,
  canonicalGovernanceSubject,
  type ConversationRuntimeContext,
  type GovernanceSubject,
  type RuntimeSessionConfig,
  type ToolProvider,
  type ToolGovernanceQuery,
  type ToolSpec
} from "@do-what/protocol";
import { deepFreeze } from "../shared/deep-freeze.js";
import type { CanonicalAliasService } from "../canonical-alias-service.js";
import type { ToolSpecService } from "../tool-spec-service.js";
import type { ToolExecutionContext, ToolSubstrate } from "../tool-substrate/index.js";
import type { ToolGovernanceClient } from "../ports/tool-governance-client.js";
import { ApprovalSink } from "./approval-sink.js";
import type { CircuitBreaker, CircuitBreakerState } from "./circuit-breaker.js";
import { ToolFastPath } from "./fast-path.js";
import { collectPathCandidates } from "./tool-path-guards.js";
import type {
  HotPathEventLogRepoPort,
  HotPathOutcomeRecorderPort,
  HotPathSseBroadcasterPort,
  HotPathToolExecutionRecordRepoPort,
  ToolHotPathStrongRefPort,
  ToolHotPathTargetRevalidatePort
} from "./hot-path-full.js";
import { ToolHotPathFull, type ToolHotPathExecuteResult } from "./hot-path-full.js";

export interface ConversationToolExecutorDependencies {
  readonly toolSpecService: Pick<ToolSpecService, "findById">;
  readonly substrate: ToolSubstrate;
  readonly governanceClient: ToolGovernanceClient;
  readonly fastPath: ToolFastPath;
  readonly targetRevalidateService: ToolHotPathTargetRevalidatePort;
  readonly strongRefService?: ToolHotPathStrongRefPort;
  readonly executionRecordRepo: HotPathToolExecutionRecordRepoPort;
  readonly eventLogRepo: HotPathEventLogRepoPort;
  readonly sseBroadcaster: HotPathSseBroadcasterPort;
  readonly circuitBreaker: Pick<CircuitBreaker, "getState" | "recordOutcome"> & HotPathOutcomeRecorderPort;
  readonly canonicalAliasService?: Pick<CanonicalAliasService, "publishGovernanceSubjectCanonicalization">;
  readonly extensionRegistry?: {
    findProviderForTool(toolId: string): Promise<Readonly<ToolProvider> | null>;
  };
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly now?: () => string;
  readonly generateExecutionId: () => string;
}

export interface ConversationToolExecutionRequest {
  readonly toolId: string;
  readonly rawInput: unknown;
  readonly runtimeContext: Readonly<ConversationRuntimeContext>;
  readonly workspaceRoot: string;
  readonly affectedPathRoots?: readonly string[];
  readonly handler: (ctx: Readonly<ToolExecutionContext>, input: unknown) => Promise<unknown>;
}

interface ExtensionGovernanceTrackingState {
  permissionCheckedRequired: boolean;
  permissionChecked: boolean;
  executionRecordedRequired: boolean;
  executionRecorded: boolean;
}

export class ConversationToolExecutor {
  public constructor(private readonly deps: ConversationToolExecutorDependencies) {}

  public async execute(
    request: Readonly<ConversationToolExecutionRequest>
  ): Promise<ToolHotPathExecuteResult> {
    const [toolSpec, extensionProvider] = await Promise.all([
      this.deps.toolSpecService.findById(request.toolId),
      this.deps.extensionRegistry === undefined
        ? Promise.resolve(null)
        : this.deps.extensionRegistry.findProviderForTool(request.toolId)
    ]);
    const governanceTracking = createExtensionGovernanceTrackingState(extensionProvider);
    const allowedMcpServers = resolveAllowedMcpServersForProvider(extensionProvider);
    const breakerState = this.deps.circuitBreaker.getState();
    const runtimeContext = request.runtimeContext;
    const nodeId = runtimeContext.assistant_message_id ?? runtimeContext.user_message_id;
    const governanceSubject =
      this.deps.canonicalAliasService === undefined
        ? createToolGovernanceSubject(toolSpec)
        : await this.deps.canonicalAliasService.publishGovernanceSubjectCanonicalization(
            "tooling.policy",
            {
              scope: toolSpec.scope_guard,
              tool: toolSpec.tool_id
            },
            {
              entityType: "tool_governance",
              entityId: createToolGovernanceEntityId(runtimeContext.run_id, nodeId),
              workspaceId: runtimeContext.workspace_id,
              runId: runtimeContext.run_id,
              causedBy: "principal",
              startingRevision: 0
            }
          );
    const governanceQuery = buildToolGovernanceQuery(toolSpec, request.rawInput, runtimeContext, governanceSubject);
    const hotPath = new ToolHotPathFull({
      substrate: this.deps.substrate,
      governanceClient: {
        query: async (query, trackedNodeId) => {
          const decision = await this.deps.governanceClient.query(query, trackedNodeId);
          governanceTracking.permissionChecked = true;
          return decision;
        }
      },
      targetRevalidateService: this.deps.targetRevalidateService,
      strongRefService: this.deps.strongRefService,
      fastPath: this.deps.fastPath,
      executionRecordRepo: {
        insert: async (record) => {
          const insertedRecord = await this.deps.executionRecordRepo.insert(record);
          governanceTracking.executionRecorded = true;
          return insertedRecord;
        }
      },
      eventLogRepo: this.deps.eventLogRepo,
      sseBroadcaster: this.deps.sseBroadcaster,
      approvalSink: new ApprovalSink({
        circuitBreaker: this.deps.circuitBreaker,
        runId: runtimeContext.run_id,
        workspaceId: runtimeContext.workspace_id,
        nodeId,
        governanceSubjectKey: governanceQuery.governance_subject.canonical_key
      }),
      outcomeRecorder: this.deps.circuitBreaker,
      now: this.deps.now,
      generateExecutionId: this.deps.generateExecutionId
    });

    try {
      const result = await hotPath.execute({
        toolSpec,
        rawInput: request.rawInput,
        governanceQueryBuilder: () => governanceQuery,
        sessionConfig: createToolSessionConfig(request.workspaceRoot, runtimeContext, allowedMcpServers),
        affectedPathRoots: request.affectedPathRoots,
        requestedBy: "principal",
        requestingRunId: runtimeContext.run_id,
        nodeId,
        stanceResolution: createCircuitBreakerStanceResolution(breakerState, this.now()),
        deniedToolCategories: breakerState.additionalDeniedCategories,
        handler: request.handler
      });
      await this.emitExtensionGovernanceCheckedEvent(
        extensionProvider,
        request.toolId,
        runtimeContext,
        governanceTracking
      );
      return result;
    } catch (error) {
      await this.emitExtensionGovernanceCheckedEvent(
        extensionProvider,
        request.toolId,
        runtimeContext,
        governanceTracking
      );
      throw error;
    }
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private async emitExtensionGovernanceCheckedEvent(
    provider: Readonly<ToolProvider> | null | undefined,
    toolId: string,
    runtimeContext: Readonly<ConversationRuntimeContext>,
    tracking: Readonly<ExtensionGovernanceTrackingState>
  ): Promise<void> {
    if (
      provider === null ||
      provider === undefined ||
      !isExternalProvider(provider) ||
      (tracking.permissionCheckedRequired && !tracking.permissionChecked) ||
      (tracking.executionRecordedRequired && !tracking.executionRecorded)
    ) {
      return;
    }

    try {
      const payload = deepFreeze(
        ExtensionGovernanceCheckedPayloadSchema.parse({
          tool_id: toolId,
          provider_id: provider.provider_id,
          permission_checked: tracking.permissionChecked,
          execution_recorded: tracking.executionRecorded,
          checked_at: this.now()
        })
      );
      const entry = await this.deps.eventLogRepo.append({
        event_type: PhaseCEventType.EXTENSION_GOVERNANCE_CHECKED,
        entity_type: "extension_provider",
        entity_id: provider.provider_id,
        workspace_id: runtimeContext.workspace_id,
        run_id: runtimeContext.run_id,
        caused_by: "principal",
        revision: 0,
        payload_json: payload
      });
      await this.deps.sseBroadcaster.broadcastEntry(entry);
    } catch (error) {
      this.deps.warn?.("failed to emit extension.governance_checked", {
        providerId: provider.provider_id,
        toolId,
        error
      });
    }
  }
}

function createToolSessionConfig(
  workspaceRoot: string,
  runtimeContext: Readonly<ConversationRuntimeContext>,
  allowedMcpServers: readonly string[]
): RuntimeSessionConfig {
  return {
    role: "principal",
    workspace_id: runtimeContext.workspace_id,
    run_id: runtimeContext.run_id,
    cwd: workspaceRoot,
    writable_roots: [workspaceRoot],
    tool_profile: "default",
    allowed_mcp_servers: [...allowedMcpServers],
    sandbox_policy: "workspace_write",
    permission_policy: "ask",
    network_policy: "restricted"
  };
}

function resolveAllowedMcpServersForProvider(
  provider: Readonly<ToolProvider> | null | undefined
): readonly string[] {
  if (provider === null || provider === undefined || provider.source !== "mcp_external") {
    return [];
  }

  const parsed = /^provider\.mcp\.(.+)$/.exec(provider.provider_id);
  if (parsed === null || parsed[1] === undefined || parsed[1].trim().length === 0) {
    return [];
  }

  return [parsed[1]];
}

function buildToolGovernanceQuery(
  toolSpec: Readonly<ToolSpec>,
  rawInput: unknown,
  runtimeContext: Readonly<ConversationRuntimeContext>,
  governanceSubject: GovernanceSubject
): ToolGovernanceQuery {
  const targetPaths = collectPathCandidates(rawInput);

  return {
    governance_subject: governanceSubject,
    tool_category: toolSpec.category,
    scope_guard: toolSpec.scope_guard,
    ...(runtimeContext.surface_id === null ? {} : { target_surface: runtimeContext.surface_id }),
    ...(targetPaths.length === 0 ? {} : { target_paths: targetPaths }),
    destructive: toolSpec.destructive,
    requested_by: "principal",
    request_context: {
      node_template: "build",
      project_ref: runtimeContext.workspace_id
    }
  };
}

function createToolGovernanceSubject(toolSpec: Readonly<ToolSpec>): GovernanceSubject {
  return canonicalGovernanceSubject("tooling.policy", {
    scope: toolSpec.scope_guard,
    tool: toolSpec.tool_id
  });
}

function createToolGovernanceEntityId(runId: string, nodeId: string | null): string {
  return `tool-governance:${runId}:${nodeId ?? "detached"}:${randomUUID()}`;
}

function createCircuitBreakerStanceResolution(
  breakerState: Readonly<CircuitBreakerState>,
  nowIso: string
) {
  if (breakerState.postureLevel === 0) {
    return undefined;
  }

  return {
    resolution_id: `circuit-breaker:${breakerState.postureLevel}`,
    policy_ref: "circuit-breaker",
    risk_signals: ["likely_tool_misuse"] as const,
    resolved_bias: "conservative" as const,
    resolved_verification_attention: "high" as const,
    resolved_write_posture: breakerState.postureLevel === 1 ? ("guarded" as const) : ("strict" as const),
    created_at: nowIso,
    expires_at: breakerState.cooldownUntil ?? nowIso
  };
}

function createExtensionGovernanceTrackingState(
  provider: Readonly<ToolProvider> | null | undefined
): ExtensionGovernanceTrackingState {
  if (provider === null || provider === undefined || !isExternalProvider(provider)) {
    return {
      permissionCheckedRequired: false,
      permissionChecked: false,
      executionRecordedRequired: false,
      executionRecorded: false
    };
  }

  return {
    permissionCheckedRequired: provider.requires_permission_check,
    permissionChecked: false,
    executionRecordedRequired: provider.records_execution,
    executionRecorded: false
  };
}

function isExternalProvider(provider: Readonly<ToolProvider>): boolean {
  return provider.source !== "builtin";
}
