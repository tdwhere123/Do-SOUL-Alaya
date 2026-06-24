import {
  ArbitrationService,
  BudgetBankruptcyService,
  CanonicalAliasService,
  ClaimService,
  HealthJournalService,
  ProjectMappingService,
  ProposalService,
  SessionOverrideService,
  SlotService,
  StrongRefService,
  SurfaceBindingService,
  SurfaceDriftService,
  SurfaceService,
  TaskSurfaceBuilder,
  ToolSpecService,
  ZeroDaySecurityLayer
} from "@do-soul/alaya-core";
import {
  SqliteDriftLeaseRepo
} from "@do-soul/alaya-storage";
import {
  BootstrappingService
} from "@do-soul/alaya-soul";
import { createBudgetProposalPort } from "../budget/wiring.js";
import { parseZeroDayPoliciesJson } from "../security/zero-day-policies.js";
import { createSecurityStatusBootstrapServices } from "../security/status-bootstrap.js";
import { createConfigService } from "../services/config-service.js";
import { createEnvironmentStatusService } from "../services/environment-status-service.js";
import {
  CORE_DAEMON_ENVIRONMENT_TOOLS,
  derivePrincipalCodingAvailability
} from "../services/principal-coding-availability.js";
import { createTrustStateRecorder } from "../trust/state.js";
import {
  createManifestationBudgetConfigProvider,
} from "./daemon-runtime-helpers.js";
import { createKnowledgeFoundation } from "./daemon-knowledge-foundation.js";
import {
  defaultBootstrappingTemplates,
  defaultCanonicalAliasMap
} from "./daemon-defaults.js";

export type DaemonServiceFoundationInput = {
  readonly [key: string]: any;
};

export async function createDaemonServiceFoundation(input: DaemonServiceFoundationInput) {
  const environmentFoundation = await createEnvironmentSecurityFoundation(input);
  const configFoundation = createConfigFoundation(input, environmentFoundation.eventPublisher);
  const knowledgeFoundation = createKnowledgeFoundation(
    input,
    environmentFoundation.eventPublisher
  );
  const governanceFoundation = createGovernanceAndSurfaceFoundation(
    input,
    environmentFoundation.eventPublisher,
    knowledgeFoundation.healthJournalService
  );

  return {
    ...environmentFoundation,
    ...configFoundation,
    ...knowledgeFoundation,
    ...governanceFoundation
  };
}

async function createEnvironmentSecurityFoundation(input: DaemonServiceFoundationInput) {
  const environmentStatusService = createEnvironmentStatusService({
    toolNames: CORE_DAEMON_ENVIRONMENT_TOOLS,
    getDatabasePath: () => input.database.filename,
    getFilesDirectory: () => input.filesDirectory
  });
  const environmentStatus = await environmentStatusService.getStatus();
  const principalCodingAvailability = derivePrincipalCodingAvailability({
    runtimeConfigured: process.env.ALAYA_PRINCIPAL_RUNTIME === "claude_code",
    tools: environmentStatus.tools
  });
  const zeroDaySecurityLayer = new ZeroDaySecurityLayer({
    loadPolicies: async () => parseZeroDayPoliciesJson(process.env.ZERO_DAY_POLICIES_JSON)
  });
  const {
    eventPublisher,
    runHotStateService,
    securityStatusService,
    workspaceService: securedWorkspaceService
  } = createSecurityStatusBootstrapServices({
    workspaceRepo: input.workspaceRepo,
    runRepo: input.runRepo,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier,
    zeroDayLayer: zeroDaySecurityLayer,
    engineConfigRepo: input.workspaceEngineConfigRepo,
    bootstrappingPlanner: new BootstrappingService({
      templates: defaultBootstrappingTemplates,
      now: () => new Date().toISOString()
    }),
    pathRelationRepo: input.pathRelationRepo,
    bootstrappingRecordRepo: input.bootstrappingRecordRepo
  });
  return {
    environmentStatusService,
    principalCodingAvailability,
    eventPublisher,
    runHotStateService,
    securityStatusService,
    securedWorkspaceService
  };
}

function createConfigFoundation(
  input: DaemonServiceFoundationInput,
  eventPublisher: ReturnType<typeof createSecurityStatusBootstrapServices>["eventPublisher"]
) {
  const rawConfigService = createConfigService({
    configRepo: input.configRepo,
    eventPublisher,
    configPathsProvider: () => input.configPaths
  });
  const manifestationBudgetConfigProvider = createManifestationBudgetConfigProvider(input.configRepo);
  const trustStateRecorder = createTrustStateRecorder({
    eventPublisher,
    repo: input.trustStateRepo,
    clock: () => new Date().toISOString()
  });
  const toolSpecService = new ToolSpecService({ toolSpecRepo: input.toolSpecRepo });
  const strongRefService = new StrongRefService({ repo: input.strongRefRepo });
  return {
    rawConfigService,
    manifestationBudgetConfigProvider,
    trustStateRecorder,
    toolSpecService,
    strongRefService
  };
}

function createGovernanceAndSurfaceFoundation(
  input: DaemonServiceFoundationInput,
  eventPublisher: ReturnType<typeof createSecurityStatusBootstrapServices>["eventPublisher"],
  healthJournalService: HealthJournalService
) {
  const canonicalAliasService = new CanonicalAliasService({
    aliasMap: defaultCanonicalAliasMap,
    eventPublisher
  });
  const slotClaimRuntime = createSlotClaimRuntime(input, eventPublisher, canonicalAliasService);
  const governanceServices = createGovernanceServices(input);
  const surfaceService = createSurfaceService(input, eventPublisher, healthJournalService);
  const taskSurfaceBuilder = new TaskSurfaceBuilder({
    surfaceRepo: input.surfaceIdentityRepo,
    eventLogRepo: input.eventLogRepo
  });

  return {
    arbitrationService: slotClaimRuntime.arbitrationService,
    slotService: slotClaimRuntime.slotService,
    claimService: slotClaimRuntime.claimService,
    sessionOverrideService: governanceServices.sessionOverrideService,
    proposalService: governanceServices.proposalService,
    surfaceService,
    taskSurfaceBuilder,
    budgetNow: governanceServices.budgetNow,
    budgetBankruptcyService: governanceServices.budgetBankruptcyService,
    projectMappingService: governanceServices.projectMappingService
  };
}

function createSlotClaimRuntime(
  input: DaemonServiceFoundationInput,
  eventPublisher: ReturnType<typeof createSecurityStatusBootstrapServices>["eventPublisher"],
  canonicalAliasService: CanonicalAliasService
) {
  const claimServiceRef: { current: ClaimService | null } = { current: null };
  const arbitrationService = new ArbitrationService({
    slotRepo: input.slotRepo,
    claimRepo: input.claimFormRepo,
    conflictMatrixRepo: input.conflictMatrixRepo,
    claimService: {
      transitionLifecycle: async (...args) => {
        const claimService = claimServiceRef.current;
        if (claimService === null) {
          throw new Error("ArbitrationService claimService used before ClaimService initialization.");
        }
        return await claimService.transitionLifecycle(...args);
      }
    },
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier
  });
  const slotService = new SlotService({
    slotRepo: input.slotRepo,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier,
    arbitrationService: {
      arbitrateSlot: async (slotId, options) => await arbitrationService.arbitrateSlot(slotId, options)
    }
  });
  const claimService = new ClaimService({
    claimFormRepo: input.claimFormRepo,
    eventLogRepo: input.eventLogRepo,
    slotService,
    runtimeNotifier: input.runtimeNotifier,
    eventPublisher,
    canonicalAliasService
  });
  claimServiceRef.current = claimService;

  return { arbitrationService, slotService, claimService };
}

function createSurfaceService(
  input: DaemonServiceFoundationInput,
  eventPublisher: ReturnType<typeof createSecurityStatusBootstrapServices>["eventPublisher"],
  healthJournalService: HealthJournalService
) {
  const surfaceDriftService = new SurfaceDriftService({
    leaseRepo: new SqliteDriftLeaseRepo(input.database),
    eventPublisher,
    healthJournal: {
      record: async (entry) => {
        await healthJournalService.record(entry);
      }
    }
  });
  const surfaceBindingService = new SurfaceBindingService({
    surfaceBindingRepo: input.surfaceBindingRepo,
    crossCuttingPermissionLookup: input.crossCuttingPermissionRepo,
    eventPublisher,
    surfaceDriftService
  });
  return new SurfaceService({
    surfaceIdentityRepo: input.surfaceIdentityRepo,
    surfaceAnchorRepo: input.surfaceAnchorRepo,
    runtimeNotifier: input.runtimeNotifier,
    surfaceDriftService,
    surfaceBindingCascader: surfaceBindingService
  });
}

function createGovernanceServices(input: DaemonServiceFoundationInput) {
  const sessionOverrideService = new SessionOverrideService({
    eventLogRepo: input.eventLogRepo,
    runLookup: input.runRepo
  });
  const proposalService = new ProposalService({
    proposalRepo: input.proposalRepo,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier
  });
  const budgetNow = () => new Date().toISOString();
  return {
    sessionOverrideService,
    proposalService,
    budgetNow,
    budgetBankruptcyService: new BudgetBankruptcyService({
      eventLogRepo: input.eventLogRepo,
      proposalService: createBudgetProposalPort({
        proposalRepo: input.proposalRepo,
        now: budgetNow
      }),
      runtimeNotifier: input.runtimeNotifier,
      now: budgetNow
    }),
    projectMappingService: new ProjectMappingService({
      projectMappingRepo: input.projectMappingAnchorRepo,
      memoryRepo: input.memoryEntryRepo,
      eventLogRepo: input.eventLogRepo,
      runtimeNotifier: input.runtimeNotifier
    })
  };
}
