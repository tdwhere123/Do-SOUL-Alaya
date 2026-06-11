import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  SecurityStatusContractSchema,
  WorkerBaselineLockSchema,
  ZeroDayPolicyKindSchema,
  ZeroDayPolicySchema,
  type SecurityPosture,
  type SecurityStatusContract,
  type WorkerBaselineLock,
  type ZeroDayPolicy
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { readClockSnapshot } from "../shared/time.js";

const {
  deny_category: ZERO_DAY_POLICY_KIND_DENY_CATEGORY,
  deny_tool: ZERO_DAY_POLICY_KIND_DENY_TOOL,
  hard_stop: ZERO_DAY_POLICY_KIND_HARD_STOP
} = ZeroDayPolicyKindSchema.enum;

const DEFAULT_POLICY_EVALUATION_CACHE_TTL_MS = 1_000;
const DEFAULT_INITIALIZED_WORKSPACE_CACHE_TTL_MS = 300_000;
const DEFAULT_INITIALIZED_WORKSPACE_CACHE_MAX_ENTRIES = 2_048;

export interface ZeroDaySecurityLayerDependencies {
  readonly loadPolicies: () => Promise<readonly ZeroDayPolicy[]>;
  readonly now?: () => string;
  readonly policyEvaluationCacheTtlMs?: number;
  readonly initializedWorkspaceCacheTtlMs?: number;
  readonly initializedWorkspaceCacheMaxEntries?: number;
}

export type ZeroDaySecurityStatusEvaluationObserver = (
  status: Readonly<SecurityStatusContract>,
  reason: string
) => Promise<void> | void;

interface ActivePolicyEvaluation {
  readonly now: string;
  readonly activePolicies: readonly ZeroDayPolicy[];
}

interface CachedPolicyEvaluation extends ActivePolicyEvaluation {
  readonly expiresAtMs: number;
}

export class ZeroDaySecurityLayer {
  private readonly initializedWorkspaceIds = new Map<string, number>();
  private cachedPolicyEvaluation: CachedPolicyEvaluation | null = null;
  private readonly statusEvaluationObservers = new Set<ZeroDaySecurityStatusEvaluationObserver>();

  public constructor(private readonly deps: ZeroDaySecurityLayerDependencies) {}

  public async augmentLock(lock: WorkerBaselineLock): Promise<WorkerBaselineLock> {
    const workspaceId = parseWorkspaceId(lock.workspace_id);
    const { activePolicies, status } = await this.evaluateSecurityStatus(workspaceId);

    await this.notifyStatusEvaluated(status, "worker.baseline_evaluated");

    if (activePolicies.length === 0) {
      return lock;
    }

    const deniedToolPolicies = activePolicies.filter(
      (policy) => policy.kind === ZERO_DAY_POLICY_KIND_DENY_TOOL
    );

    if (deniedToolPolicies.length > 0) {
      throw new CoreError(
        "VALIDATION",
        "Active zero-day deny_tool policies are not enforceable by WorkerBaselineLock."
      );
    }

    const additionalDeniedCategories = activePolicies.flatMap((policy) =>
      policy.kind === ZERO_DAY_POLICY_KIND_DENY_CATEGORY ? [policy.target] : []
    );
    const additionalHardStopRefs = activePolicies.flatMap((policy) =>
      policy.kind === ZERO_DAY_POLICY_KIND_HARD_STOP ? [policy.policy_id] : []
    );

    return WorkerBaselineLockSchema.parse({
      ...lock,
      denied_tool_categories: deduplicate([...lock.denied_tool_categories, ...additionalDeniedCategories]),
      hard_stop_refs: deduplicate([...lock.hard_stop_refs, ...additionalHardStopRefs])
    });
  }

  public async getSecurityStatus(workspaceId: string): Promise<SecurityStatusContract> {
    return (await this.evaluateSecurityStatus(workspaceId)).status;
  }

  public async initializeWorkspaceSecurity(workspaceId: string): Promise<boolean> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);
    const nowMs = readClockSnapshot(this.deps.now).epochMs;
    this.pruneInitializedWorkspaceIds(nowMs);

    const initializedUntilMs = this.initializedWorkspaceIds.get(parsedWorkspaceId);

    if (initializedUntilMs !== undefined && initializedUntilMs > nowMs) {
      return false;
    }

    this.initializedWorkspaceIds.set(
      parsedWorkspaceId,
      nowMs + this.readInitializedWorkspaceCacheTtlMs()
    );
    this.enforceInitializedWorkspaceIdsLimit();
    return true;
  }

  public subscribeStatusEvaluations(observer: ZeroDaySecurityStatusEvaluationObserver): () => void {
    this.statusEvaluationObservers.add(observer);

    return () => {
      this.statusEvaluationObservers.delete(observer);
    };
  }

  private async notifyStatusEvaluated(
    status: Readonly<SecurityStatusContract>,
    reason: string
  ): Promise<void> {
    for (const observer of this.statusEvaluationObservers) {
      await observer(status, reason);
    }
  }

  private async evaluateSecurityStatus(workspaceId: string): Promise<{
    readonly activePolicies: readonly ZeroDayPolicy[];
    readonly status: SecurityStatusContract;
  }> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);
    const { now, activePolicies } = await this.readActivePolicyEvaluation();

    return {
      activePolicies,
      status: createSecurityStatus(parsedWorkspaceId, now, activePolicies)
    };
  }

  private async readActivePolicyEvaluation(): Promise<ActivePolicyEvaluation> {
    const clock = readClockSnapshot(this.deps.now);
    const cachedEvaluation = this.cachedPolicyEvaluation;

    if (cachedEvaluation !== null && cachedEvaluation.expiresAtMs > clock.epochMs) {
      return cachedEvaluation;
    }

    const evaluatedPolicies = await evaluateActivePolicies(this.deps.loadPolicies, clock.iso);
    this.cachedPolicyEvaluation = {
      ...evaluatedPolicies,
      expiresAtMs: clock.epochMs + this.readPolicyEvaluationCacheTtlMs()
    };

    return evaluatedPolicies;
  }

  private readPolicyEvaluationCacheTtlMs(): number {
    return normalizePositiveNumber(
      this.deps.policyEvaluationCacheTtlMs,
      DEFAULT_POLICY_EVALUATION_CACHE_TTL_MS
    );
  }

  private readInitializedWorkspaceCacheTtlMs(): number {
    return normalizePositiveNumber(
      this.deps.initializedWorkspaceCacheTtlMs,
      DEFAULT_INITIALIZED_WORKSPACE_CACHE_TTL_MS
    );
  }

  private readInitializedWorkspaceCacheMaxEntries(): number {
    return normalizePositiveInteger(
      this.deps.initializedWorkspaceCacheMaxEntries,
      DEFAULT_INITIALIZED_WORKSPACE_CACHE_MAX_ENTRIES
    );
  }

  private pruneInitializedWorkspaceIds(nowMs: number): void {
    for (const [workspaceId, expiresAtMs] of this.initializedWorkspaceIds) {
      if (expiresAtMs <= nowMs) {
        this.initializedWorkspaceIds.delete(workspaceId);
      }
    }
  }

  private enforceInitializedWorkspaceIdsLimit(): void {
    const maxEntries = this.readInitializedWorkspaceCacheMaxEntries();
    while (this.initializedWorkspaceIds.size > maxEntries) {
      const workspaceIdToEvict = findSoonestExpiringWorkspaceId(this.initializedWorkspaceIds);
      if (workspaceIdToEvict === undefined) {
        break;
      }
      this.initializedWorkspaceIds.delete(workspaceIdToEvict);
    }
  }
}

function isActive(policy: ZeroDayPolicy, now: string): boolean {
  const nowMs = Date.parse(now);
  const effectiveAtMs = Date.parse(policy.effective_at);

  if (effectiveAtMs > nowMs) {
    return false;
  }

  if (policy.expires_at === null) {
    return true;
  }

  return Date.parse(policy.expires_at) > nowMs;
}

function parsePolicies(policies: readonly ZeroDayPolicy[]): readonly ZeroDayPolicy[] {
  try {
    return policies.map((policy) => ZeroDayPolicySchema.parse(policy));
  } catch (error) {
    throw new CoreError("VALIDATION", "Zero-day policy loader returned an invalid policy", {
      cause: error instanceof Error ? error : undefined
    });
  }
}

function parseWorkspaceId(workspaceId: string): string {
  try {
    return NonEmptyStringSchema.parse(workspaceId);
  } catch (error) {
    throw new CoreError("VALIDATION", "Workspace id must be a non-empty string", {
      cause: error instanceof Error ? error : undefined
    });
  }
}

function parseNow(now: string): string {
  try {
    return IsoDatetimeStringSchema.parse(now);
  } catch (error) {
    throw new CoreError("VALIDATION", "Zero-day policy clock returned an invalid timestamp", {
      cause: error instanceof Error ? error : undefined
    });
  }
}

async function evaluateActivePolicies(
  loadPolicies: () => Promise<readonly ZeroDayPolicy[]>,
  now: string
): Promise<ActivePolicyEvaluation> {
  const allPolicies = parsePolicies(await loadPolicies());
  const parsedNow = parseNow(now);

  return {
    now: parsedNow,
    activePolicies: allPolicies.filter((policy) => isActive(policy, parsedNow))
  };
}

function createSecurityStatus(
  workspaceId: string,
  now: string,
  activePolicies: readonly ZeroDayPolicy[]
): SecurityStatusContract {
  return SecurityStatusContractSchema.parse({
    workspace_id: workspaceId,
    posture: derivePosture(activePolicies),
    zero_day_active: activePolicies.length > 0,
    active_security_locks: countActiveSecurityLocks(activePolicies),
    last_assessment_at: now,
    active_protections: listActiveProtections(activePolicies)
  });
}

function derivePosture(activePolicies: readonly ZeroDayPolicy[]): SecurityPosture {
  if (activePolicies.some((policy) => policy.kind === ZERO_DAY_POLICY_KIND_HARD_STOP)) {
    return "locked_down";
  }

  if (activePolicies.some((policy) => policy.kind === ZERO_DAY_POLICY_KIND_DENY_TOOL)) {
    return "elevated";
  }

  if (activePolicies.some((policy) => policy.kind === ZERO_DAY_POLICY_KIND_DENY_CATEGORY)) {
    return "configured";
  }

  return "baseline";
}

function countActiveSecurityLocks(activePolicies: readonly ZeroDayPolicy[]): number {
  return new Set(activePolicies.map((policy) => policy.policy_id)).size;
}

function listActiveProtections(activePolicies: readonly ZeroDayPolicy[]): readonly string[] {
  return deduplicate(activePolicies.map((policy) => describeProtection(policy)));
}

function describeProtection(policy: ZeroDayPolicy): string {
  switch (policy.kind) {
    case ZERO_DAY_POLICY_KIND_DENY_CATEGORY:
      return `deny category: ${policy.target}`;
    case ZERO_DAY_POLICY_KIND_DENY_TOOL:
      return `deny tool: ${policy.target}`;
    case ZERO_DAY_POLICY_KIND_HARD_STOP:
      return `hard stop: ${policy.target}`;
  }
}

function deduplicate<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function findSoonestExpiringWorkspaceId(
  initializedWorkspaceIds: ReadonlyMap<string, number>
): string | undefined {
  let workspaceIdToEvict: string | undefined;
  let earliestExpiryMs = Number.POSITIVE_INFINITY;

  for (const [workspaceId, expiresAtMs] of initializedWorkspaceIds) {
    if (expiresAtMs < earliestExpiryMs) {
      workspaceIdToEvict = workspaceId;
      earliestExpiryMs = expiresAtMs;
    }
  }

  return workspaceIdToEvict;
}

function normalizePositiveNumber(candidate: number | undefined, fallback: number): number {
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
    return fallback;
  }
  return candidate;
}

function normalizePositiveInteger(candidate: number | undefined, fallback: number): number {
  const normalized = normalizePositiveNumber(candidate, fallback);
  return Number.isInteger(normalized) ? normalized : Math.floor(normalized);
}
