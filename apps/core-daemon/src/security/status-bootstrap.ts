import {
  EventPublisher,
  EventPublisherPropagationError,
  RunHotStateService,
  SecurityStatusService,
  WorkspaceService,
  type EventPublisherEventLogRepoPort,
  type RuntimeNotifier,
  type RunHotStateEventLogRepoPort,
  type RunHotStateRunRepoPort,
  type WorkspaceCreationMutation,
  type WorkspaceEngineConfigRepoPort,
  type WorkspaceRepoPort,
  type WorkspaceRunRepoPort,
  type WorkspaceServiceDependencies,
  type ZeroDaySecurityLayer
} from "@do-soul/alaya-core";
import type {
  SecurityPassthroughInitializationFailedPayload,
  Workspace
} from "@do-soul/alaya-protocol";

export type WorkspaceEnsureMutation = (workspace: Workspace) => void;

export interface SecurityStatusBootstrapDependencies {
  readonly workspaceRepo: WorkspaceRepoPort;
  readonly runRepo: WorkspaceRunRepoPort & RunHotStateRunRepoPort;
  readonly eventLogRepo: EventPublisherEventLogRepoPort & RunHotStateEventLogRepoPort;
  readonly runtimeNotifier: RuntimeNotifier;
  readonly zeroDayLayer: Pick<
    ZeroDaySecurityLayer,
    "getSecurityStatus" | "initializeWorkspaceSecurity" | "subscribeStatusEvaluations"
  >;
  readonly engineConfigRepo?: WorkspaceEngineConfigRepoPort;
  readonly bootstrappingPlanner?: WorkspaceServiceDependencies["bootstrappingPlanner"];
  readonly pathRelationRepo?: WorkspaceServiceDependencies["pathRelationRepo"];
  readonly bootstrappingRecordRepo?: WorkspaceServiceDependencies["bootstrappingRecordRepo"];
  readonly workspaceCreationMutation?: WorkspaceCreationMutation;
  readonly workspaceEnsureMutation?: WorkspaceEnsureMutation;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

export interface SecurityStatusBootstrapServices {
  readonly eventPublisher: EventPublisher;
  readonly runHotStateService: RunHotStateService;
  readonly rawWorkspaceService: WorkspaceService;
  readonly securityStatusService: SecurityStatusService;
  readonly workspaceService: WorkspaceService;
}

export function createSecurityStatusBootstrapServices(
  deps: SecurityStatusBootstrapDependencies
): SecurityStatusBootstrapServices {
  const runHotStateService = new RunHotStateService({
    runRepo: deps.runRepo,
    eventLogRepo: deps.eventLogRepo
  });
  const eventPublisher = new EventPublisher({
    eventLogRepo: deps.eventLogRepo,
    runHotStateService,
    runtimeNotifier: deps.runtimeNotifier
  });
  const rawWorkspaceService = new WorkspaceService({
    workspaceRepo: deps.workspaceRepo,
    runRepo: deps.runRepo,
    eventPublisher,
    engineConfigRepo: deps.engineConfigRepo,
    bootstrappingPlanner: deps.bootstrappingPlanner,
    pathRelationRepo: deps.pathRelationRepo,
    bootstrappingRecordRepo: deps.bootstrappingRecordRepo,
    workspaceCreationMutation: deps.workspaceCreationMutation
  });
  const securityStatusService = new SecurityStatusService({
    zeroDayLayer: deps.zeroDayLayer,
    eventPublisher
  });
  return {
    eventPublisher,
    runHotStateService,
    rawWorkspaceService,
    securityStatusService,
    workspaceService: withSecurityStatusWorkspaceService(
      rawWorkspaceService,
      securityStatusService,
      deps.workspaceEnsureMutation,
      deps.warn
    )
  };
}

type SecurityWorkspaceInitOperation = SecurityPassthroughInitializationFailedPayload["operation"];

export function withSecurityStatusWorkspaceService(
  workspaceService: WorkspaceService,
  securityStatusService: Pick<
    SecurityStatusService,
    "initializeWorkspace" | "recordInitializationFailure"
  >,
  workspaceEnsureMutation?: WorkspaceEnsureMutation,
  warn?: (message: string, meta: Record<string, unknown>) => void
): WorkspaceService {
  return new Proxy(workspaceService, {
    get(target, property, receiver) {
      if (property === "create") {
        return async (input: unknown) => {
          const workspace = await target.create(input);
          await initializeWorkspaceNonfatally(
            securityStatusService,
            workspace.workspace_id,
            "create",
            warn
          );
          return workspace;
        };
      }

      if (property === "ensureLocalWorkspace") {
        return async (
          input: Parameters<WorkspaceService["ensureLocalWorkspace"]>[0]
        ) => {
          const workspace = await target.ensureLocalWorkspace(input);
          workspaceEnsureMutation?.(workspace);
          await initializeWorkspaceNonfatally(
            securityStatusService,
            workspace.workspace_id,
            "ensure",
            warn
          );
          return workspace;
        };
      }

      if (property === "list") {
        return async () => {
          const workspaces = await target.list();
          await Promise.all(
            workspaces.map(async (workspace) => {
              await initializeWorkspaceNonfatally(
                securityStatusService,
                workspace.workspace_id,
                "list",
                warn
              );
            })
          );
          return workspaces;
        };
      }

      if (property === "getById") {
        return async (workspaceId: string) => {
          const workspace = await target.getById(workspaceId);
          await initializeWorkspaceNonfatally(
            securityStatusService,
            workspace.workspace_id,
            "get_by_id",
            warn
          );
          return workspace;
        };
      }

      const member = Reflect.get(target, property, receiver);

      if (typeof member === "function") {
        return member.bind(target);
      }

      return member;
    }
  });
}

async function initializeWorkspaceNonfatally(
  securityStatusService: Pick<
    SecurityStatusService,
    "initializeWorkspace" | "recordInitializationFailure"
  >,
  workspaceId: string,
  operation: SecurityWorkspaceInitOperation,
  warn?: (message: string, meta: Record<string, unknown>) => void
): Promise<void> {
  try {
    await securityStatusService.initializeWorkspace(workspaceId);
  } catch (error) {
    if (error instanceof EventPublisherPropagationError) {
      return;
    }
    await recordInitializationFailureSafely(
      securityStatusService,
      workspaceId,
      operation,
      error,
      warn
    );
  }
}

async function recordInitializationFailureSafely(
  securityStatusService: Pick<SecurityStatusService, "recordInitializationFailure">,
  workspaceId: string,
  operation: SecurityWorkspaceInitOperation,
  error: unknown,
  warn?: (message: string, meta: Record<string, unknown>) => void
): Promise<void> {
  try {
    await securityStatusService.recordInitializationFailure(
      workspaceId,
      operation,
      inferInitializationFailureReason(error),
      inferInitializationFailureCode(error)
    );
  } catch (recordError) {
    // Preserve non-fatal bootstrap semantics even when the witness event cannot be recorded.
    warn?.("security initialization failure could not be recorded", {
      workspace: workspaceId,
      operation,
      error: recordError instanceof Error ? recordError.message : String(recordError)
    });
  }
}

function inferInitializationFailureReason(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : "unknown";
  }

  return "unknown";
}

function inferInitializationFailureCode(error: unknown): string {
  if (error instanceof Error) {
    const candidateCode = (error as NodeJS.ErrnoException).code;
    const runtimeCode = typeof candidateCode === "string" ? candidateCode.trim() : "";

    if (runtimeCode.length > 0) {
      return runtimeCode;
    }

    const constructorName = error.constructor.name.trim();
    return constructorName.length > 0 ? constructorName : "unknown";
  }

  return "unknown";
}
