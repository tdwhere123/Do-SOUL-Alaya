import { randomUUID } from "node:crypto";
import type { CanonicalAliasService, StrongRefService, ToolGovernanceClient } from "@do-soul/alaya-core";
import type {
  SqliteEventLogRepo,
  SqliteToolExecutionRecordRepo
} from "@do-soul/alaya-storage";
import type { AlayaRuntimeNotifier } from "./runtime-notifier.js";

export function createConversationToolExecutor(input: {
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly runtimeNotifier: AlayaRuntimeNotifier;
  readonly toolExecutionRecordRepo: SqliteToolExecutionRecordRepo;
  readonly toolGovernanceClient: ToolGovernanceClient;
  readonly targetRevalidateService: unknown;
  readonly strongRefService: StrongRefService;
  readonly canonicalAliasService: CanonicalAliasService;
}) {
  void input.toolGovernanceClient;
  void input.targetRevalidateService;
  void input.strongRefService;
  void input.canonicalAliasService;

  return {
    execute: async (request: ToolExecutionRequest) =>
      await executeConversationTool(input, request)
  };
}

type ToolExecutionRequest = Readonly<{
  toolId: string;
  rawInput: unknown;
  runtimeContext: { readonly run_id: string; readonly workspace_id: string };
  workspaceRoot: string;
  affectedPathRoots?: readonly string[];
  handler: (context: { readonly writableRoots: readonly string[] }, rawInput?: unknown) => Promise<unknown>;
}>;

async function executeConversationTool(
  input: {
    readonly eventLogRepo: SqliteEventLogRepo;
    readonly runtimeNotifier: AlayaRuntimeNotifier;
    readonly toolExecutionRecordRepo: SqliteToolExecutionRecordRepo;
  },
  request: ToolExecutionRequest
) {
  const startedAt = new Date().toISOString();
  const result = await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput);
  const execution = createToolExecutionAuditRecord(request, startedAt, result);

  await input.toolExecutionRecordRepo.insert(execution.record);
  const event = await input.eventLogRepo.append(execution.event);
  await input.runtimeNotifier.notifyEntry(event);

  return { result };
}

function createToolExecutionAuditRecord(
  request: ToolExecutionRequest,
  startedAt: string,
  result: unknown
) {
  const endedAt = new Date().toISOString();
  const executionId = randomUUID();
  const affectedPaths = request.affectedPathRoots ?? [];
  const resultSummary = summarizeToolResult(result);

  return {
    record: {
      execution_id: executionId,
      tool_id: request.toolId,
      requested_by: "principal" as const,
      requesting_run_id: request.runtimeContext.run_id,
      governance_decision_ref: "fast-path://recorded",
      permission_result: "allow" as const,
      executed: true,
      started_at: startedAt,
      ended_at: endedAt,
      result_summary: resultSummary,
      rollback_status: "none" as const,
      affected_paths: affectedPaths
    },
    event: {
      event_type: "tool_call.completed" as const,
      entity_type: "tool_call" as const,
      entity_id: executionId,
      workspace_id: request.runtimeContext.workspace_id,
      run_id: request.runtimeContext.run_id,
      caused_by: "principal" as const,
      payload_json: {
        tool_call_id: executionId,
        tool_id: request.toolId,
        permission_result: "allow",
        executed: true,
        affected_paths: affectedPaths,
        result_summary: resultSummary
      }
    }
  };
}

function summarizeToolResult(result: unknown): string {
  if (typeof result === "object" && result !== null && "ok" in result) {
    return (result as { readonly ok?: boolean }).ok === false ? "error" : "ok";
  }

  return "ok";
}
