import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import type {
  RecallDegradationReason,
  RecallEvidenceProjectionMatchReceipt,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import { parseQueryTimeWindow } from "../scoring/temporal-fusion-scoring.js";
import type { EvidenceAndGovernanceSupplement } from "./evidence/evidence-governance-supplement.js";
import type { RoutingKeySupplement } from "./routing-key-supplement.js";
import { collectQueryFieldAttribution } from "./query/query-field-attribution.js";
import { captureCertifiedRecallQueryOpenSemanticFactors } from
  "../field/open-semantic-factors/query-capture.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../field/open-semantic-factors/composition.js";
import { materializeOpenSemanticFactorActivation } from
  "../field/open-semantic-factors/activation.js";
import { uniqueStrings } from "../expansion/path-relations.js";
import { normalizeGraphSupport } from "../runtime/recall-service-helpers.js";
import type { EvidenceSupportVector } from "../runtime/recall-service-types.js";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import type { RecallQueryEntityExtractionCapture } from
  "../field/query-entity-attribution-producer.js";

export interface CollectSupplementaryDataParams {
  readonly dependencies: Pick<
    RecallServiceDependencies,
    | "budgetPenaltyPort"
    | "evidenceSearchPort"
    | "graphSupportPort"
    | "pathExpansionPort"
    | "pathPlasticityPort"
    | "routingKeyProjectionPort"
    | "entityExtractionPort"
    | "queryFactFrameExtractionPort"
    | "openSemanticFactorExtractionPort"
  >;
  readonly warn: RecallServiceWarnPort;
  readonly candidates: readonly Readonly<MemoryEntry>[];
  readonly routingKeyOwnerIds: readonly string[];
  readonly referenceTime: string;
  readonly workspaceId: string;
  readonly pathProjectionAsOf?: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly queryEntityExtraction?: Readonly<RecallQueryEntityExtractionCapture>;
  readonly querySemanticFactorFormationCapture?: Readonly<
    import("@do-soul/alaya-protocol").OpenSemanticFactorFormationCapture
  >;
  readonly querySemanticFactorCompletenessReceipt?: Readonly<
    import("@do-soul/alaya-protocol").QueryOsfSemanticCompletenessReceipt
  > | null;
  readonly policy: Readonly<RecallPolicy>;
  readonly coarseFtsRanks: Readonly<Record<string, number>>;
  readonly coarseTrigramFtsRanks: Readonly<Record<string, number>>;
  readonly coarseSynthesisFtsRanks: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanks: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>;
  readonly coarseEvidenceProjectionMatchesByRef: Readonly<Record<
    string,
    readonly Readonly<RecallEvidenceProjectionMatchReceipt>[]
  >>;
  readonly coarseSourceProximityScores: Readonly<Record<string, number>>;
  readonly coarseSourceCohortKeys: Readonly<Record<string, string>>;
  readonly coarseStructuralScores: Readonly<Record<string, number>>;
  readonly coarseGraphExpansionScores: Readonly<Record<string, number>>;
  readonly coarseEntitySeedScores: Readonly<Record<string, number>>;
  readonly coarsePathExpansionScores: Readonly<Record<string, number>>;
  readonly coarsePathSuppressionScores: Readonly<Record<string, number>>;
  readonly captureAnswerFeatures: boolean;
  readonly degradationReasons?: Set<RecallDegradationReason>;
}

export function freezeSupplementaryData(
  params: CollectSupplementaryDataParams,
  candidates: readonly Readonly<MemoryEntry>[],
  graphSupportCounts: Readonly<Record<string, number>>,
  budgetPenaltyFactor: number,
  plasticityFactors: Readonly<Record<string, number>>,
  coldMetrics: Readonly<{
    readonly graphAndPathColdScore: number;
    readonly recallsEdgeCount: number;
    readonly weightTransferAmount: number;
  }>,
  evidenceAndGovernance: Readonly<EvidenceAndGovernanceSupplement>,
  routingKeySupplement: Readonly<RoutingKeySupplement>,
  querySoughtFacets: readonly string[],
  queryFieldAttribution: Awaited<ReturnType<typeof collectQueryFieldAttribution>>,
  querySemanticFactorFormation: Awaited<
    ReturnType<typeof captureCertifiedRecallQueryOpenSemanticFactors>
  >
): RecallSupplementaryData {
  const queryTimeWindow = resolveQueryTimeWindow(params);
  const semanticSupplements = buildOpenSemanticFactorSupplements(
    querySemanticFactorFormation,
    evidenceAndGovernance
  );
  return Object.freeze({
    queryProbes: params.queryProbes,
    queryFactFrameExtraction: queryFieldAttribution.factFrameCapture,
    ...(queryFieldAttribution.attribution === undefined
      ? {}
      : { queryFieldAttribution: queryFieldAttribution.attribution }),
    queryOpenSemanticFactorFormation: querySemanticFactorFormation.formation,
    ...(querySemanticFactorFormation.receipt === null ? {} : {
      queryOpenSemanticFactorCompletenessReceipt: querySemanticFactorFormation.receipt
    }),
    semanticFactorFormationsByEvidenceId:
      evidenceAndGovernance.semanticFactorFormationsByEvidenceId,
    ...semanticSupplements,
    ...(queryTimeWindow === null ? {} : { queryTimeWindow }),
    routingKeysByOwnerIdentity: routingKeySupplement.keysByOwnerIdentity,
    queryRoutingKeys: routingKeySupplement.queryKeys,
    keyActivationByOwnerIdentity: routingKeySupplement.activationByOwnerIdentity,
    ...extractCoarseRankings(params),
    embeddingSimilarityScores: Object.freeze({}),
    evidenceSemanticActivationsByCandidateKey: new Map(),
    openSemanticFactorCandidateActivationsByCandidateKey: new Map(),
    graphSupportCounts: Object.freeze(graphSupportCounts),
    evidenceSupportVectorsByMemoryId: Object.freeze(buildEvidenceSupportVectors(candidates)),
    budgetPenaltyFactor,
    plasticityFactors,
    graphAndPathColdScore: coldMetrics.graphAndPathColdScore,
    recallsEdgeCount: coldMetrics.recallsEdgeCount,
    weightTransferAmount: coldMetrics.weightTransferAmount,
    evidenceGistsByMemoryId: evidenceAndGovernance.evidenceGistsByMemoryId,
    evidenceSemanticDocumentsByMemoryId:
      evidenceAndGovernance.evidenceSemanticDocumentsByMemoryId,
    verifiedUserAssertionContextsByMemoryId:
      evidenceAndGovernance.verifiedUserAssertionContextsByMemoryId,
    governanceCeilingByMemoryId: evidenceAndGovernance.governanceCeilingByMemoryId,
    pathInflowByTarget: evidenceAndGovernance.pathInflowByTarget,
    pathInflowAvailability: evidenceAndGovernance.pathInflowAvailability,
    querySoughtFacets
  });
}

function buildOpenSemanticFactorSupplements(
  querySemanticFactorFormation: Awaited<
    ReturnType<typeof captureCertifiedRecallQueryOpenSemanticFactors>
  >,
  evidenceAndGovernance: Readonly<EvidenceAndGovernanceSupplement>
) {
  const openSemanticFactorCompatibilityTrace =
    materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: querySemanticFactorFormation.formation,
      evidence_formations: evidenceAndGovernance.semanticFactorFormationsByEvidenceId,
      unavailable_evidence_ids:
        evidenceAndGovernance.semanticFactorFormationUnavailableEvidenceIds
    });
  const openSemanticFactorComposition = materializeOpenSemanticFactorComposition({
    trace: openSemanticFactorCompatibilityTrace,
    query_capture: querySemanticFactorFormation.formation,
    evidence_formations: evidenceAndGovernance.semanticFactorFormationsByEvidenceId
  });
  return {
    openSemanticFactorCompatibilityTrace,
    openSemanticFactorComposition,
    openSemanticFactorActivation: materializeOpenSemanticFactorActivation({
      composition: openSemanticFactorComposition,
      trace: openSemanticFactorCompatibilityTrace,
      query_capture: querySemanticFactorFormation.formation,
      evidence_formations: evidenceAndGovernance.semanticFactorFormationsByEvidenceId
    })
  };
}

function extractCoarseRankings(params: CollectSupplementaryDataParams) {
  return {
    ftsRanks: params.coarseFtsRanks,
    trigramFtsRanks: params.coarseTrigramFtsRanks,
    synthesisFtsRanks: params.coarseSynthesisFtsRanks,
    evidenceFtsRanks: params.coarseEvidenceFtsRanks,
    evidenceFtsRanksPerRef: params.coarseEvidenceFtsRanksPerRef,
    evidenceProjectionMatchesByRef: params.coarseEvidenceProjectionMatchesByRef,
    sourceProximityScores: params.coarseSourceProximityScores,
    sourceCohortKeys: params.coarseSourceCohortKeys,
    structuralScores: params.coarseStructuralScores,
    graphExpansionScores: params.coarseGraphExpansionScores,
    entitySeedScores: params.coarseEntitySeedScores,
    pathExpansionScores: params.coarsePathExpansionScores,
    pathSuppressionScores: params.coarsePathSuppressionScores
  };
}

function resolveQueryTimeWindow(
  params: Pick<CollectSupplementaryDataParams, "queryProbes" | "referenceTime">
) {
  return parseQueryTimeWindow(params.queryProbes, params.referenceTime);
}

export function buildEvidenceSupportVectors(
  candidates: readonly Readonly<MemoryEntry>[]
): Record<string, readonly EvidenceSupportVector[]> {
  const vectorsByMemoryId: Record<string, readonly EvidenceSupportVector[]> = {};
  for (const candidate of candidates) {
    const evidenceRefs = uniqueStrings(candidate.evidence_refs ?? []);
    if (evidenceRefs.length > 0) {
      vectorsByMemoryId[candidate.object_id] = Object.freeze(
        evidenceRefs.map((source_id) => Object.freeze({
          source_kind: "evidence_ref" as const,
          source_id,
          support: normalizeGraphSupport(1)
        }))
      );
    }
  }
  return vectorsByMemoryId;
}
