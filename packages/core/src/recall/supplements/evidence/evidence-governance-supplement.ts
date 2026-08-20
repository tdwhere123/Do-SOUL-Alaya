import type {
  ManifestationState,
  MemoryEntry,
  OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
import type { RecallVerifiedUserAssertionContext } from
  "../../query/recall-user-assertion-context.js";
import type {
  PathInflowEdge,
  RecallDegradationReason,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallSupplementaryData
} from "../../runtime/recall-service-types.js";
import { collectGovernancePathDerivations } from
  "../supplementary-data-governance-paths.js";
import { collectRecallEvidenceContexts } from "./evidence-contexts.js";

export interface EvidenceAndGovernanceSupplement {
  readonly evidenceGistsByMemoryId: Readonly<Record<string, string>>;
  readonly evidenceSemanticDocumentsByMemoryId: NonNullable<
    RecallSupplementaryData["evidenceSemanticDocumentsByMemoryId"]
  >;
  readonly verifiedUserAssertionContextsByMemoryId: Readonly<Record<
    string,
    Readonly<RecallVerifiedUserAssertionContext>
  >>;
  readonly semanticFactorFormationsByEvidenceId: Readonly<Record<
    string,
    Readonly<OpenSemanticFactorFormationCapture>
  >>;
  readonly semanticFactorFormationUnavailableEvidenceIds?: readonly string[];
  readonly governanceCeilingByMemoryId: Readonly<Record<string, ManifestationState>>;
  readonly pathInflowByTarget: Readonly<Record<string, readonly PathInflowEdge[]>>;
  readonly pathInflowAvailability: NonNullable<
    RecallSupplementaryData["pathInflowAvailability"]
  >;
}

export async function collectEvidenceAndGovernanceSupplement(params: Readonly<{
  readonly dependencies: Pick<
    RecallServiceDependencies,
    "evidenceSearchPort" | "pathExpansionPort"
  >;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly pathProjectionAsOf?: string;
  readonly candidates: readonly Readonly<MemoryEntry>[];
  readonly coarseEvidenceFtsRanks: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>;
  readonly degradationReasons?: Set<RecallDegradationReason>;
}>): Promise<Readonly<EvidenceAndGovernanceSupplement>> {
  const [evidenceContexts, governanceDerivations] = await Promise.all([
    collectRecallEvidenceContexts({
      dependencies: params.dependencies,
      warn: params.warn,
      workspaceId: params.workspaceId,
      candidates: params.candidates,
      coarseEvidenceFtsRanks: params.coarseEvidenceFtsRanks,
      coarseEvidenceFtsRanksPerRef: params.coarseEvidenceFtsRanksPerRef,
      degradationReasons: params.degradationReasons
    }),
    collectGovernancePathDerivations({
      dependencies: params.dependencies,
      warn: params.warn,
      workspaceId: params.workspaceId,
      pathProjectionAsOf: params.pathProjectionAsOf,
      candidates: params.candidates
    })
  ]);
  return Object.freeze({ ...evidenceContexts, ...governanceDerivations });
}
