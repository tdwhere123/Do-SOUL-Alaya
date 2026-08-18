import type {
  EvidenceCapsule,
  MemoryEntry,
  OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
import type { RecallVerifiedUserAssertionContext } from
  "../../query/recall-user-assertion-context.js";
import type {
  RecallDegradationReason,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallEvidenceSemanticDocument
} from "../../runtime/recall-service-types.js";
import type { RecallQualifiedEvidence } from "../../runtime/recall-service-ports.js";

export const MAX_REFS_PER_MEMORY = 8;

export interface RecallEvidenceContexts {
  readonly evidenceGistsByMemoryId: Readonly<Record<string, string>>;
  readonly evidenceSemanticDocumentsByMemoryId: Readonly<
    Record<string, readonly Readonly<RecallEvidenceSemanticDocument>[]>
  >;
  readonly verifiedUserAssertionContextsByMemoryId: Readonly<
    Record<string, Readonly<RecallVerifiedUserAssertionContext>>
  >;
  readonly semanticFactorFormationsByEvidenceId: Readonly<Record<
    string,
    Readonly<OpenSemanticFactorFormationCapture>
  >>;
  readonly semanticFactorFormationUnavailableEvidenceIds?: readonly string[];
}

export interface EvidenceRecord {
  readonly evidence: Readonly<EvidenceCapsule>;
}

export interface SemanticFactorFormationLookup {
  readonly qualified: readonly Readonly<RecallQualifiedEvidence>[];
  readonly unavailableEvidenceIds: readonly string[];
}

export type CollectRecallEvidenceContextsParams = Readonly<{
  readonly dependencies: Pick<RecallServiceDependencies, "evidenceSearchPort">;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly candidates: readonly Readonly<MemoryEntry>[];
  readonly coarseEvidenceFtsRanks: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>;
  readonly degradationReasons?: Set<RecallDegradationReason>;
}>;
