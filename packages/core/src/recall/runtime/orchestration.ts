import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { STRATEGY_RECALL_DEFAULTS, type NodeStrategy } from "../../conversation/task-surface-builder.js";
import { parseRecallPolicy } from "../../shared/recall-policy.js";
import { classifyPathIndexReadFailure } from "./legacy-path-index-unbound-error.js";
import {
  errorNameOf,
  toErrorMessage
} from "./recall-service-helpers.js";
import type {
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./recall-service-types.js";

export function buildDefaultPolicy(params: Readonly<{
  readonly strategy: NodeStrategy;
  readonly taskSurfaceRef: string;
  readonly now: () => string;
  readonly generateRuntimeId: () => string;
  readonly defaultPolicyDecorator?: RecallServiceDependencies["defaultPolicyDecorator"];
}>): Readonly<RecallPolicy> {
  const defaults = STRATEGY_RECALL_DEFAULTS[params.strategy];
  const now = params.now();

  const base = parseRecallPolicy({
    runtime_id: params.generateRuntimeId(),
    object_kind: ControlPlaneObjectKind.RECALL_POLICY,
    task_surface_ref: params.taskSurfaceRef,
    expires_at: new Date(new Date(now).getTime() + 30 * 60 * 1000).toISOString(),
    derived_from: params.taskSurfaceRef,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    coarse_filter: defaults.coarse,
    fine_assessment: defaults.fine
  });
  const decorator = params.defaultPolicyDecorator;
  return decorator === undefined ? base : parseRecallPolicy(decorator(base));
}

export function resolvePolicy(params: Readonly<{
  readonly strategy: NodeStrategy;
  readonly taskSurfaceRef: string;
  readonly policyOverride?: Readonly<RecallPolicy>;
  readonly buildDefaultPolicy: (strategy: NodeStrategy, taskSurfaceRef: string) => Readonly<RecallPolicy>;
  readonly defaultPolicyDecorator?: RecallServiceDependencies["defaultPolicyDecorator"];
}>): Readonly<RecallPolicy> {
  const base =
    params.policyOverride === undefined
      ? params.buildDefaultPolicy(params.strategy, params.taskSurfaceRef)
      : parseRecallPolicy(params.policyOverride);
  const decorator = params.defaultPolicyDecorator;
  return decorator === undefined ? base : parseRecallPolicy(decorator(base));
}

export async function loadActiveConstraints(params: Readonly<{
  readonly activeConstraintsPort?: RecallServiceDependencies["activeConstraintsPort"];
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly cap: number | null;
  readonly asOf?: string;
}>): Promise<Readonly<{
  readonly constraints: RecallResult["active_constraints"];
  readonly total_count: number;
}>> {
  const port = params.activeConstraintsPort;
  if (port === undefined) {
    return Object.freeze({
      constraints: Object.freeze([]),
      total_count: 0
    });
  }
  try {
    return await port.findActiveConstraints({
      workspaceId: params.workspaceId,
      cap: params.cap,
      asOf: params.asOf
    });
  } catch (error) {
    // An unbound or missing as-of index is an absent constraint projection, not a store fault.
    if (classifyPathIndexReadFailure(error) === "index_unbound") {
      params.warn("active constraints lookup skipped", {
        workspace_id: params.workspaceId,
        operation: "active_constraints",
        errorName: errorNameOf(error),
        error: toErrorMessage(error)
      });
      return Object.freeze({
        constraints: Object.freeze([]),
        total_count: 0
      });
    }
    throw error;
  }
}
