import { randomUUID } from "node:crypto";
import type { StorageDatabase } from "../../sqlite/db.js";
import {
  createBootstrappingPort,
  createEvidenceCheckPort,
  createGreenMaintenancePort,
  createPointerHealthPort
} from "./garden-auditor-data-ports.js";
import type {
  GardenBackgroundDataPorts,
  GardenDataPortFactoryOptions
} from "./garden-background-port-types.js";
import { type GardenDataPortFactoryContext } from "./garden-data-port-shared.js";
import { createDormantDemotionPort, createTieringPort } from "./garden-janitor-data-ports.js";
import {
  createCompressionPort,
  createMergePort,
  createNeighborPort,
  createSynthesisPort
} from "./garden-librarian-data-ports.js";

export type {
  GardenAuditorBootstrappingPort,
  GardenAuditorEvidenceCheckPort,
  GardenAuditorGreenMaintenancePort,
  GardenAuditorPointerHealthPort,
  GardenBackgroundDataPorts,
  GardenCompressionCandidate,
  GardenDataPortFactoryOptions,
  GardenDormantDemotionOutcome,
  GardenHotDemotionCandidate,
  GardenJanitorDormantDemotionPort,
  GardenJanitorHotDemotionCriteria,
  GardenJanitorMemoryTieringPort,
  GardenLibrarianMergeDetectionPort,
  GardenLibrarianNeighborDetectionPort,
  GardenLibrarianPathCompressionPort,
  GardenLibrarianSynthesisThrottlePort,
  GardenLowActivityMemoryRecord,
  GardenMergeCandidate,
  GardenNeighborGroup,
  GardenSynthesisCandidateCluster,
  GardenTemplateCluster
} from "./garden-background-port-types.js";

export function createGardenBackgroundDataPorts(
  database: StorageDatabase,
  options: GardenDataPortFactoryOptions = {}
): GardenBackgroundDataPorts {
  const context: GardenDataPortFactoryContext = {
    database,
    now: options.now ?? (() => new Date().toISOString()),
    generateId: options.generateId ?? (() => randomUUID())
  };

  return {
    tieringPort: createTieringPort(context),
    dormantDemotionPort: createDormantDemotionPort(context),
    evidenceCheckPort: createEvidenceCheckPort(context),
    pointerHealthPort: createPointerHealthPort(context),
    greenMaintenancePort: createGreenMaintenancePort(context),
    bootstrappingPort: createBootstrappingPort(context),
    mergePort: createMergePort(context),
    neighborPort: createNeighborPort(context),
    compressionPort: createCompressionPort(context),
    synthesisPort: createSynthesisPort(context)
  };
}
