import {
  ConflictDetectionService,
  EdgeAutoProducerService,
  PRODUCT_FORMATION_DEFAULTS,
  PreWriteRecallService,
  ReconciliationService,
  createRuleOnlyReconciliationDecisionPort,
  resolveProductFormationEnabled,
  type PathCandidateSink
} from "@do-soul/alaya-core";
import type { SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import { OFFICIAL_API_GARDEN_MODEL } from "@do-soul/alaya-soul";
import { createEdgeAutoProducerLlmPort } from "../../ai/edge-auto-producer-llm-adapter.js";
import { createReconciliationLlmDecisionPort } from "../../ai/reconciliation-llm-decision.js";
import { createEdgeClassifyQueueAdapter } from "../../garden/support/edge-classify-queue-adapter.js";
import {
  canResolveOfficialGardenProvider,
  createConflictDetectionLlmPort,
  resolveGardenSecretRefValue
} from "../garden-wiring/garden-compute-support.js";
import { resolveEdgeClassifyWiring } from "../daemon/lifecycle/daemon-runtime-support.js";
import { createGardenLegacyPathCandidateRejectionPort } from "../garden-wiring/garden-legacy-path-admission.js";
import type { ReconciliationBasisStatus } from
  "../daemon/lifecycle/daemon-runtime-types.js";
import type { CreateRecallMaterializationWiringInput } from "./recall-materialization-wiring-types.js";

type EdgeRuntimeWiring = Pick<
  CreateRecallMaterializationWiringInput,
  | "memoryEntryRepo"
  | "pathRelationRepo"
  | "rawConfigService"
  | "warn"
>;

type ReconciliationRuntimeWiring = Pick<
  CreateRecallMaterializationWiringInput,
  | "eventLogRepo"
  | "memoryEntryRepo"
  | "memoryService"
  | "rawConfigService"
  | "reconciliationLeaseRepo"
  | "runLookup"
  | "warn"
>;

type EdgeAndReconciliationRuntimeWiring = EdgeRuntimeWiring & ReconciliationRuntimeWiring;

export async function createEdgeAndReconciliationRuntime(
  wiring: EdgeAndReconciliationRuntimeWiring
): Promise<Readonly<{
  readonly edgeAutoProducerService: EdgeAutoProducerService;
  readonly conflictDetectionService: ConflictDetectionService | null;
  readonly reconciliationService: ReconciliationService | null;
  readonly reconciliationBasisStatus: ReconciliationBasisStatus;
  readonly edgeClassifyQueueRepoHolder: {
    current:
      | {
          enqueue: SqliteGardenTaskRepo["enqueue"];
          findById(taskId: string): { readonly id: string } | null;
        }
      | undefined;
  };
}>> {
  const sharedGardenComputeConfig = await wiring.rawConfigService.getRuntimeGardenComputeConfig();
  const edgeClassifyRuntime = createEdgeClassifyRuntime(wiring, sharedGardenComputeConfig);
  const pathCandidatePort = createGardenLegacyPathCandidateRejectionPort(wiring.warn);
  const edgeAutoProducerService = createEdgeAutoProducerService(
    wiring,
    pathCandidatePort,
    edgeClassifyRuntime.edgeClassifyQueue,
    edgeClassifyRuntime.edgeAutoProducerLlmPort
  );
  const conflictDetectionService = createConflictDetectionRuntime(wiring, pathCandidatePort);
  const reconciliationRuntime = await createReconciliationRuntime(wiring);

  return Object.freeze({
    edgeAutoProducerService,
    conflictDetectionService,
    reconciliationService: reconciliationRuntime.reconciliationService,
    reconciliationBasisStatus: reconciliationRuntime.reconciliationBasisStatus,
    edgeClassifyQueueRepoHolder: edgeClassifyRuntime.edgeClassifyQueueRepoHolder
  });
}

function createEdgeAutoProducerLlmPortFromConfig(
  gardenComputeConfig: Awaited<ReturnType<EdgeRuntimeWiring["rawConfigService"]["getRuntimeGardenComputeConfig"]>>
) {
  if (!canResolveOfficialGardenProvider(gardenComputeConfig)) {
    return null;
  }
  const secretRef = gardenComputeConfig.secret_ref;
  if (secretRef === null) {
    return null;
  }
  let apiKey: string;
  try {
    apiKey = resolveGardenSecretRefValue(secretRef);
  } catch (error) {
    // resolution failure (≠ missing-config above): credentials configured but unreadable
    process.emitWarning("[EdgeAutoProducer] garden secret-ref resolution failed; running without LLM port", {
      code: "ALAYA_GARDEN_LLM_SECRET_RESOLVE_FAILED",
      detail: JSON.stringify({
        secret_ref: secretRef,
        error: error instanceof Error ? error.message : String(error)
      })
    });
    return null;
  }
  const providerUrl = gardenComputeConfig.provider_url;
  if (providerUrl === null) {
    return null;
  }
  return createEdgeAutoProducerLlmPort({
    config: {
      providerUrl,
      model: gardenComputeConfig.model_id ?? OFFICIAL_API_GARDEN_MODEL,
      apiKey
    }
  });
}

function createConflictDetectionRuntime(
  input: Pick<EdgeRuntimeWiring, "memoryEntryRepo" | "warn">,
  pathCandidatePort: PathCandidateSink
): ConflictDetectionService | null {
  const conflictDetectionEnabled = readEnabledEnv(
    "ALAYA_CONFLICT_DETECTION_ENABLED",
    PRODUCT_FORMATION_DEFAULTS.conflictDetectionEnabled
  );
  if (!conflictDetectionEnabled) {
    return null;
  }
  const conflictDetectionLlmPort = createConflictDetectionLlmPort();
  return new ConflictDetectionService({
    memoryRepo: {
      findByDimension: async (workspaceId, dimension) =>
        await input.memoryEntryRepo.findByDimension(workspaceId, dimension),
      findByDimensionAll: async (workspaceId, dimension) =>
        await input.memoryEntryRepo.findByDimensionAll(workspaceId, dimension),
      findBySharedDomainTags: async (workspaceId, tags) =>
        await input.memoryEntryRepo.findBySharedDomainTags(workspaceId, tags)
    },
    pathCandidatePort,
    ...(conflictDetectionLlmPort === null ? {} : { llmPort: conflictDetectionLlmPort }),
    ruleEnabled: readEnabledEnv("ALAYA_CONFLICT_RULE_ENABLED", true),
    warn: input.warn
  });
}

async function createReconciliationRuntime(
  input: ReconciliationRuntimeWiring
): Promise<{
  readonly reconciliationService: ReconciliationService | null;
  readonly reconciliationBasisStatus: ReconciliationBasisStatus;
}> {
  const ingestReconciliationEnabled = readEnabledEnv(
    "ALAYA_INGEST_RECONCILIATION_ENABLED",
    PRODUCT_FORMATION_DEFAULTS.ingestReconciliationEnabled
  );
  if (!ingestReconciliationEnabled) {
    return { reconciliationService: null, reconciliationBasisStatus: { enabled: false } };
  }
  const gardenComputeConfig = await input.rawConfigService.getRuntimeGardenComputeConfig();
  const llmDecisionPort = createReconciliationLlmPortFromConfig(gardenComputeConfig);
  const basisStatus: ReconciliationBasisStatus = llmDecisionPort !== null
    ? { enabled: true, basis: "garden_llm" }
    : { enabled: true, basis: "rule_only" };
  const preWriteRecall = new PreWriteRecallService({
    lexicalSearch: {
      searchByKeyword: async (workspaceId, queryText, limit) =>
        await input.memoryEntryRepo.searchByKeyword(workspaceId, queryText, limit)
    },
    memoryRepo: {
      findByIds: async (workspaceId, objectIds) =>
        await input.memoryEntryRepo.findByIds(workspaceId, objectIds),
      findByWorkspaceId: async (workspaceId, tier, page) =>
        await input.memoryEntryRepo.findByWorkspaceId(workspaceId, tier, page)
    },
    limit: 8,
    warn: input.warn
  });
  const reconciliationService = new ReconciliationService({
    preWriteRecall,
    memoryRepo: {
      findByIds: async (workspaceId, objectIds) =>
        await input.memoryEntryRepo.findByIds(workspaceId, objectIds)
    },
    memoryUpdate: {
      update: async (objectId, fields, reason) =>
        await input.memoryService.update(objectId, fields, reason)
    },
    eventLog: {
      append: (event) => input.eventLogRepo.append(event)
    },
    runLookup: input.runLookup,
    llmDecision: llmDecisionPort ?? createRuleOnlyReconciliationDecisionPort(),
    lease: input.reconciliationLeaseRepo,
    warn: input.warn
  });
  return { reconciliationService, reconciliationBasisStatus: basisStatus };
}

function createReconciliationLlmPortFromConfig(
  gardenComputeConfig: Awaited<ReturnType<ReconciliationRuntimeWiring["rawConfigService"]["getRuntimeGardenComputeConfig"]>>
) {
  if (!canResolveOfficialGardenProvider(gardenComputeConfig)) {
    return null;
  }
  const secretRef = gardenComputeConfig.secret_ref;
  if (secretRef === null) {
    return null;
  }
  let apiKey: string;
  try {
    apiKey = resolveGardenSecretRefValue(secretRef);
  } catch (error) {
    // resolution failure (≠ missing-config above): credentials configured but unreadable
    process.emitWarning("[Reconciliation] garden secret-ref resolution failed; running rule-only", {
      code: "ALAYA_GARDEN_LLM_SECRET_RESOLVE_FAILED",
      detail: JSON.stringify({
        secret_ref: secretRef,
        error: error instanceof Error ? error.message : String(error)
      })
    });
    return null;
  }
  const providerUrl = gardenComputeConfig.provider_url;
  if (providerUrl === null) {
    return null;
  }
  return createReconciliationLlmDecisionPort({
    config: {
      providerUrl,
      model: gardenComputeConfig.model_id ?? OFFICIAL_API_GARDEN_MODEL,
      apiKey
    }
  });
}

export const edgeReconciliationTestInternals = {
  createEdgeAutoProducerLlmPortFromConfig,
  createReconciliationLlmPortFromConfig
};

function readEnabledEnv(name: string, defaultValue: boolean): boolean {
  return resolveProductFormationEnabled(process.env[name], defaultValue);
}

function createEdgeClassifyRuntime(
  wiring: Pick<EdgeRuntimeWiring, "warn">,
  sharedGardenComputeConfig: Awaited<ReturnType<EdgeRuntimeWiring["rawConfigService"]["getRuntimeGardenComputeConfig"]>>
) {
  const edgeClassifyWiring = resolveEdgeClassifyWiring(process.env, sharedGardenComputeConfig);
  const edgeClassifyQueueRepoHolder: {
    current:
      | {
          enqueue: SqliteGardenTaskRepo["enqueue"];
          findById(taskId: string): { readonly id: string } | null;
        }
      | undefined;
  } = { current: undefined };
  return {
    edgeClassifyQueueRepoHolder,
    edgeAutoProducerLlmPort: edgeClassifyWiring.llmEnabled
      ? createEdgeAutoProducerLlmPortFromConfig(sharedGardenComputeConfig)
      : null,
    edgeClassifyQueue: edgeClassifyWiring.hostWorkerEnabled
      ? createEdgeClassifyQueueAdapter({
          gardenTaskRepo: {
            enqueue: (enqueueInput) => {
              if (edgeClassifyQueueRepoHolder.current === undefined) {
                throw new Error("EDGE_CLASSIFY queue used before the garden task repo was wired.");
              }
              return edgeClassifyQueueRepoHolder.current.enqueue(enqueueInput);
            },
            findById: (taskId) => edgeClassifyQueueRepoHolder.current?.findById(taskId) ?? null
          },
          now: () => new Date().toISOString(),
          warn: wiring.warn
        })
      : null
  };
}

function createEdgeAutoProducerService(
  wiring: Pick<EdgeRuntimeWiring, "memoryEntryRepo" | "pathRelationRepo" | "warn">,
  pathCandidatePort: PathCandidateSink,
  edgeClassifyQueue: ReturnType<typeof createEdgeClassifyRuntime>["edgeClassifyQueue"],
  edgeAutoProducerLlmPort: ReturnType<typeof createEdgeClassifyRuntime>["edgeAutoProducerLlmPort"]
) {
  return new EdgeAutoProducerService({
    memoryRepo: wiring.memoryEntryRepo,
    pathCandidatePort,
    existingPathReader: {
      findByBackingObjectId: (workspaceId, objectId) =>
        wiring.pathRelationRepo.findByBackingObjectId(workspaceId, objectId)
    },
    ...(edgeClassifyQueue !== null
      ? { edgeClassifyQueue }
      : edgeAutoProducerLlmPort === null
        ? {}
        : { llmPort: edgeAutoProducerLlmPort }),
    warn: wiring.warn
  });
}
