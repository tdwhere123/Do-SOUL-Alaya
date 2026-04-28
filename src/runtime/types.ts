import type {
  AuditedMutationInput,
  AuditedMutationResult
} from "./audit-types.js";
import type { DoctorReport } from "../doctor/report.js";
import type {
  ClaimForm,
  EvidenceCapsule,
  MemoryEntry,
  OntologyRecord,
  SynthesisCapsule
} from "../ontology/index.js";
import type {
  ActivationCandidate,
  ManifestationBudgetConfig,
  ManifestationDecision,
  PathAnchorRef,
  PathRelation,
  TaskSurfaceRef,
  TopologyProjection
} from "../structure/index.js";
import type {
  GovernanceActionRequest,
  GovernanceBypassSignal,
  GovernancePolicyDecision,
  GovernanceReceipt,
  PromotionCandidate,
  PromotionDecision,
  PromotionGate
} from "../governance/index.js";
import type {
  AssembleContextPackInput,
  ContextPack,
  ContextPackBudget,
  EmbeddingSupplementCandidate,
  EmbeddingSupplementConfig,
  RecallGovernanceState,
  RecallMemoryRecord,
  RecallQuery
} from "../recall/index.js";
import type {
  ProposalRecord,
  ProposalValidationResult,
  ProviderRegistryEntry,
  ProviderSelectionRequest,
  ProviderSelectionResult
} from "../provider/index.js";
import type {
  MemorySessionEvent,
  TrustSummary
} from "../session/index.js";

export interface AlayaRuntimeOptions {
  readonly dataDir: string;
}

export interface AuditedRuntimeDecisionReceipt {
  readonly mutationId: string;
  readonly recorded: true;
  readonly scope: "r1-runtime-audit";
}

export interface AuditedRuntimeDecisionInput extends Omit<AuditedMutationInput, "kind"> {
  readonly kind: `runtime.${string}`;
}

export interface AuditedOntologyWriteInput<T extends OntologyRecord> extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly record: T;
}

export interface AuditedPathRelationWriteInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly relation: PathRelation;
  readonly governanceReceipt?: GovernanceReceipt | null;
}

export interface AuditedManifestationResolveInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly workspaceId: string;
  readonly runId: string;
  readonly candidates: readonly ActivationCandidate[];
  readonly taskSurfaceRef: TaskSurfaceRef | null;
  readonly budgetConfig: ManifestationBudgetConfig;
}

export interface AuditedPromotionDecisionInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly candidate: PromotionCandidate;
  readonly gate: PromotionGate;
}

export interface AuditedGovernanceActionInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly workspaceId: string;
  readonly request: GovernanceActionRequest;
}

export interface MemoryVisibilityDecision {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly state: RecallGovernanceState;
  readonly reason: string;
  readonly decided_at: string;
  readonly source_refs: readonly string[];
  readonly evidence_refs: readonly string[];
}

export interface AuditedMemoryVisibilityInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly decision: MemoryVisibilityDecision;
}

export interface AuditedGovernanceBypassInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly workspaceId: string;
  readonly attemptedMutation: string;
  readonly actorRef: string;
  readonly recoverable?: boolean;
}

export interface AuditedRecallContextInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly query: RecallQuery;
  readonly packId?: string | null;
  readonly budget: ContextPackBudget;
  readonly embedding?: EmbeddingSupplementConfig | null;
  readonly embeddingSupplement?: readonly EmbeddingSupplementCandidate[];
  readonly memoryRecords?: readonly RecallMemoryRecord[];
  readonly activationCandidates?: readonly ActivationCandidate[];
}

export interface AuditedContextPackInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly input: AssembleContextPackInput;
}

export interface AuditedProviderSelectionInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly workspaceId: string;
  readonly providers: readonly ProviderRegistryEntry[];
  readonly request: ProviderSelectionRequest;
}

export interface AuditedProposalRecordInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly workspaceId: string;
  readonly proposal: ProposalRecord;
}

export interface AuditedMemorySessionEventInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly event: MemorySessionEvent;
}

export interface AuditedTrustSummaryInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly summaryId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly generatedAt: string;
}

export interface AlayaRuntimePort {
  recordAuditedRuntimeDecision(
    input: AuditedRuntimeDecisionInput
  ): Promise<AuditedMutationResult<AuditedRuntimeDecisionReceipt>>;
  createEvidenceCapsule(
    input: AuditedOntologyWriteInput<EvidenceCapsule>
  ): Promise<AuditedMutationResult<EvidenceCapsule>>;
  createMemoryEntry(
    input: AuditedOntologyWriteInput<MemoryEntry>
  ): Promise<AuditedMutationResult<MemoryEntry>>;
  createSynthesisCapsule(
    input: AuditedOntologyWriteInput<SynthesisCapsule>
  ): Promise<AuditedMutationResult<SynthesisCapsule>>;
  createClaimForm(
    input: AuditedOntologyWriteInput<ClaimForm>
  ): Promise<AuditedMutationResult<ClaimForm>>;
  createPathRelation(
    input: AuditedPathRelationWriteInput
  ): Promise<AuditedMutationResult<PathRelation>>;
  getPathRelation(pathId: string): Promise<PathRelation | null>;
  listPathRelations(workspaceId: string): Promise<readonly PathRelation[]>;
  listActivePathRelations(workspaceId: string): Promise<readonly PathRelation[]>;
  listPathRelationsByAnchor(workspaceId: string, anchor: PathAnchorRef): Promise<readonly PathRelation[]>;
  projectTopology(workspaceId: string): Promise<TopologyProjection>;
  resolveManifestations(
    input: AuditedManifestationResolveInput
  ): Promise<AuditedMutationResult<readonly ManifestationDecision[]>>;
  decidePromotion(
    input: AuditedPromotionDecisionInput
  ): Promise<AuditedMutationResult<PromotionDecision>>;
  evaluateGovernanceAction(
    input: AuditedGovernanceActionInput
  ): Promise<AuditedMutationResult<GovernancePolicyDecision>>;
  recordMemoryVisibility(
    input: AuditedMemoryVisibilityInput
  ): Promise<AuditedMutationResult<MemoryVisibilityDecision>>;
  recordGovernanceBypass(
    input: AuditedGovernanceBypassInput
  ): Promise<AuditedMutationResult<GovernanceBypassSignal>>;
  assembleRecallContext(
    input: AuditedRecallContextInput
  ): Promise<AuditedMutationResult<ContextPack>>;
  recordContextPack(
    input: AuditedContextPackInput
  ): Promise<AuditedMutationResult<ContextPack>>;
  selectProvider(
    input: AuditedProviderSelectionInput
  ): Promise<AuditedMutationResult<ProviderSelectionResult>>;
  recordProposal(
    input: AuditedProposalRecordInput
  ): Promise<AuditedMutationResult<ProposalValidationResult>>;
  recordMemorySessionEvent(
    input: AuditedMemorySessionEventInput
  ): Promise<AuditedMutationResult<MemorySessionEvent>>;
  generateTrustSummary(
    input: AuditedTrustSummaryInput
  ): Promise<AuditedMutationResult<TrustSummary>>;
  doctor(): Promise<DoctorReport>;
  close(): Promise<void>;
}
