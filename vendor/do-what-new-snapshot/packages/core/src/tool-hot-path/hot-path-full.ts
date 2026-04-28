import type {
  EventLogEntry,
  RuntimeSessionConfig,
  StancePolicy,
  StanceResolution,
  TargetRevalidateResult,
  ToolExecutionRecord,
  ToolGovernanceDecision,
  ToolGovernanceQuery,
  ToolPermissionResult,
  ToolSpec
} from "@do-what/protocol";
import {
  PhaseA1EventType,
  ToolCallStartedPayloadSchema,
  ToolIntentApprovedPayloadSchema,
  ToolIntentCreatedPayloadSchema,
  ToolIntentDeniedPayloadSchema,
  ToolSpecSchema
} from "@do-what/protocol";
import { CoreError } from "../errors.js";
import { resolvePermission } from "../permission-policy/index.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import type { ToolExecutionContext, ToolSubstrate } from "../tool-substrate/index.js";
import type { ToolFastPathExecuteInput, ToolFastPathExecuteResult } from "./fast-path.js";
import {
  CURRENT_TOOL_EVENT_REVISION,
  buildToolExecutionRecord,
  createToolCallEventEntry,
  emitCompletedToolExecution,
  resolveAffectedPaths,
  rethrowWithSuppressedError,
  summarizeForEvent
} from "./shared-execution.js";
import { assertScopeGuardWithinContext } from "./tool-path-guards.js";

export interface ApprovalSinkPort {
  requestApproval(
    executionId: string,
    toolId: string,
    reason: string
  ): Promise<"approved" | "denied">;
}

export interface ToolHotPathGovernanceClientPort {
  query(query: ToolGovernanceQuery, nodeId?: string): Promise<Readonly<ToolGovernanceDecision>>;
}

export interface ToolHotPathFastPathPort {
  execute(input: Readonly<ToolFastPathExecuteInput>): Promise<ToolFastPathExecuteResult>;
}

export interface ToolHotPathTargetRevalidatePort {
  findAndRevalidate(workspaceId: string, targetEntityType: string, targetEntityIds: readonly string[]): Promise<readonly TargetRevalidateResult[]>;
}

export interface ToolHotPathStrongRefPort {
  protect(params: {
    sourceEntityType: string;
    sourceEntityId: string;
    targetEntityType: string;
    targetEntityId: string;
    workspaceId: string;
    reason: "governance_lease" | "security_snapshot" | "active_projection";
  }): Promise<unknown>;
  releaseBySource(params: {
    sourceEntityType: string;
    sourceEntityId: string;
  }): Promise<void>;
}

export interface ToolHotPathFullDependencies {
  readonly substrate: ToolSubstrate;
  readonly governanceClient: ToolHotPathGovernanceClientPort;
  readonly targetRevalidateService: ToolHotPathTargetRevalidatePort;
  readonly strongRefService?: ToolHotPathStrongRefPort;
  readonly fastPath: ToolHotPathFastPathPort;
  readonly executionRecordRepo: HotPathToolExecutionRecordRepoPort;
  readonly eventLogRepo: HotPathEventLogRepoPort;
  readonly sseBroadcaster: HotPathSseBroadcasterPort;
  readonly approvalSink: ApprovalSinkPort;
  readonly outcomeRecorder?: HotPathOutcomeRecorderPort;
  readonly now?: () => string;
  readonly generateExecutionId: () => string;
}

export interface HotPathEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
}

export interface HotPathSseBroadcasterPort {
  broadcastEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface HotPathToolExecutionRecordRepoPort {
  insert(record: ToolExecutionRecord): Promise<Readonly<ToolExecutionRecord>>;
}

export interface HotPathOutcomeRecorderPort {
  recordOutcome(
    runId: string,
    workspaceId: string,
    nodeId: string,
    governanceSubjectKey: string,
    outcome: "ask" | "deny"
  ): Promise<void>;
}

export interface HotPathExecuteInput {
  readonly toolSpec: Readonly<ToolSpec>;
  readonly rawInput: unknown;
  readonly governanceQueryBuilder: () => ToolGovernanceQuery;
  readonly sessionConfig: Readonly<RuntimeSessionConfig>;
  readonly affectedPathRoots?: readonly string[];
  readonly requestedBy: "principal" | "worker";
  readonly requestingRunId: string;
  readonly nodeId?: string;
  readonly stancePolicy?: Readonly<StancePolicy>;
  readonly stanceResolution?: Readonly<StanceResolution>;
  readonly deniedToolCategories: readonly ToolSpec["category"][];
  readonly handler: (ctx: Readonly<ToolExecutionContext>, input: unknown) => Promise<unknown>;
}

export interface ToolHotPathExecuteResult {
  readonly result: unknown;
  readonly executionRecord: Readonly<ToolExecutionRecord>;
  readonly permissionResult: ToolPermissionResult;
}

export class ToolHotPathFull {
  public constructor(private readonly deps: ToolHotPathFullDependencies) {}

  public async execute(input: HotPathExecuteInput): Promise<ToolHotPathExecuteResult> {
    const toolSpec = parseToolSpec(input.toolSpec);

    if (input.rawInput === undefined) {
      throw new CoreError("VALIDATION", "rawInput is required");
    }

    // Fast-path is an explicit contract for safe read-only tools only. It intentionally
    // bypasses governance/approval, so specs that still require confirmation or declare
    // destructive behavior must stay on the full hot-path even if registration drift occurs.
    if (isFastPathDelegationEligible(toolSpec)) {
      const delegated = await this.deps.fastPath.execute({
        toolSpec,
        rawInput: input.rawInput,
        sessionConfig: input.sessionConfig,
        affectedPathRoots: input.affectedPathRoots,
        requestedBy: input.requestedBy,
        requestingRunId: input.requestingRunId,
        handler: input.handler
      });

      return {
        result: delegated.result,
        executionRecord: delegated.executionRecord,
        permissionResult: delegated.executionRecord.permission_result
      };
    }

    return await this.deps.substrate.withContext(
      toolSpec.tool_id,
      input.sessionConfig,
      async (context) => {
        // preHook: no-op in A2
        // targetRevalidate: performed after governanceDecision is available.

        const executionId = context.executionId;
        const governanceDecisionRef = this.deps.generateExecutionId();
        const governanceQuery = input.governanceQueryBuilder();
        const governanceDecision = await this.deps.governanceClient.query(governanceQuery, input.nodeId);
        const matchedClaimRefs = [...new Set(governanceDecision.matched_claim_refs)];
        const matchedSlotRefs = [...new Set(governanceDecision.matched_slot_refs)];
        await this.revalidateGovernanceRefs(
          context.workspaceId,
          matchedClaimRefs,
          matchedSlotRefs,
          toolSpec.tool_id
        );

        const permissionDecision = resolvePermission({
          toolSpec,
          governanceDecision,
          stancePolicy: input.stancePolicy,
          stanceResolution: input.stanceResolution,
          deniedToolCategories: [...input.deniedToolCategories]
        });

        if (permissionDecision.result === "deny") {
          if (governanceDecision.final_result === "deny") {
            await this.deps.outcomeRecorder?.recordOutcome(
              input.requestingRunId,
              context.workspaceId,
              input.nodeId ?? context.executionId,
              governanceQuery.governance_subject.canonical_key,
              "deny"
            );
          }

          return await this.finishDeniedExecution({
            context,
            executionId,
            governanceDecision,
            governanceDecisionRef,
            permissionResult: "deny",
            explanationSummary: permissionDecision.explanation,
            requestedBy: input.requestedBy,
            requestingRunId: input.requestingRunId,
            toolSpec
          });
        }

        if (permissionDecision.result === "ask") {
          const createdEntry = await this.deps.eventLogRepo.append({
            event_type: PhaseA1EventType.TOOL_INTENT_CREATED,
            entity_type: "tool_execution",
            entity_id: executionId,
            workspace_id: context.workspaceId,
            run_id: this.resolveRunId(context, input.requestedBy, input.requestingRunId),
            caused_by: input.requestedBy,
            revision: CURRENT_TOOL_EVENT_REVISION,
            payload_json: deepFreeze(
              ToolIntentCreatedPayloadSchema.parse({
                executionId,
                toolId: toolSpec.tool_id,
                requestedBy: input.requestedBy,
                requestingRunId: input.requestingRunId,
                ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
                governanceSubject: governanceQuery.governance_subject
              })
            )
          });
          await this.deps.sseBroadcaster.broadcastEntry(createdEntry);

          const approval = await this.deps.approvalSink.requestApproval(
            executionId,
            toolSpec.tool_id,
            permissionDecision.explanation
          );

          if (approval === "denied") {
            return await this.finishDeniedExecution({
              context,
              executionId,
              governanceDecision,
              governanceDecisionRef,
              permissionResult: "deny",
              explanationSummary: permissionDecision.explanation,
              requestedBy: input.requestedBy,
              requestingRunId: input.requestingRunId,
              toolSpec
            });
          }

          const approvedEntry = await this.deps.eventLogRepo.append({
            event_type: PhaseA1EventType.TOOL_INTENT_APPROVED,
            entity_type: "tool_execution",
            entity_id: executionId,
            workspace_id: context.workspaceId,
            run_id: this.resolveRunId(context, input.requestedBy, input.requestingRunId),
            caused_by: input.requestedBy,
            revision: CURRENT_TOOL_EVENT_REVISION,
            payload_json: buildApprovedPayload(executionId, governanceDecisionRef, governanceDecision)
          });
          await this.deps.sseBroadcaster.broadcastEntry(approvedEntry);

          return await this.executeApprovedPath({
            context,
            executionId,
            governanceDecisionRef,
            matchedClaimRefs,
            matchedSlotRefs,
            permissionResult: "ask",
            requestedBy: input.requestedBy,
            requestingRunId: input.requestingRunId,
            toolSpec,
            rawInput: input.rawInput,
            handler: input.handler
          });
        }

        const approvedEntry = await this.deps.eventLogRepo.append({
          event_type: PhaseA1EventType.TOOL_INTENT_APPROVED,
          entity_type: "tool_execution",
          entity_id: executionId,
          workspace_id: context.workspaceId,
          run_id: this.resolveRunId(context, input.requestedBy, input.requestingRunId),
          caused_by: input.requestedBy,
          revision: CURRENT_TOOL_EVENT_REVISION,
          payload_json: buildApprovedPayload(executionId, governanceDecisionRef, governanceDecision)
        });
        await this.deps.sseBroadcaster.broadcastEntry(approvedEntry);

        return await this.executeApprovedPath({
          context,
          executionId,
          governanceDecisionRef,
          matchedClaimRefs,
          matchedSlotRefs,
          permissionResult: "allow",
          requestedBy: input.requestedBy,
          requestingRunId: input.requestingRunId,
          toolSpec,
          rawInput: input.rawInput,
          handler: input.handler
        });
      },
      {
        affectedPathRoots: input.affectedPathRoots
      }
    );
  }

  private async finishDeniedExecution(input: {
    readonly context: Readonly<ToolExecutionContext>;
    readonly executionId: string;
    readonly governanceDecision: Readonly<ToolGovernanceDecision>;
    readonly governanceDecisionRef: string;
    readonly permissionResult: "deny";
    readonly explanationSummary: string;
    readonly requestedBy: "principal" | "worker";
    readonly requestingRunId: string;
    readonly toolSpec: Readonly<ToolSpec>;
  }): Promise<ToolHotPathExecuteResult> {
    const deniedEntry = await this.deps.eventLogRepo.append({
      event_type: PhaseA1EventType.TOOL_INTENT_DENIED,
      entity_type: "tool_execution",
      entity_id: input.executionId,
      workspace_id: input.context.workspaceId,
      run_id: this.resolveRunId(input.context, input.requestedBy, input.requestingRunId),
      caused_by: input.requestedBy,
      revision: CURRENT_TOOL_EVENT_REVISION,
      payload_json: deepFreeze(
        ToolIntentDeniedPayloadSchema.parse({
          executionId: input.executionId,
          governanceDecisionRef: input.governanceDecisionRef,
          explanationSummary: input.explanationSummary,
          hardConstraintsPresent: input.governanceDecision.hard_constraints_present
        })
      )
    });
    const executionRecord = await this.deps.executionRecordRepo.insert(
      buildToolExecutionRecord({
        executionId: input.executionId,
        toolSpec: input.toolSpec,
        requestedBy: input.requestedBy,
        requestingRunId: input.requestingRunId,
        governanceDecisionRef: input.governanceDecisionRef,
        permissionResult: input.permissionResult,
        executed: false,
        startedAt: input.context.startedAt,
        endedAt: this.now(),
        resultSummary: input.explanationSummary
      })
    );
    await this.deps.sseBroadcaster.broadcastEntry(deniedEntry);

    return {
      result: null,
      executionRecord,
      permissionResult: input.permissionResult
    };
  }

  private async executeApprovedPath(input: {
    readonly context: Readonly<ToolExecutionContext>;
    readonly executionId: string;
    readonly governanceDecisionRef: string;
    readonly matchedClaimRefs: readonly string[];
    readonly matchedSlotRefs: readonly string[];
    readonly permissionResult: "allow" | "ask";
    readonly requestedBy: "principal" | "worker";
    readonly requestingRunId: string;
    readonly toolSpec: Readonly<ToolSpec>;
    readonly rawInput: unknown;
    readonly handler: (ctx: Readonly<ToolExecutionContext>, input: unknown) => Promise<unknown>;
  }): Promise<ToolHotPathExecuteResult> {
    this.toolSpecificPermissionCheck(input.toolSpec, input.rawInput, input.context);

    const startedEntry = await this.deps.eventLogRepo.append(
      createToolCallEventEntry(
        PhaseA1EventType.TOOL_CALL_STARTED,
        input.context,
        input.executionId,
        input.requestedBy,
        input.requestingRunId,
        deepFreeze(
          ToolCallStartedPayloadSchema.parse({
            toolCallId: input.executionId,
            workerId: input.requestedBy === "worker" ? input.requestingRunId : undefined,
            toolId: input.toolSpec.tool_id,
            inputSummary: summarizeForEvent(input.rawInput, "tool input")
          })
        )
      )
    );
    await this.deps.sseBroadcaster.broadcastEntry(startedEntry);

    if (this.deps.strongRefService !== undefined && (input.matchedClaimRefs.length > 0 || input.matchedSlotRefs.length > 0)) {
      const protectPromises = [
        ...input.matchedClaimRefs.map((refId) =>
          this.deps.strongRefService!.protect({
            sourceEntityType: "tool_execution",
            sourceEntityId: input.executionId,
            targetEntityType: "claim",
            targetEntityId: refId,
            workspaceId: input.context.workspaceId,
            reason: "governance_lease"
          })
        ),
        ...input.matchedSlotRefs.map((refId) =>
          this.deps.strongRefService!.protect({
            sourceEntityType: "tool_execution",
            sourceEntityId: input.executionId,
            targetEntityType: "slot",
            targetEntityId: refId,
            workspaceId: input.context.workspaceId,
            reason: "governance_lease"
          })
        )
      ];
      await Promise.all(protectPromises);
    }

    try {
      const result = await input.handler(input.context, input.rawInput);
      const endedAt = this.now();
      const { executionRecord } = await emitCompletedToolExecution({
        eventLogRepo: this.deps.eventLogRepo,
        executionRecordRepo: this.deps.executionRecordRepo,
        sseBroadcaster: this.deps.sseBroadcaster,
        context: input.context,
        executionId: input.executionId,
        requestedBy: input.requestedBy,
        requestingRunId: input.requestingRunId,
        toolSpec: input.toolSpec,
        governanceDecisionRef: input.governanceDecisionRef,
        permissionResult: input.permissionResult,
        affectedPaths: resolveAffectedPaths({
          context: input.context,
          toolSpec: input.toolSpec,
          rawInput: input.rawInput,
          outcome: result
        }),
        endedAt,
        statusKind: "success",
        outcome: result
      });

      return {
        result,
        executionRecord,
        permissionResult: input.permissionResult
      };
    } catch (error) {
      const endedAt = this.now();
      try {
        await emitCompletedToolExecution({
          eventLogRepo: this.deps.eventLogRepo,
          executionRecordRepo: this.deps.executionRecordRepo,
          sseBroadcaster: this.deps.sseBroadcaster,
          context: input.context,
          executionId: input.executionId,
          requestedBy: input.requestedBy,
          requestingRunId: input.requestingRunId,
          toolSpec: input.toolSpec,
          governanceDecisionRef: input.governanceDecisionRef,
          permissionResult: input.permissionResult,
          affectedPaths: undefined,
          endedAt,
          statusKind: "error",
          outcome: error
        });
      } catch (persistenceError) {
        rethrowWithSuppressedError(error, persistenceError);
      }
      throw error;
    } finally {
      if (this.deps.strongRefService !== undefined && (input.matchedClaimRefs.length > 0 || input.matchedSlotRefs.length > 0)) {
        await this.deps.strongRefService.releaseBySource({
          sourceEntityType: "tool_execution",
          sourceEntityId: input.executionId
        });
      }
    }
  }

  private toolSpecificPermissionCheck(
    toolSpec: Readonly<ToolSpec>,
    rawInput: unknown,
    context: Readonly<ToolExecutionContext>
  ): void {
    assertScopeGuardWithinContext(toolSpec, rawInput, context);

    if (context.sessionConfig.sandbox_policy === "read_only" && toolSpec.destructive) {
      throw new CoreError("VALIDATION", "Destructive tools are not allowed in read_only sandboxes.");
    }
  }

  private resolveRunId(
    context: Readonly<ToolExecutionContext>,
    requestedBy: "principal" | "worker",
    requestingRunId: string
  ): string | null {
    return context.sessionConfig.run_id ?? (requestedBy === "principal" ? requestingRunId : null);
  }

  private async revalidateGovernanceRefs(
    workspaceId: string,
    claimRefIds: readonly string[],
    slotRefIds: readonly string[],
    toolId: string
  ): Promise<void> {
    if (claimRefIds.length === 0 && slotRefIds.length === 0) {
      return;
    }

    let results: readonly TargetRevalidateResult[];
    try {
      const [claimResults, slotResults] = await Promise.all([
        claimRefIds.length > 0
          ? this.deps.targetRevalidateService.findAndRevalidate(workspaceId, "claim", claimRefIds)
          : Promise.resolve([] as readonly TargetRevalidateResult[]),
        slotRefIds.length > 0
          ? this.deps.targetRevalidateService.findAndRevalidate(workspaceId, "slot", slotRefIds)
          : Promise.resolve([] as readonly TargetRevalidateResult[])
      ]);
      results = [...claimResults, ...slotResults];
    } catch (error) {
      console.warn("targetRevalidate failed on tool hot-path; continuing execution", {
        toolId,
        claimRefIds,
        slotRefIds,
        error
      });
      return;
    }

    const staleResults = results.filter((result) => result.status !== "fresh");
    if (staleResults.length > 0) {
      console.warn("targetRevalidate detected stale or missing governance refs; continuing execution", {
        toolId,
        staleRefs: staleResults
      });
    }
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }
}

function isFastPathDelegationEligible(toolSpec: Readonly<ToolSpec>): boolean {
  return (
    toolSpec.fast_path_eligible &&
    toolSpec.read_only &&
    !toolSpec.requires_confirmation &&
    !toolSpec.destructive
  );
}

function parseToolSpec(toolSpec: Readonly<ToolSpec>): Readonly<ToolSpec> {
  try {
    return deepFreeze(ToolSpecSchema.parse(toolSpec));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid tool spec payload", { cause: error });
  }
}

function buildApprovedPayload(
  executionId: string,
  governanceDecisionRef: string,
  governanceDecision: Readonly<ToolGovernanceDecision>
) {
  return deepFreeze(
    ToolIntentApprovedPayloadSchema.parse({
      executionId,
      governanceDecisionRef,
      matchedClaimRefs: governanceDecision.matched_claim_refs,
      matchedSlotRefs: governanceDecision.matched_slot_refs,
      requiresRedCard: governanceDecision.requires_red_card
    })
  );
}
