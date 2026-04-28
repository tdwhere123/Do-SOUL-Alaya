import type {
  EventLogEntry,
  RuntimeSessionConfig,
  ToolCallStartedPayload,
  ToolExecutionRecord,
  ToolSpec
} from "@do-what/protocol";
import { PhaseA1EventType, ToolCallStartedPayloadSchema } from "@do-what/protocol";
import { CoreError } from "../errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import type { ToolExecutionContext, ToolSubstrate } from "../tool-substrate/index.js";
import {
  createToolCallEventEntry,
  emitCompletedToolExecution,
  rethrowWithSuppressedError,
  summarizeForEvent
} from "./shared-execution.js";
import { assertScopeGuardWithinContext } from "./tool-path-guards.js";

export interface ToolFastPathDependencies {
  readonly substrate: ToolSubstrate;
  readonly executionRecordRepo: ToolExecutionRecordRepoPort;
  readonly eventLogRepo: ToolFastPathEventLogRepoPort;
  readonly sseBroadcaster: ToolFastPathSseBroadcasterPort;
  readonly now?: () => string;
}

export interface ToolFastPathEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
}

export interface ToolFastPathSseBroadcasterPort {
  broadcastEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface ToolExecutionRecordRepoPort {
  insert(record: ToolExecutionRecord): Promise<Readonly<ToolExecutionRecord>>;
}

export interface ToolFastPathExecuteInput {
  readonly toolSpec: Readonly<ToolSpec>;
  readonly rawInput: unknown;
  readonly sessionConfig: Readonly<RuntimeSessionConfig>;
  readonly affectedPathRoots?: readonly string[];
  readonly requestedBy: "principal" | "worker";
  readonly requestingRunId: string;
  readonly handler: (ctx: Readonly<ToolExecutionContext>, input: unknown) => Promise<unknown>;
}

export interface ToolFastPathExecuteResult {
  readonly result: unknown;
  readonly executionRecord: Readonly<ToolExecutionRecord>;
}

export class ToolFastPath {
  public constructor(private readonly deps: ToolFastPathDependencies) {}

  public async execute(input: Readonly<ToolFastPathExecuteInput>): Promise<ToolFastPathExecuteResult> {
    this.assertFastPathEligible(input.toolSpec);

    return await this.deps.substrate.withContext(
      input.toolSpec.tool_id,
      input.sessionConfig,
      async (context) => {
        // preHook: no-op in A2
        // targetRevalidate (fast-path): governance is intentionally skipped here.
        // governanceDecisionRef is always "fast-path://skipped", so this path has no
        // governance decision refs to revalidate. If the tool leaves fast-path
        // eligibility, execution routes through ToolHotPathFull where full
        // targetRevalidate runs after governance query.
        this.toolSpecificPermissionCheck(input.toolSpec, input.rawInput, context);

        const startedPayload = parseStartedPayload({
          toolCallId: context.executionId,
          workerId: input.requestedBy === "worker" ? input.requestingRunId : undefined,
          toolId: input.toolSpec.tool_id,
          inputSummary: summarizeForEvent(input.rawInput, "tool input")
        });

        const startedEntry = await this.deps.eventLogRepo.append(
          createToolCallEventEntry(
            PhaseA1EventType.TOOL_CALL_STARTED,
            context,
            context.executionId,
            input.requestedBy,
            input.requestingRunId,
            startedPayload
          )
        );
        await this.deps.sseBroadcaster.broadcastEntry(startedEntry);

        try {
          const result = await input.handler(context, input.rawInput);

          // postHook: no-op in A2
          const endedAt = this.now();
          const { executionRecord } = await emitCompletedToolExecution({
            eventLogRepo: this.deps.eventLogRepo,
            executionRecordRepo: this.deps.executionRecordRepo,
            sseBroadcaster: this.deps.sseBroadcaster,
            context,
            executionId: context.executionId,
            requestedBy: input.requestedBy,
            requestingRunId: input.requestingRunId,
            toolSpec: input.toolSpec,
            governanceDecisionRef: "fast-path://skipped",
            permissionResult: "allow",
            affectedPaths: undefined,
            endedAt,
            statusKind: "success",
            outcome: result
          });

          // emitPostEffects: no-op in A2
          return {
            result,
            executionRecord
          };
        } catch (error) {
          // postHook: no-op in A2
          const endedAt = this.now();
          try {
            await emitCompletedToolExecution({
              eventLogRepo: this.deps.eventLogRepo,
              executionRecordRepo: this.deps.executionRecordRepo,
              sseBroadcaster: this.deps.sseBroadcaster,
              context,
              executionId: context.executionId,
              requestedBy: input.requestedBy,
              requestingRunId: input.requestingRunId,
              toolSpec: input.toolSpec,
              governanceDecisionRef: "fast-path://skipped",
              permissionResult: "allow",
              affectedPaths: undefined,
              endedAt,
              statusKind: "error",
              outcome: error
            });
          } catch (persistenceError) {
            rethrowWithSuppressedError(error, persistenceError);
          }

          // emitPostEffects: no-op in A2
          throw error;
        }
      },
      {
        affectedPathRoots: input.affectedPathRoots
      }
    );
  }

  private assertFastPathEligible(toolSpec: Readonly<ToolSpec>): void {
    if (!toolSpec.fast_path_eligible || !toolSpec.read_only) {
      throw new CoreError("VALIDATION", "Tool is not fast-path eligible; route to ToolHotPathFull");
    }
  }

  private toolSpecificPermissionCheck(
    toolSpec: Readonly<ToolSpec>,
    input: unknown,
    context: Readonly<ToolExecutionContext>
  ): void {
    assertScopeGuardWithinContext(toolSpec, input, context);
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }
}

function parseStartedPayload(payload: ToolCallStartedPayload): ToolCallStartedPayload {
  return deepFreeze(ToolCallStartedPayloadSchema.parse(payload));
}
