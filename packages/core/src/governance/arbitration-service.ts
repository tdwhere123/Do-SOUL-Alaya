import { randomUUID } from "node:crypto";
import {
  ClaimLifecycleState,
  ConflictEdgeType,
  ConflictEdgeTypeSchema,
  ConflictMatrixEdgeSchema,
  SlotEventType,
  SoulConflictMatrixEdgeCreatedPayloadSchema,
  SoulSlotWinnerChangedPayloadSchema,
  TransitionCausedBy,
  type ClaimForm,
  type ClaimLifecycleState as ClaimLifecycleStateType,
  type ConflictEdgeType as ConflictEdgeTypeType,
  type ConflictMatrixEdge,
  type EventLogEntry,
  type Slot
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { parseNonEmptyString, parseObjectId } from "../shared/validators.js";

import { arbitrationServiceListEdgesByWorkspace, arbitrationServiceCreateEdge, arbitrationServiceDeleteEdge, arbitrationServiceRebuildConflictMatrix, arbitrationServiceArbitrateSlot } from "./arbitration-service-methods-1.js";
import { arbitrationServiceResolveSlotConflict, arbitrationServiceSelectArbitrationDecision, arbitrationServiceApplySelection, arbitrationServiceMarkClaimsContested } from "./arbitration-service-methods-2.js";
import { arbitrationServiceApplyWinnerChange, arbitrationServiceLoadEdgesForCandidates } from "./arbitration-service-methods-3.js";

export interface ArbitrationServiceSlotRepoPort {
  findById(objectId: string): Promise<Readonly<Slot> | null>;
  updateWinner(
    objectId: string,
    winnerClaimId: string | null,
    incumbentSince: string | null,
    updatedAt: string
  ): Promise<Readonly<Slot>>;
}

export interface ArbitrationServiceClaimRepoPort {
  findById(objectId: string): Promise<Readonly<ClaimForm> | null>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<ClaimForm>[]>;
}

export interface ArbitrationServiceConflictMatrixRepoPort {
  create(edge: Readonly<ConflictMatrixEdge>): Promise<Readonly<ConflictMatrixEdge>>;
  findById(objectId: string): Promise<Readonly<ConflictMatrixEdge> | null>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<ConflictMatrixEdge>[]>;
  findBetweenClaims(
    sourceClaimId: string,
    targetClaimId: string
  ): Promise<readonly Readonly<ConflictMatrixEdge>[]>;
  delete(objectId: string): Promise<void>;
}

export interface ArbitrationServiceClaimServicePort {
  transitionLifecycle(
    objectId: string,
    newState: ClaimLifecycleStateType,
    reason: string,
    causedBy: TransitionCausedBy,
    options?: {
      readonly skipSlotElection?: boolean;
    }
  ): Promise<Readonly<ClaimForm>>;
}

export interface ArbitrationServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface ArbitrationRuntimeNotifierPort {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface ArbitrationServiceDependencies {
  readonly slotRepo: ArbitrationServiceSlotRepoPort;
  readonly claimRepo: ArbitrationServiceClaimRepoPort;
  readonly conflictMatrixRepo: ArbitrationServiceConflictMatrixRepoPort;
  readonly claimService: ArbitrationServiceClaimServicePort;
  readonly eventLogRepo: ArbitrationServiceEventLogRepoPort;
  readonly runtimeNotifier: ArbitrationRuntimeNotifierPort;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

export interface ConflictMatrixEdgeInput {
  readonly source_claim_id: string;
  readonly target_claim_id: string;
  readonly edge_type: ConflictEdgeTypeType;
  readonly created_by: string;
}

export interface ArbitrationResult {
  readonly slot: Readonly<Slot>;
  readonly decision: "winner_changed" | "contested" | "no_change";
  readonly winner_claim_id: string | null;
  readonly contested_claim_ids: readonly string[];
  readonly reason: string;
}

export interface ConflictMatrixRebuildResult {
  readonly total_edges: number;
  readonly orphaned_deleted: number;
  readonly valid_edges: number;
}

interface ArbitrationSelection {
  readonly decision: "winner_changed" | "contested" | "no_change";
  readonly winnerClaimId: string | null;
  readonly contestedClaimIds: readonly string[];
  readonly reason: string;
}

interface WinnerChangeOptions {
  readonly causedBy: TransitionCausedBy;
  readonly lifecycleReasonPrefix: string;
  readonly eventReasonCode: string;
}

const decisiveEdgeTypes = new Set<ConflictEdgeTypeType>([
  ConflictEdgeType.EXCEPTION_TO,
  ConflictEdgeType.SUPERSEDES,
  ConflictEdgeType.OVERRIDES_WITHIN_SCOPE
]);

const nonConflictEdgeTypes = new Set<ConflictEdgeTypeType>([
  ConflictEdgeType.SUPPORTS,
  ConflictEdgeType.DERIVES_FROM
]);

const incompatibleEdgeType = ConflictEdgeType.INCOMPATIBLE_WITH;

const securityDomains = new Set(["security", "compliance", "safety"]);

const originTierPriority: Readonly<Record<ClaimForm["origin_tier"], number>> = {
  user_explicit: 5,
  review_accepted: 4,
  compiler_extracted: 3,
  imported: 2,
  seed: 1
};

export class ArbitrationService {
public readonly generateObjectId: () => string;

public readonly now: () => string;

public constructor(public readonly dependencies: ArbitrationServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async listEdgesByWorkspace(workspaceId: string): Promise<readonly Readonly<ConflictMatrixEdge>[]> {
    return arbitrationServiceListEdgesByWorkspace(this, workspaceId);
  }

  public async createEdge(input: ConflictMatrixEdgeInput): Promise<Readonly<ConflictMatrixEdge>> {
    return arbitrationServiceCreateEdge(this, input);
  }

  public async deleteEdge(edgeId: string): Promise<void> {
    return arbitrationServiceDeleteEdge(this, edgeId);
  }

  public async rebuildConflictMatrix(workspaceId: string): Promise<ConflictMatrixRebuildResult> {
    return arbitrationServiceRebuildConflictMatrix(this, workspaceId);
  }

  public async arbitrateSlot(slotId: string, options: {
      readonly dryRun?: boolean;
    } = {}): Promise<ArbitrationResult> {
    return arbitrationServiceArbitrateSlot(this, slotId, options);
  }

  public async resolveSlotConflict(slotId: string, winnerClaimId: string): Promise<Readonly<Slot>> {
    return arbitrationServiceResolveSlotConflict(this, slotId, winnerClaimId);
  }

  private async selectArbitrationDecision(slot: Readonly<Slot>, candidates: readonly Readonly<ClaimForm>[]): Promise<ArbitrationSelection> {
    return arbitrationServiceSelectArbitrationDecision(this, slot, candidates);
  }

  private async applySelection(slot: Readonly<Slot>, candidates: readonly Readonly<ClaimForm>[], selection: ArbitrationSelection): Promise<void> {
    return arbitrationServiceApplySelection(this, slot, candidates, selection);
  }

  private async markClaimsContested(candidates: readonly Readonly<ClaimForm>[], contestedIds: ReadonlySet<string>): Promise<void> {
    return arbitrationServiceMarkClaimsContested(this, candidates, contestedIds);
  }

  private async applyWinnerChange(slot: Readonly<Slot>, candidates: readonly Readonly<ClaimForm>[], winnerClaimId: string | null, options: WinnerChangeOptions): Promise<Readonly<Slot> | null> {
    return arbitrationServiceApplyWinnerChange(this, slot, candidates, winnerClaimId, options);
  }

  private async loadEdgesForCandidates(candidates: readonly Readonly<ClaimForm>[]): Promise<readonly Readonly<ConflictMatrixEdge>[]> {
    return arbitrationServiceLoadEdgesForCandidates(this, candidates);
  }
}
