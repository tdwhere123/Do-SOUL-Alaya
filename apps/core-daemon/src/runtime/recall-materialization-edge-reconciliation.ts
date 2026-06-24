import {
  ConflictDetectionService,
  EdgeAutoProducerService,
  ReconciliationService,
  createRuleOnlyReconciliationDecisionPort,
  type PathCandidateSink
} from "@do-soul/alaya-core";
import type { SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import { OFFICIAL_API_GARDEN_MODEL } from "@do-soul/alaya-soul";
import { createEdgeAutoProducerLlmPort } from "../ai/edge-auto-producer-llm-adapter.js";
import { createReconciliationLlmDecisionPort } from "../ai/reconciliation-llm-decision.js";
import { createEdgeClassifyQueueAdapter } from "../garden/edge-classify-queue-adapter.js";
import {
  canResolveOfficialGardenProvider,
  createConflictDetectionLlmPort,
  resolveGardenSecretRefValue
} from "./garden-compute-support.js";
import { resolveEdgeClassifyWiring } from "./daemon-runtime-support.js";
import type { CreateRecallMaterializationWiringInput } from "./recall-materialization-wiring-types.js";

export async function createEdgeAndReconciliationRuntime(input: {
  readonly wiring: CreateRecallMaterializationWiringInput;
  readonly pathCandidatePort: PathCandidateSink;
}): Promise<Readonly<{
  readonly edgeAutoProducerService: EdgeAutoProducerService;
  readonly conflictDetectionService: ConflictDetectionService | null;
  readonly reconciliationService: ReconciliationService | null;
  readonly edgeClassifyQueueRepoHolder: {
    current:
      | {
          enqueue: SqliteGardenTaskRepo["enqueue"];
          findById(taskId: string): { readonly id: string } | null;
        }
      | undefined;
  };
}>> {
  const { wiring } = input;
  const sharedGardenComputeConfig = await wiring.rawConfigService.getRuntimeGardenComputeConfig();
  const edgeClassifyRuntime = createEdgeClassifyRuntime(wiring, sharedGardenComputeConfig);
  const edgeAutoProducerService = createEdgeAutoProducerService(
    wiring,
    input.pathCandidatePort,
    edgeClassifyRuntime.edgeClassifyQueue,
    edgeClassifyRuntime.edgeAutoProducerLlmPort
  );
  const conflictDetectionService = createConflictDetectionRuntime(wiring, input.pathCandidatePort);
  const reconciliationService = await createReconciliationRuntime(wiring);

  return Object.freeze({
    edgeAutoProducerService,
    conflictDetectionService,
    reconciliationService,
    edgeClassifyQueueRepoHolder: edgeClassifyRuntime.edgeClassifyQueueRepoHolder
  });
}

function createEdgeAutoProducerLlmPortFromConfig(
  gardenComputeConfig: Awaited<ReturnType<CreateRecallMaterializationWiringInput["rawConfigService"]["getRuntimeGardenComputeConfig"]>>
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
  input: CreateRecallMaterializationWiringInput,
  pathCandidatePort: PathCandidateSink
): ConflictDetectionService | null {
  const conflictDetectionEnabled = readEnabledEnv("ALAYA_CONFLICT_DETECTION_ENABLED", true);
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
    karmaEmitter: {
      emitKarmaEvent: (emitInput) => input.dynamicsService.emitKarmaEvent(emitInput)
    },
    ruleEnabled: readEnabledEnv("ALAYA_CONFLICT_RULE_ENABLED", true),
    warn: input.warn
  });
}

async function createReconciliationRuntime(
  input: CreateRecallMaterializationWiringInput
): Promise<ReconciliationService | null> {
  const ingestReconciliationEnabled = readEnabledEnv("ALAYA_INGEST_RECONCILIATION_ENABLED", true);
  if (!ingestReconciliationEnabled) {
    return null;
  }
  const gardenComputeConfig = await input.rawConfigService.getRuntimeGardenComputeConfig();
  const llmDecisionPort = createReconciliationLlmPortFromConfig(gardenComputeConfig);
  return new ReconciliationService({
    keywordSearch: {
      searchByKeyword: async (workspaceId, queryText, limit) =>
        await input.memoryEntryRepo.searchByKeyword(workspaceId, queryText, limit)
    },
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
}

function createReconciliationLlmPortFromConfig(
  gardenComputeConfig: Awaited<ReturnType<CreateRecallMaterializationWiringInput["rawConfigService"]["getRuntimeGardenComputeConfig"]>>
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
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  return raw !== "0" && raw !== "false";
}

function createEdgeClassifyRuntime(
  wiring: CreateRecallMaterializationWiringInput,
  sharedGardenComputeConfig: Awaited<ReturnType<CreateRecallMaterializationWiringInput["rawConfigService"]["getRuntimeGardenComputeConfig"]>>
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
  wiring: CreateRecallMaterializationWiringInput,
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
