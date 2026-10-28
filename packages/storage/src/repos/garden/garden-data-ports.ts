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
  createNeighborPort,
  createSynthesisPort
} from "./garden-librarian-data-ports.js";

export type {
  GardenAuditorBootstrappingPort,
  GardenAuditorEvidenceCheckPort,
  GardenAuditorGreenMaintenancePort,
  GardenAuditorPointerHealthPort,
  GardenBackgroundDataPorts,
  GardenDataPortFactoryOptions,
  GardenDormantDemotionOutcome,
  GardenHotDemotionCandidate,
  GardenJanitorDormantDemotionPort,
  GardenJanitorHotDemotionCriteria,
  GardenJanitorMemoryTieringPort,
  GardenLibrarianNeighborDetectionPort,
  GardenLibrarianSynthesisThrottlePort,
  GardenLowActivityMemoryRecord,
  GardenNeighborGroup,
  GardenSynthesisCandidateCluster
} from "./garden-background-port-types.js";

export function createGardenBackgroundDataPorts(
  database: StorageDatabase,
  options: GardenDataPortFactoryOptions = {}
): GardenBackgroundDataPorts {
  const context: GardenDataPortFactoryContext = {
    database,
    now: options.now ?? (() => new Date().toISOString()),
    ...(options.proposalWriter === undefined ? {} : { proposalWriter: options.proposalWriter })
  };

  return {
    tieringPort: createTieringPort(context),
    dormantDemotionPort: createDormantDemotionPort(context),
    evidenceCheckPort: createEvidenceCheckPort(context),
    pointerHealthPort: createPointerHealthPort(context),
    greenMaintenancePort: createGreenMaintenancePort(context),
    bootstrappingPort: createBootstrappingPort(context),
    neighborPort: createNeighborPort(context),
    synthesisPort: createSynthesisPort(context)
  };
}
