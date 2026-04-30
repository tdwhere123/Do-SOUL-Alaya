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
  type WorkspaceEngineConfigRepoPort,
  type WorkspaceRepoPort,
  type WorkspaceRunRepoPort,
  type WorkspaceServiceDependencies,
  type ZeroDaySecurityLayer
} from "@do-soul/alaya-core";

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
    bootstrappingRecordRepo: deps.bootstrappingRecordRepo
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
      securityStatusService
    )
  };
}

export function withSecurityStatusWorkspaceService(
  workspaceService: WorkspaceService,
  securityStatusService: Pick<
    SecurityStatusService,
    "initializeWorkspace" | "recordInitializationFailure"
  >
): WorkspaceService {
  return new Proxy(workspaceService, {
    get(target, property, receiver) {
      if (property === "create") {
        return async (input: unknown) => {
          const workspace = await target.create(input);
          try {
            await securityStatusService.initializeWorkspace(workspace.workspace_id);
          } catch (error) {
            if (error instanceof EventPublisherPropagationError) {
              return workspace;
            }
            await recordInitializationFailureSafely(
              securityStatusService,
              workspace.workspace_id,
              "create",
              error
            );
          }
          return workspace;
        };
      }

      if (property === "list") {
        return async () => {
          const workspaces = await target.list();
          await Promise.all(
            workspaces.map(async (workspace) => {
              try {
                await securityStatusService.initializeWorkspace(workspace.workspace_id);
              } catch (error) {
                if (error instanceof EventPublisherPropagationError) {
                  return;
                }
                await recordInitializationFailureSafely(
                  securityStatusService,
                  workspace.workspace_id,
                  "list",
                  error
                );
              }
            })
          );
          return workspaces;
        };
      }

      if (property === "getById") {
        return async (workspaceId: string) => {
          const workspace = await target.getById(workspaceId);
          try {
            await securityStatusService.initializeWorkspace(workspace.workspace_id);
          } catch (error) {
            if (error instanceof EventPublisherPropagationError) {
              return workspace;
            }
            await recordInitializationFailureSafely(
              securityStatusService,
              workspace.workspace_id,
              "get_by_id",
              error
            );
          }
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

async function recordInitializationFailureSafely(
  securityStatusService: Pick<SecurityStatusService, "recordInitializationFailure">,
  workspaceId: string,
  operation: "create" | "list" | "get_by_id",
  error: unknown
): Promise<void> {
  try {
    await securityStatusService.recordInitializationFailure(
      workspaceId,
      operation,
      inferInitializationFailureReason(error),
      inferInitializationFailureCode(error)
    );
  } catch {
    // Preserve non-fatal bootstrap semantics even when the witness event cannot be recorded.
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
