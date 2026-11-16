import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  TaskObjectSurfaceSchema,
  type RecallPolicy,
  type RequestBudget,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type { InvokeBoundRecallParams } from "@do-soul/alaya/recall/bound-execution";
import {
  applyBenchRecallWeightOverrides,
  type BenchRecallWeightOverrides
} from "../../recall/recall-weight-overrides.js";
import { benchRequestFilters, resolveBenchRequestBudget } from "../../recall/conditional-request-budget.js";
import { buildBenchDiagnosticRecallPolicy } from "../runtime/daemon-recall-result.js";
import type { BenchRecallOptions } from "../daemon-types.js";
import type { ConditionalFieldRequestFilters } from "../../../runs/measurement/conditional-field-request-binding.js";

export type PreparedBenchRecallInvoke = Omit<InvokeBoundRecallParams<unknown>, "recallService">;

export interface BenchRecallRequestInput {
  readonly activeContext: { readonly workspaceId: string; readonly runId: string };
  readonly recallWeightOverrides?: BenchRecallWeightOverrides;
  readonly effectiveEnv: Readonly<Record<string, string | undefined>>;
}

export interface PreparedBenchRecallRequest {
  readonly queryText: string;
  readonly taskSurface: TaskObjectSurface;
  readonly policy: RecallPolicy;
  readonly requestBudget: RequestBudget;
  readonly interpretationClock: string;
  readonly continuation: BenchRecallOptions["continuation"];
  readonly expectedIndexSnapshotId: string | undefined;
  readonly requestFilters: ConditionalFieldRequestFilters;
  readonly invoke: PreparedBenchRecallInvoke;
}

export function prepareBenchRecallRequest(
  input: BenchRecallRequestInput,
  query: string,
  opts: BenchRecallOptions = {}
): PreparedBenchRecallRequest {
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
    queryText: query,
    taskSurface,
    policy,
    requestBudget,
    interpretationClock,
    continuation: opts.continuation,
    expectedIndexSnapshotId: opts.continuation?.snapshot_id,
    requestFilters: benchRequestFilters(opts, policy),
    invoke: {
      sideEffectMode: "benchmark",
      taskSurface,
      workspaceId: input.activeContext.workspaceId,
      runId: input.activeContext.runId,
      strategy: "chat",
      policyOverride: policy,
      diagnosticCapture:
        input.effectiveEnv.ALAYA_BENCH_RECALL_PACKET_TRACE === "1"
          ? "packet_trace"
          : "answer_features",
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
      protocol_version: 1,
      supports_source_evidence: true,
      supported_result_kinds: ["memory_entry", "source_evidence"],
      activeConstraintsCap: null
    }
  };
}

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
): RecallPolicy {
  const basePolicy = buildBenchDiagnosticRecallPolicy(
    taskSurfaceId,
    opts.maxResults ?? 10,
    opts.conflictAwareness ?? true
  );
  return applyBenchRecallWeightOverrides(basePolicy, recallWeightOverrides);
}
