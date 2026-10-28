import type {
  BrokenPointerRecord,
  ColdStartAssessment,
  DraftCandidate,
  ExpiringGreenStatus,
  HighFrequencyPattern,
  StaleMemoryEntry
} from "@do-soul/alaya-protocol";
import type { GardenProposalWriter } from "./garden-data-port-shared.js";

export interface GardenDataPortFactoryOptions {
  readonly now?: () => string;
  readonly proposalWriter?: GardenProposalWriter;
}

export interface GardenHotDemotionCandidate {
  readonly memory_entry_id: string;
  readonly last_access_at: string | null;
  readonly activation_score: number;
}

export interface GardenJanitorHotDemotionCriteria {
  readonly maxLastHitAgeMs: number;
  readonly minActivationScore: number;
}

export interface GardenJanitorMemoryTieringPort {
  findHotDemotionCandidates(
    workspaceId: string,
    criteria: GardenJanitorHotDemotionCriteria
  ): Promise<readonly GardenHotDemotionCandidate[]>;
  // Mechanical hot->cold apply. Returns the object_ids this call actually
  // moved off hot; omitted ids were not hot+active at UPDATE time.
  demoteToWarm(workspaceId: string, memoryEntryIds: readonly string[]): readonly string[];
}

export interface GardenLowActivityMemoryRecord {
  readonly memory_id: string;
}

export type GardenDormantDemotionOutcome = "demoted" | "skipped";

export interface GardenJanitorDormantDemotionPort {
  findLowActivityActiveMemories(workspaceId: string): Promise<readonly GardenLowActivityMemoryRecord[]>;
  setLifecycleDormant(memoryId: string, taskId: string): Promise<GardenDormantDemotionOutcome>;
}

export interface GardenNeighborGroup {
  readonly subject: string;
  readonly object_ids: readonly string[];
  readonly overlap_basis: string;
}

export interface GardenSynthesisCandidateCluster {
  readonly subject: string;
  readonly evidence_ids: readonly string[];
}

export interface GardenLibrarianNeighborDetectionPort {
  findSubjectNeighbors(workspaceId: string): Promise<readonly GardenNeighborGroup[]>;
}

export interface GardenLibrarianSynthesisThrottlePort {
  findSynthesisCandidateClusters(workspaceId: string): Promise<readonly GardenSynthesisCandidateCluster[]>;
  hasPendingSynthesisForSubject(workspaceId: string, subject: string): Promise<boolean>;
  createSynthesisReviewCandidate(
    workspaceId: string,
    subject: string,
    evidenceIds: readonly string[]
  ): Promise<{ readonly candidate_id: string; readonly created: boolean }>;
}

export interface GardenAuditorEvidenceCheckPort {
  findMemoriesWithStaleEvidence(workspaceId: string): Promise<readonly StaleMemoryEntry[]>;
}

export interface GardenAuditorPointerHealthPort {
  findBrokenPointers(workspaceId: string): Promise<readonly BrokenPointerRecord[]>;
}

export interface GardenAuditorGreenMaintenancePort {
  findExpiringGreenStatuses(workspaceId: string, lookaheadMs: number): Promise<readonly ExpiringGreenStatus[]>;
  renewGreenPassiveStable(greenStatusId: string, taskId: string): void;
  requestActiveVerification(greenStatusId: string, taskId: string): void;
  revokeGreen(
    memoryEntryId: string,
    reason: "verification_fail",
    taskId: string,
    workspaceId: string
  ): { readonly affected: number };
  revokeGreenOnEvidenceRewrite(input: {
    readonly memoryEntryId: string;
    readonly workspaceId: string;
    readonly newEvidenceRefs: readonly string[];
  }): { readonly affected: number };
}

export interface GardenAuditorBootstrappingPort {
  assessColdStart(workspaceId: string): Promise<ColdStartAssessment>;
  generateDraftCandidates(workspaceId: string): Promise<readonly DraftCandidate[]>;
  findHighFrequencyPatterns(workspaceId: string, minFrequency: number): Promise<readonly HighFrequencyPattern[]>;
  createSynthesisCandidate(workspaceId: string, patternKey: string): Promise<{ readonly candidate_id: string; readonly created: boolean }>;
  hasPendingSynthesisCandidate(workspaceId: string, patternKey: string): Promise<boolean>;
}

export interface GardenBackgroundDataPorts {
  readonly tieringPort: GardenJanitorMemoryTieringPort;
  readonly dormantDemotionPort: GardenJanitorDormantDemotionPort;
  readonly evidenceCheckPort: GardenAuditorEvidenceCheckPort;
  readonly pointerHealthPort: GardenAuditorPointerHealthPort;
  readonly greenMaintenancePort: GardenAuditorGreenMaintenancePort;
  readonly bootstrappingPort: GardenAuditorBootstrappingPort;
  readonly neighborPort: GardenLibrarianNeighborDetectionPort;
  readonly synthesisPort: GardenLibrarianSynthesisThrottlePort;
}
