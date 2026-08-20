import type {
  ExtractionAuthorityInspection,
  ExtractionAuthorityObservation
} from "../receipt.js";

export function canonicalAuthorityObservation(
  observation: ExtractionAuthorityObservation
): ExtractionAuthorityObservation {
  return {
    revision: observation.revision,
    commandDigest: observation.commandDigest,
    selectionDigest: observation.selectionDigest,
    keyDigest: observation.keyDigest,
    dataset: { ...observation.dataset },
    extraction: { ...observation.extraction },
    ...(observation.transport === undefined ? {} : {
      transport: { ...observation.transport }
    }),
    inventory: { ...observation.inventory }
  };
}

export function canonicalAuthorityLineage(
  observation: ExtractionAuthorityObservation
): object {
  return {
    revision: observation.revision,
    commandDigest: observation.commandDigest,
    selectionDigest: observation.selectionDigest,
    keyDigest: observation.keyDigest,
    dataset: { ...observation.dataset },
    extraction: {
      model: observation.extraction.model,
      modelFamily: observation.extraction.modelFamily,
      requestProfile: observation.extraction.requestProfile,
      providerUrl: observation.extraction.providerUrl,
      systemPromptSha256: observation.extraction.systemPromptSha256,
      cacheKeyAlgorithm: observation.extraction.cacheKeyAlgorithm
    },
    ...(observation.transport === undefined ? {} : {
      transport: { ...observation.transport }
    }),
    expectedTurns: observation.inventory.expectedTurns
  };
}

export function freezeAuthorityObservation(
  observation: ExtractionAuthorityObservation
): ExtractionAuthorityObservation {
  return Object.freeze({
    ...canonicalAuthorityObservation(observation),
    dataset: Object.freeze({ ...observation.dataset }),
    extraction: Object.freeze({ ...observation.extraction }),
    ...(observation.transport === undefined ? {} : {
      transport: Object.freeze({ ...observation.transport })
    }),
    inventory: Object.freeze({ ...observation.inventory })
  });
}

export function freezeAuthorityInspection(
  inspection: ExtractionAuthorityInspection
): ExtractionAuthorityInspection {
  return Object.freeze({
    writerLock: inspection.writerLock,
    disk: inspection.disk.status === "available"
      ? Object.freeze({ status: "available" as const, freeBytes: inspection.disk.freeBytes })
      : Object.freeze({ status: "unavailable" as const }),
    credentialStatus: inspection.credentialStatus,
    modelReadiness: inspection.modelReadiness
  });
}
