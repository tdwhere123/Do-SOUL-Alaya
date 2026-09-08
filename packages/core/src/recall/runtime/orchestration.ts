import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { STRATEGY_RECALL_DEFAULTS, type NodeStrategy } from "../../conversation/task-surface-builder.js";
import { parseRecallPolicy } from "../../shared/recall-policy.js";
import type { RecallServiceDependencies } from "./recall-service-types.js";

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
