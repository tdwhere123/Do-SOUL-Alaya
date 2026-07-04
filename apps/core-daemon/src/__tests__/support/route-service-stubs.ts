import type {
  ClaimService,
  ConversationService,
  EvidenceService,
  MemoryService,
  ProposalService,
  RecallService,
  RunHotStateService,
  RunService,
  SignalService,
  SynthesisService,
  TaskSurfaceBuilder,
  WorkspaceService
} from "@do-soul/alaya-core";
import type { McpMemoryToolHandler } from "../../mcp-memory/tool-handler.js";
import type { ClaimRouteServices } from "../../routes/governance/claims.js";
import type { ConflictMatrixRouteServices } from "../../routes/governance/conflict-matrix.js";
import type { ConfigRouteServices } from "../../routes/workspace/config.js";
import type { EvidenceRouteServices } from "../../routes/memory/evidence.js";
import type { GlobalMemoryRouteServices } from "../../routes/memory/global-memory.js";
import type { MemoryRouteServices } from "../../routes/memory/memories.js";
import type { ProposalRouteServices } from "../../routes/governance/proposals-types.js";
import type { RecallRouteServices } from "../../routes/memory/recall.js";
import type { RunRouteServices } from "../../routes/workspace/runs.js";
import type { SignalRouteServices } from "../../routes/workspace/signals.js";
import type { SynthesisRouteServices } from "../../routes/memory/syntheses.js";
import type { WorkspaceRouteServices } from "../../routes/workspace/workspaces.js";
import { implementPort, type LooseStub } from "./implement-port.js";

// Assemble any route-service bag from a structurally-loose override. The
// proxy still throws on unimplemented methods, so tests only declare the
// services a route actually touches.
export function routeServices<T extends object>(overrides: LooseStub<T> = {} as LooseStub<T>): T {
  return implementPort<T>(overrides);
}

export function workspaceServiceStub(
  overrides: LooseStub<WorkspaceService> = {}
): WorkspaceService {
  return implementPort<WorkspaceService>(overrides);
}

export function runServiceStub(overrides: LooseStub<RunService> = {}): RunService {
  return implementPort<RunService>(overrides);
}

export function memoryServiceStub(overrides: LooseStub<MemoryService> = {}): MemoryService {
  return implementPort<MemoryService>(overrides);
}

export function evidenceServiceStub(overrides: LooseStub<EvidenceService> = {}): EvidenceService {
  return implementPort<EvidenceService>(overrides);
}

export function claimServiceStub(overrides: LooseStub<ClaimService> = {}): ClaimService {
  return implementPort<ClaimService>(overrides);
}

export function recallServiceStub(overrides: LooseStub<RecallService> = {}): RecallService {
  return implementPort<RecallService>(overrides);
}

export function taskSurfaceBuilderStub(
  overrides: LooseStub<TaskSurfaceBuilder> = {}
): TaskSurfaceBuilder {
  return implementPort<TaskSurfaceBuilder>(overrides);
}

export function synthesisServiceStub(
  overrides: LooseStub<SynthesisService> = {}
): SynthesisService {
  return implementPort<SynthesisService>(overrides);
}

export function conversationServiceStub(
  overrides: LooseStub<ConversationService> = {}
): ConversationService {
  return implementPort<ConversationService>(overrides);
}

export function runHotStateServiceStub(
  overrides: LooseStub<RunHotStateService> = {}
): RunHotStateService {
  return implementPort<RunHotStateService>(overrides);
}

export function memoryRouteServices(
  overrides: {
    readonly workspaceService?: LooseStub<WorkspaceService>;
    readonly runService?: LooseStub<RunService>;
    readonly memoryService?: LooseStub<MemoryService>;
  } = {}
): MemoryRouteServices {
  return {
    workspaceService: workspaceServiceStub(overrides.workspaceService),
    runService: runServiceStub(overrides.runService),
    memoryService: memoryServiceStub(overrides.memoryService)
  };
}

export function recallRouteServices(
  overrides: {
    readonly recallService?: LooseStub<RecallService>;
    readonly taskSurfaceBuilder?: LooseStub<TaskSurfaceBuilder>;
    readonly runService?: LooseStub<RunService>;
    readonly workspaceService?: LooseStub<WorkspaceService>;
  } = {}
): RecallRouteServices {
  return {
    recallService: recallServiceStub(overrides.recallService),
    taskSurfaceBuilder: taskSurfaceBuilderStub(overrides.taskSurfaceBuilder),
    runService: runServiceStub(overrides.runService),
    workspaceService: workspaceServiceStub(overrides.workspaceService)
  };
}

export function evidenceRouteServices(
  overrides: {
    readonly workspaceService?: LooseStub<WorkspaceService>;
    readonly runService?: LooseStub<RunService>;
    readonly evidenceService?: LooseStub<EvidenceService>;
  } = {}
): EvidenceRouteServices {
  return {
    workspaceService: workspaceServiceStub(overrides.workspaceService),
    runService: runServiceStub(overrides.runService),
    evidenceService: evidenceServiceStub(overrides.evidenceService)
  };
}

export function claimRouteServices(
  overrides: {
    readonly workspaceService?: LooseStub<WorkspaceService>;
    readonly claimService?: LooseStub<ClaimService>;
  } = {}
): ClaimRouteServices {
  return {
    workspaceService: workspaceServiceStub(overrides.workspaceService),
    claimService: claimServiceStub(overrides.claimService)
  };
}

export function synthesisRouteServices(
  overrides: {
    readonly workspaceService?: LooseStub<WorkspaceService>;
    readonly synthesisService?: LooseStub<SynthesisRouteServices["synthesisService"]>;
  } = {}
): SynthesisRouteServices {
  return {
    workspaceService: workspaceServiceStub(overrides.workspaceService),
    synthesisService: synthesisServiceStub(overrides.synthesisService)
  };
}

export function signalRouteServices(
  overrides: {
    readonly runService?: LooseStub<RunService>;
    readonly signalService?: LooseStub<SignalService>;
  } = {}
): SignalRouteServices {
  return {
    runService: runServiceStub(overrides.runService),
    signalService: implementPort<SignalService>(overrides.signalService)
  };
}

export function globalMemoryRouteServices(
  overrides: {
    readonly workspaceService?: LooseStub<WorkspaceService>;
    readonly globalMemoryService?: LooseStub<GlobalMemoryRouteServices["globalMemoryService"]>;
  } = {}
): GlobalMemoryRouteServices {
  return {
    workspaceService: workspaceServiceStub(overrides.workspaceService),
    globalMemoryService: implementPort<GlobalMemoryRouteServices["globalMemoryService"]>(
      overrides.globalMemoryService
    )
  };
}

export function runRouteServices(
  overrides: {
    readonly runService?: LooseStub<RunService>;
    readonly workspaceService?: LooseStub<WorkspaceService>;
    readonly conversationService?: LooseStub<ConversationService>;
    readonly runHotStateService?: LooseStub<RunHotStateService>;
    readonly eventLogRepo?: RunRouteServices["eventLogRepo"];
    readonly warn?: RunRouteServices["warn"];
  } = {}
): RunRouteServices {
  return {
    runService: runServiceStub(overrides.runService),
    workspaceService: workspaceServiceStub(overrides.workspaceService),
    conversationService: conversationServiceStub(overrides.conversationService),
    runHotStateService: runHotStateServiceStub(overrides.runHotStateService),
    eventLogRepo: overrides.eventLogRepo,
    warn: overrides.warn
  };
}

export function workspaceRouteServices(
  overrides: {
    readonly workspaceService?: LooseStub<WorkspaceService>;
    readonly engineBindingService?: LooseStub<WorkspaceRouteServices["engineBindingService"]>;
    readonly codingEngineAvailable?: boolean;
    readonly workspaceGitBindingRepo?: WorkspaceRouteServices["workspaceGitBindingRepo"];
    readonly gitBindingValidation?: WorkspaceRouteServices["gitBindingValidation"];
  } = {}
): WorkspaceRouteServices {
  return {
    workspaceService: workspaceServiceStub(overrides.workspaceService),
    engineBindingService: implementPort<WorkspaceRouteServices["engineBindingService"]>(
      overrides.engineBindingService ?? {}
    ),
    codingEngineAvailable: overrides.codingEngineAvailable ?? false,
    workspaceGitBindingRepo: overrides.workspaceGitBindingRepo,
    gitBindingValidation: overrides.gitBindingValidation
  };
}

export function conflictMatrixRouteServices(
  overrides: {
    readonly workspaceService?: LooseStub<WorkspaceService>;
    readonly arbitrationService?: LooseStub<ConflictMatrixRouteServices["arbitrationService"]>;
  } = {}
): ConflictMatrixRouteServices {
  return {
    workspaceService: workspaceServiceStub(overrides.workspaceService),
    arbitrationService: implementPort<ConflictMatrixRouteServices["arbitrationService"]>(
      overrides.arbitrationService
    )
  };
}

type ConfigService = NonNullable<ConfigRouteServices["configService"]>;
type EnvironmentStatusService = NonNullable<ConfigRouteServices["environmentStatusService"]>;

export function configRouteServices(
  overrides: {
    readonly workspaceService?: LooseStub<WorkspaceService>;
    readonly configService?: LooseStub<ConfigService>;
    readonly environmentStatusService?: LooseStub<EnvironmentStatusService>;
  } = {}
): ConfigRouteServices {
  return {
    workspaceService: workspaceServiceStub(overrides.workspaceService),
    configService:
      overrides.configService === undefined
        ? undefined
        : implementPort<ConfigService>(overrides.configService),
    environmentStatusService:
      overrides.environmentStatusService === undefined
        ? undefined
        : implementPort<EnvironmentStatusService>(overrides.environmentStatusService)
  };
}

export function proposalRouteServices(
  overrides: {
    readonly workspaceService?: LooseStub<WorkspaceService>;
    readonly memoryService?: LooseStub<Pick<MemoryService, "findByIdScoped">>;
    readonly proposalService?: LooseStub<ProposalService>;
    readonly proposalRepo?: LooseStub<ProposalRouteServices["proposalRepo"]>;
    readonly eventLogRepo?: LooseStub<ProposalRouteServices["eventLogRepo"]>;
    readonly runtimeNotifier?: LooseStub<ProposalRouteServices["runtimeNotifier"]>;
    readonly mcpMemoryToolHandler?: LooseStub<McpMemoryToolHandler>;
  } = {}
): ProposalRouteServices {
  return {
    workspaceService: workspaceServiceStub(overrides.workspaceService),
    memoryService: implementPort<Pick<MemoryService, "findByIdScoped">>(overrides.memoryService ?? {}),
    proposalService: implementPort<ProposalService>(overrides.proposalService ?? {}),
    proposalRepo: implementPort<ProposalRouteServices["proposalRepo"]>(overrides.proposalRepo ?? {}),
    eventLogRepo: implementPort<ProposalRouteServices["eventLogRepo"]>(overrides.eventLogRepo ?? {}),
    runtimeNotifier: implementPort<ProposalRouteServices["runtimeNotifier"]>(overrides.runtimeNotifier ?? {}),
    mcpMemoryToolHandler: implementPort<McpMemoryToolHandler>(overrides.mcpMemoryToolHandler ?? {})
  };
}
