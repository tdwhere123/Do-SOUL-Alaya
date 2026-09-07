import {
  PathRelationSchema,
  SoulActiveConstraintSchema,
  normalizeActiveConstraintScopes,
  type BoundedActiveConstraintsResult,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import type { RecallServiceActiveConstraintsPort } from "./recall-service-ports.js";

type GovernanceRequest = Readonly<{
  workspace_id: string;
  as_of: string;
  snapshot_id: string;
  budget: RequestBudget;
  cancelled?: boolean;
  authorized_scopes?: readonly string[];
}>;

export async function readRequestGovernance(
  input: GovernanceRequest,
  port: RecallServiceActiveConstraintsPort | undefined,
  cap: number | null | undefined,
  discoverSnapshot = false
): Promise<Readonly<{ governance: BoundedActiveConstraintsResult; budget: RequestBudget }>> {
  const nativeLimit = Math.min(256, Math.floor(Math.max(0,
    input.budget.work_units - input.budget.finalization_reserve - input.budget.min_envelope) / 4));
  const byteLimit = Math.min(65_536, Math.floor(input.budget.memory_bytes / 4));
  const empty = unavailableGovernance(input);
  if (input.cancelled || port?.readBounded === undefined || nativeLimit < 3 || byteLimit < 2048) {
    return { governance: empty, budget: input.budget };
  }
  const result = await port.readBounded({
    workspaceId: input.workspace_id, asOf: input.as_of,
    ...(discoverSnapshot ? {} : { snapshotId: input.snapshot_id }),
    authorizedScopes: input.authorized_scopes,
    cap, nativeLimit, byteLimit
  });
  assertBoundedGovernance(result, input, nativeLimit, byteLimit, discoverSnapshot);
  return {
    governance: result,
    budget: {
      ...input.budget,
      work_units: input.budget.work_units - result.work.native_visits,
      memory_bytes: input.budget.memory_bytes - result.work.retained_bytes
    }
  };
}

function assertBoundedGovernance(
  result: BoundedActiveConstraintsResult,
  input: GovernanceRequest,
  nativeLimit: number,
  byteLimit: number,
  discoverSnapshot: boolean
): void {
  const work = result.work;
  const counts = [work.native_visits, work.bytes_read, work.retained_bytes];
  if (result.binding.workspace_id !== input.workspace_id || result.binding.as_of !== input.as_of
    || (!discoverSnapshot && result.binding.snapshot_id !== input.snapshot_id)
    || !/^sha256:[0-9a-f]{64}$/.test(result.binding.snapshot_id)
    || JSON.stringify(result.binding.authorized_scopes)
      !== JSON.stringify(normalizeActiveConstraintScopes(input.authorized_scopes))
    || counts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || work.native_visits > nativeLimit || work.bytes_read > byteLimit || work.retained_bytes > byteLimit
    || (result.completeness !== "complete" && result.completeness !== "incomplete")
    || (result.completeness === "incomplete" && result.total_count !== null)
    || (result.total_count !== null && (!Number.isSafeInteger(result.total_count)
      || result.total_count < result.constraints.length))) {
    throw new Error("bounded governance identity or allowance mismatch");
  }
  for (const constraint of result.constraints) SoulActiveConstraintSchema.parse(constraint);
  for (const path of result.paths) PathRelationSchema.parse(path);
}

function unavailableGovernance(input: GovernanceRequest): BoundedActiveConstraintsResult {
  return {
    constraints: [], total_count: null, completeness: "incomplete", paths: [],
    temporal_uncertain: true,
    work: { native_visits: 0, bytes_read: 0, retained_bytes: 0 },
    binding: { workspace_id: input.workspace_id, as_of: input.as_of, snapshot_id: input.snapshot_id,
      authorized_scopes: normalizeActiveConstraintScopes(input.authorized_scopes) }
  };
}
