import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  TaskObjectSurfaceSchema
} from "@do-soul/alaya-protocol";
import {
  applyBenchRecallWeightOverrides,
  type BenchRecallWeightOverrides
} from "../../recall/recall-weight-overrides.js";
import { resolveBenchRequestBudget } from "../../recall/conditional-request-budget.js";
import { buildBenchDiagnosticRecallPolicy } from "../runtime/daemon-recall-result.js";
import type { BenchRecallOptions } from "../daemon-types.js";

export interface BenchRecallRequestInput {
  readonly activeContext: { readonly workspaceId: string; readonly runId: string };
  readonly recallWeightOverrides?: BenchRecallWeightOverrides;
  readonly effectiveEnv: Readonly<Record<string, string | undefined>>;
}

export function prepareBenchRecallRequest(
  input: BenchRecallRequestInput,
  query: string,
  opts: BenchRecallOptions = {}
) {
  const taskSurface = createBenchTaskSurface(query);
  const policy = buildBenchRecallPolicy(
    taskSurface.runtime_id,
    opts,
    input.recallWeightOverrides
  );
  const requestBudget = resolveBenchRequestBudget(opts);
  const interpretationClock = new Date(opts.interpretationClock ?? opts.referenceTime
    ?? opts.continuation?.interpretation_clock ?? new Date().toISOString()).toISOString();
  return {
    sideEffectMode: "benchmark" as const,
    taskSurface,
    workspaceId: input.activeContext.workspaceId,
    runId: input.activeContext.runId,
    strategy: "chat" as const,
    policyOverride: policy,
    diagnosticCapture:
      input.effectiveEnv.ALAYA_BENCH_RECALL_PACKET_TRACE === "1"
        ? "packet_trace" as const
        : "answer_features" as const,
    ...(opts.referenceTime === undefined ? {} : { referenceTime: opts.referenceTime }),
    ...(opts.querySemanticFactorFormationCapture === undefined
      ? {}
      : { querySemanticFactorFormationCapture: opts.querySemanticFactorFormationCapture }),
    ...(opts.querySemanticFactorCompletenessReceipt === undefined
      ? {}
      : { querySemanticFactorCompletenessReceipt:
          opts.querySemanticFactorCompletenessReceipt }),
    ...(opts.snapshotDigest === undefined ? {} : { snapshotDigest: opts.snapshotDigest }),
    queryText: query,
    budget: requestBudget,
    ...(opts.continuation === undefined ? {} : { continuation: opts.continuation }),
    ...(opts.cancelled === undefined ? {} : { cancelled: opts.cancelled }),
    interpretationClock,
    ...(opts.since === undefined ? {} : { since: opts.since }),
    ...(opts.until === undefined ? {} : { until: opts.until }),
    ...(opts.timeFilter === undefined ? {} : { timeFilter: opts.timeFilter }),
    ...(opts.enumeration_policy === undefined ? {} : { enumeration_policy: opts.enumeration_policy }),
    ...(opts.cap_contracts === undefined ? {} : { cap_contracts: opts.cap_contracts }),
    ...(opts.result_kind_view === undefined ? {} : { result_kind_view: opts.result_kind_view }),
    protocol_version: 1 as const,
    supports_source_evidence: true,
    supported_result_kinds: ["memory_entry" as const, "source_evidence" as const],
    activeConstraintsCap: null
  };
}

export type BenchRecallInvokeRequest = ReturnType<typeof prepareBenchRecallRequest>;

function createBenchTaskSurface(query: string) {
  return TaskObjectSurfaceSchema.parse({
    runtime_id: randomUUID(),
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: null,
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "mcp_memory_tool",
    display_name: query,
    context_refs: []
  });
}

function buildBenchRecallPolicy(
  taskSurfaceId: string,
  opts: BenchRecallOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined
) {
  const basePolicy = buildBenchDiagnosticRecallPolicy(
    taskSurfaceId,
    opts.maxResults ?? 10,
    opts.conflictAwareness ?? true
  );
  return applyBenchRecallWeightOverrides(basePolicy, recallWeightOverrides);
}
