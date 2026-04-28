import { type Context, type Hono } from "hono";
import {
  CoreError,
  type NarrativeBudgetService,
  type RunService,
  type SerialDelegationService,
  type WorkerTrustAssessor
} from "@do-what/core";
import { parseJsonBody } from "./shared.js";
import {
  WorkerDispatchRequestSchema,
  WorkerDispatchResponseSchema,
  type GovernanceLease,
  NarrativeBudgetConfigSchema,
  type NarrativeBudgetConfig,
  type WorkerDispatchRequest
} from "@do-what/protocol";
type DispatchWorkerBody = WorkerDispatchRequest;

export interface WorkerDispatchRouteServices {
  readonly runService: RunService;
  readonly serialDelegationService: Pick<SerialDelegationService, "dispatch">;
  readonly governanceLeaseService?: {
    getActive(runId: string): Promise<Readonly<GovernanceLease> | null>;
  };
  readonly workerDispatchPromptAssembler?: WorkerDispatchPromptAssemblerPort;
  readonly workerTrustAssessor?: Pick<WorkerTrustAssessor, "assess">;
  readonly narrativeBudgetService?: Pick<NarrativeBudgetService, "checkBudget" | "triggerConsolidation">;
  readonly narrativeBudgetConfig?: NarrativeBudgetConfig;
  readonly listServerHardConstraints?: (workspaceId: string) => Promise<readonly ServerHardConstraint[]>;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

export interface WorkerDispatchPromptAssemblerPort {
  assemble(input: {
    readonly callerPrompt: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly principalSecuritySnapshot: {
      readonly governance_lease_ref: string;
      readonly hard_constraint_refs: readonly string[];
      readonly denied_tool_categories: readonly string[];
    };
    readonly serverTruthHardConstraints?: readonly ServerHardConstraint[];
  }): string | Promise<string>;
  assembleWithMetadata?(input: {
    readonly callerPrompt: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly principalSecuritySnapshot: {
      readonly governance_lease_ref: string;
      readonly hard_constraint_refs: readonly string[];
      readonly denied_tool_categories: readonly string[];
    };
    readonly serverTruthHardConstraints?: readonly ServerHardConstraint[];
  }):
    | Readonly<{
        readonly prompt: string;
        readonly resolvedHardConstraintRefs: readonly string[];
        readonly constitutionalAssetsBound: boolean;
      }>
    | Promise<
        Readonly<{
          readonly prompt: string;
          readonly resolvedHardConstraintRefs: readonly string[];
          readonly constitutionalAssetsBound: boolean;
        }>
      >;
}

interface ServerHardConstraint {
  readonly ref: string;
  readonly resolved_ref?: string;
  readonly content: string;
}

const NO_LIVE_GOVERNANCE_LEASE_REF_PREFIX = "governance://no-live-lease/";

export function registerWorkerDispatchRoutes(app: Hono, services: WorkerDispatchRouteServices): void {
  app.post("/runs/:id/workers/dispatch", async (context) => {
    const principalRunId = context.req.param("id");

    const principalRun = await services.runService.getById(principalRunId);
    const body = parseDispatchWorkerBody(await parseJsonBody(context.req.json.bind(context.req)));
    const [serverHardConstraints, activeGovernanceLease] = await Promise.all([
      services.listServerHardConstraints?.(principalRun.workspace_id),
      services.governanceLeaseService?.getActive(principalRun.run_id)
    ]);
    const effectiveHardConstraintRefs = resolveEffectiveHardConstraintRefs({
      callerHardConstraintRefs: body.principalSecuritySnapshot.hard_constraint_refs,
      serverHardConstraints,
      warn: services.warn,
      workspaceId: principalRun.workspace_id,
      runId: principalRun.run_id
    });
    const effectiveGovernanceLeaseRef = resolveEffectiveGovernanceLeaseRef({
      callerGovernanceLeaseRef: body.principalSecuritySnapshot.governance_lease_ref,
      activeGovernanceLeaseRef: activeGovernanceLease?.lease_id ?? null,
      warn: services.warn,
      workspaceId: principalRun.workspace_id,
      runId: principalRun.run_id
    });
    const effectiveSnapshot = {
      ...body.principalSecuritySnapshot,
      governance_lease_ref: effectiveGovernanceLeaseRef,
      hard_constraint_refs: effectiveHardConstraintRefs
    };
    const initialPromptAssembly = await assembleWorkerDispatchPrompt({
      services,
      callerPrompt: body.prompt,
      workspaceId: principalRun.workspace_id,
      runId: principalRun.run_id,
      principalSecuritySnapshot: effectiveSnapshot,
      serverTruthHardConstraints: serverHardConstraints
    });
    const finalPrompt = initialPromptAssembly?.prompt ?? body.prompt;
    const dispatchedWorkerRun = await dispatchWorkerOrReturnConflict({
      context,
      services,
      principalRunId: principalRun.run_id,
      workspaceId: principalRun.workspace_id,
      body,
      effectiveSnapshot,
      finalPrompt,
      serverHardConstraints
    });
    if (dispatchedWorkerRun instanceof Response) {
      return dispatchedWorkerRun;
    }

    const workerRun = WorkerDispatchResponseSchema.parse(dispatchedWorkerRun);
    const postDispatchPromptAssembly = await assembleWorkerDispatchPrompt({
      services,
      callerPrompt: body.prompt,
      workspaceId: principalRun.workspace_id,
      runId: principalRun.run_id,
      principalSecuritySnapshot: workerRun.principal_security_snapshot,
      serverTruthHardConstraints: serverHardConstraints
    });
    schedulePostDispatchGovernance({
      services,
      workspaceId: principalRun.workspace_id,
      runId: principalRun.run_id,
      workerRun,
      constitutionalAssetsBound:
        postDispatchPromptAssembly?.constitutionalAssetsBound ??
        initialPromptAssembly?.constitutionalAssetsBound ??
        services.workerDispatchPromptAssembler !== undefined
    });

    return context.json({ success: true, data: workerRun }, 201);
  });
}

async function dispatchWorkerOrReturnConflict(input: {
  readonly context: Context;
  readonly services: WorkerDispatchRouteServices;
  readonly principalRunId: string;
  readonly workspaceId: string;
  readonly body: DispatchWorkerBody;
  readonly effectiveSnapshot: DispatchWorkerBody["principalSecuritySnapshot"];
  readonly finalPrompt: string;
  readonly serverHardConstraints: readonly ServerHardConstraint[] | undefined;
}): Promise<Awaited<ReturnType<WorkerDispatchRouteServices["serialDelegationService"]["dispatch"]>> | Response> {
  try {
    return await input.services.serialDelegationService.dispatch({
      principalRunId: input.principalRunId,
      workspaceId: input.workspaceId,
      engineClass: input.body.engineClass,
      subtaskDescription: input.body.subtaskDescription,
      localSurfaceRef: input.body.localSurfaceRef,
      localEvidencePointer: input.body.localEvidencePointer,
      restrictedToolSet: input.body.restrictedToolSet,
      localBudget: input.body.localBudget,
      agreedReturnFormat: input.body.agreedReturnFormat,
      principalSecuritySnapshot: input.effectiveSnapshot,
      sessionConfig: {
        ...input.body.sessionConfig,
        workspace_id: input.workspaceId,
        run_id: input.principalRunId
      },
      prompt: input.finalPrompt,
      resolveRuntimePromptFromFinalSecuritySnapshot: async ({ workerRun: finalWorkerRun }) => {
        const assembled = await assembleWorkerDispatchPrompt({
          services: input.services,
          callerPrompt: input.body.prompt,
          workspaceId: input.workspaceId,
          runId: input.principalRunId,
          principalSecuritySnapshot: finalWorkerRun.principal_security_snapshot,
          serverTruthHardConstraints: input.serverHardConstraints
        });

        if (assembled !== null) {
          return assembled.prompt;
        }

        return input.finalPrompt;
      }
    });
  } catch (error) {
    const conflict = classifyWorkerDispatchConflict(error);
    if (conflict !== null) {
      return input.context.json(
        {
          success: false,
          error: {
            code: conflict.code,
            status: "conflict",
            detail: conflict.detail
          }
        },
        409
      );
    }

    throw error;
  }
}

function classifyWorkerDispatchConflict(error: unknown): {
  readonly code: "active_worker_exists" | "integration_hard_stale" | "worker_baseline_hard_stop";
  readonly error: string;
  readonly detail: string;
} | null {
  if (!(error instanceof CoreError) || error.code !== "CONFLICT") {
    return null;
  }

  if (error.message.startsWith("Serial delegation: principal ") && error.message.endsWith(" already has an in-flight worker")) {
    return {
      code: "active_worker_exists",
      error: "Worker dispatch conflict",
      detail: "Serial delegation allows only one active worker."
    };
  }

  if (error.message.startsWith("Serial delegation blocked by integration gate: ")) {
    return {
      code: "integration_hard_stale",
      error: "Worker dispatch conflict",
      detail: "Worker integration drift is hard-stale; dispatch is blocked until the runtime baseline is repaired."
    };
  }

  if (error.message.startsWith("Serial delegation blocked by worker baseline hard stop: ")) {
    return {
      code: "worker_baseline_hard_stop",
      error: "Worker dispatch conflict",
      detail: "Worker baseline safety is in hard-stop; dispatch is blocked until baseline constraints are repaired."
    };
  }

  return null;
}

const DEFAULT_NARRATIVE_BUDGET_CONFIG = NarrativeBudgetConfigSchema.parse({
  max_total_digest_bytes: 64 * 1024,
  max_digests_per_run: 32,
  consolidation_threshold_pct: 100
});

function schedulePostDispatchGovernance(input: {
  readonly services: WorkerDispatchRouteServices;
  readonly workspaceId: string;
  readonly runId: string;
  readonly workerRun: Awaited<ReturnType<WorkerDispatchRouteServices["serialDelegationService"]["dispatch"]>>;
  readonly constitutionalAssetsBound: boolean;
}): void {
  queueMicrotask(() => {
    void runPostDispatchGovernance(input).catch((error) => {
      input.services.warn?.("worker dispatch post-dispatch governance execution failed", {
        workspaceId: input.workspaceId,
        runId: input.runId,
        workerRunId: input.workerRun.worker_run_id,
        error
      });
    });
  });
}

async function runPostDispatchGovernance(input: {
  readonly services: WorkerDispatchRouteServices;
  readonly workspaceId: string;
  readonly runId: string;
  readonly workerRun: Awaited<ReturnType<WorkerDispatchRouteServices["serialDelegationService"]["dispatch"]>>;
  readonly constitutionalAssetsBound: boolean;
}): Promise<void> {
  const budgetConfig = input.services.narrativeBudgetConfig ?? DEFAULT_NARRATIVE_BUDGET_CONFIG;
  let budgetTruthAvailable = input.services.narrativeBudgetService === undefined;
  const budgetStatus = {
    withinLimits: true,
    currentBytes: 0,
    currentCount: 0
  };

  if (input.services.narrativeBudgetService !== undefined) {
    try {
      const nextBudgetStatus = await input.services.narrativeBudgetService.checkBudget(
        input.workspaceId,
        input.runId,
        budgetConfig
      );
      budgetTruthAvailable = true;
      budgetStatus.withinLimits = nextBudgetStatus.withinLimits;
      budgetStatus.currentBytes = nextBudgetStatus.currentBytes;
      budgetStatus.currentCount = nextBudgetStatus.currentCount;

      if (!nextBudgetStatus.withinLimits) {
        await input.services.narrativeBudgetService.triggerConsolidation(
          input.workspaceId,
          input.runId
        );
      }
    } catch (error) {
      input.services.warn?.("narrative budget post-dispatch check failed", {
        workspaceId: input.workspaceId,
        runId: input.runId,
        error
      });
      budgetTruthAvailable = false;
    }
  }

  if (input.services.workerTrustAssessor === undefined || !budgetTruthAvailable) {
    return;
  }

  try {
    await input.services.workerTrustAssessor.assess({
      workerRun: input.workerRun,
      hasGovernanceLease: hasLiveGovernanceLease(input.workerRun.principal_security_snapshot.governance_lease_ref),
      hardConstraintCount: new Set(input.workerRun.principal_security_snapshot.hard_constraint_refs).size,
      toolSetRestricted: input.workerRun.restricted_tool_set.length > 0,
      constitutionalAssetsBound: input.constitutionalAssetsBound,
      budgetStatus: {
        withinLimits: budgetStatus.withinLimits
      }
    });
  } catch (error) {
    input.services.warn?.("worker trust assessment failed on dispatch path", {
      workspaceId: input.workspaceId,
      runId: input.runId,
      workerRunId: input.workerRun.worker_run_id,
      error
    });
  }
}

function resolveEffectiveHardConstraintRefs(input: {
  readonly callerHardConstraintRefs: readonly string[];
  readonly serverHardConstraints: readonly ServerHardConstraint[] | undefined;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly workspaceId: string;
  readonly runId: string;
}): readonly string[] {
  const callerRefs = dedupeNonEmptyStrings(input.callerHardConstraintRefs);

  if (input.serverHardConstraints === undefined) {
    return Object.freeze(callerRefs);
  }

  const resolvedRefByAcceptedRef = new Map<string, string>();
  for (const constraint of input.serverHardConstraints) {
    const acceptedRef = constraint.ref.trim();
    const resolvedRef = (constraint.resolved_ref ?? constraint.ref).trim();

    if (acceptedRef.length === 0 || resolvedRef.length === 0) {
      continue;
    }

    resolvedRefByAcceptedRef.set(acceptedRef, resolvedRef);
    resolvedRefByAcceptedRef.set(resolvedRef, resolvedRef);
  }

  const validatedRefs = callerRefs.flatMap((ref) => {
    const resolvedRef = resolvedRefByAcceptedRef.get(ref);
    return resolvedRef === undefined ? [] : [resolvedRef];
  });

  if (validatedRefs.length !== callerRefs.length) {
    const dropped = callerRefs.filter((ref) => !resolvedRefByAcceptedRef.has(ref));
    input.warn?.("worker dispatch dropped unverified hard constraint refs", {
      workspaceId: input.workspaceId,
      runId: input.runId,
      droppedHardConstraintRefs: dropped
    });
  }

  return Object.freeze([...new Set(validatedRefs)]);
}

function resolveEffectiveGovernanceLeaseRef(input: {
  readonly callerGovernanceLeaseRef: string;
  readonly activeGovernanceLeaseRef: string | null;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly workspaceId: string;
  readonly runId: string;
}): string {
  const liveLeaseRef = input.activeGovernanceLeaseRef;

  if (liveLeaseRef !== null) {
    if (liveLeaseRef !== input.callerGovernanceLeaseRef) {
      input.warn?.("worker dispatch replaced caller governance lease ref with live server truth", {
        workspaceId: input.workspaceId,
        runId: input.runId,
        callerGovernanceLeaseRef: input.callerGovernanceLeaseRef,
        effectiveGovernanceLeaseRef: liveLeaseRef
      });
    }
    return liveLeaseRef;
  }

  const noLiveLeaseRef = `${NO_LIVE_GOVERNANCE_LEASE_REF_PREFIX}${input.runId}`;
  input.warn?.("worker dispatch enforced backend-owned no-live-lease snapshot ref", {
    workspaceId: input.workspaceId,
    runId: input.runId,
    callerGovernanceLeaseRef: input.callerGovernanceLeaseRef,
    effectiveGovernanceLeaseRef: noLiveLeaseRef
  });
  return noLiveLeaseRef;
}

function hasLiveGovernanceLease(governanceLeaseRef: string): boolean {
  return !governanceLeaseRef.startsWith(NO_LIVE_GOVERNANCE_LEASE_REF_PREFIX);
}

async function assembleWorkerDispatchPrompt(input: {
  readonly services: WorkerDispatchRouteServices;
  readonly callerPrompt: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly principalSecuritySnapshot: {
    readonly governance_lease_ref: string;
    readonly hard_constraint_refs: readonly string[];
    readonly denied_tool_categories: readonly string[];
  };
  readonly serverTruthHardConstraints: readonly ServerHardConstraint[] | undefined;
}): Promise<
  Readonly<{
  readonly prompt: string;
  readonly resolvedHardConstraintRefs: readonly string[];
  readonly constitutionalAssetsBound: boolean;
  }>
  | null
> {
  const assembler = input.services.workerDispatchPromptAssembler;
  if (assembler === undefined) {
    return null;
  }

  const assembledWithMetadata = await assembler.assembleWithMetadata?.({
    callerPrompt: input.callerPrompt,
    workspaceId: input.workspaceId,
    runId: input.runId,
    principalSecuritySnapshot: input.principalSecuritySnapshot,
    serverTruthHardConstraints: input.serverTruthHardConstraints
  });

  if (assembledWithMetadata !== undefined) {
    return assembledWithMetadata;
  }

  return Object.freeze({
    prompt: await assembler.assemble({
      callerPrompt: input.callerPrompt,
      workspaceId: input.workspaceId,
      runId: input.runId,
      principalSecuritySnapshot: input.principalSecuritySnapshot,
      serverTruthHardConstraints: input.serverTruthHardConstraints
    }),
    resolvedHardConstraintRefs: Object.freeze([...input.principalSecuritySnapshot.hard_constraint_refs]),
    constitutionalAssetsBound: true
  });
}

function dedupeNonEmptyStrings(values: readonly string[]): string[] {
  const uniqueValues = new Set<string>();

  for (const value of values) {
    if (value.trim().length > 0) {
      uniqueValues.add(value);
    }
  }

  return [...uniqueValues];
}

function parseDispatchWorkerBody(body: unknown): DispatchWorkerBody {
  try {
    return WorkerDispatchRequestSchema.parse(body);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request", {
      cause: error instanceof Error ? error : undefined
    });
  }
}
