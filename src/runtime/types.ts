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

export interface AuditedGovernanceBypassInput extends Omit<AuditedMutationInput, "kind" | "target" | "payload"> {
  readonly workspaceId: string;
  readonly attemptedMutation: string;
  readonly actorRef: string;
  readonly recoverable?: boolean;
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
  recordGovernanceBypass(
    input: AuditedGovernanceBypassInput
  ): Promise<AuditedMutationResult<GovernanceBypassSignal>>;
  doctor(): Promise<DoctorReport>;
  close(): Promise<void>;
}
