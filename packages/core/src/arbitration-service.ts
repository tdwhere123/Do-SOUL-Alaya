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
import { CoreError } from "./errors.js";
import { parseNonEmptyString, parseObjectId } from "./shared/validators.js";

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
  private readonly generateObjectId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: ArbitrationServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async listEdgesByWorkspace(workspaceId: string): Promise<readonly Readonly<ConflictMatrixEdge>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    return await this.dependencies.conflictMatrixRepo.findByWorkspace(parsedWorkspaceId);
  }

  public async createEdge(input: ConflictMatrixEdgeInput): Promise<Readonly<ConflictMatrixEdge>> {
    const parsedInput = parseEdgeInput(input);
    const sourceClaim = await this.dependencies.claimRepo.findById(parsedInput.source_claim_id);
    const targetClaim = await this.dependencies.claimRepo.findById(parsedInput.target_claim_id);

    if (sourceClaim === null) {
      throw new CoreError("NOT_FOUND", "Source claim not found");
    }

    if (targetClaim === null) {
      throw new CoreError("NOT_FOUND", "Target claim not found");
    }

    if (sourceClaim.workspace_id !== targetClaim.workspace_id) {
      throw new CoreError("VALIDATION", "Claims must belong to the same workspace");
    }

    const timestamp = this.now();
    const edge = parseEdge({
      object_id: this.generateObjectId(),
      object_kind: "conflict_matrix_edge",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp,
      created_by: parsedInput.created_by,
      source_claim_id: parsedInput.source_claim_id,
      target_claim_id: parsedInput.target_claim_id,
      edge_type: parsedInput.edge_type,
      workspace_id: sourceClaim.workspace_id
    });
    const event = await this.dependencies.eventLogRepo.append({
      event_type: SlotEventType.SOUL_CONFLICT_MATRIX_EDGE_CREATED,
      entity_type: "conflict_matrix_edge",
      entity_id: edge.object_id,
      workspace_id: edge.workspace_id,
      run_id: null,
      caused_by: edge.created_by,
      payload_json: SoulConflictMatrixEdgeCreatedPayloadSchema.parse({
        object_id: edge.object_id,
        object_kind: edge.object_kind,
        workspace_id: edge.workspace_id,
        run_id: null,
        source_claim_id: edge.source_claim_id,
        target_claim_id: edge.target_claim_id,
        edge_type: edge.edge_type
      })
    });

    const created = await this.dependencies.conflictMatrixRepo.create(edge);
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return created;
  }

  public async deleteEdge(edgeId: string): Promise<void> {
    const parsedEdgeId = parseObjectId(edgeId, "edge_id");
    const existing = await this.dependencies.conflictMatrixRepo.findById(parsedEdgeId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Conflict matrix edge not found");
    }

    await this.dependencies.conflictMatrixRepo.delete(parsedEdgeId);
  }

  public async rebuildConflictMatrix(workspaceId: string): Promise<ConflictMatrixRebuildResult> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    const [edges, claims] = await Promise.all([
      this.dependencies.conflictMatrixRepo.findByWorkspace(parsedWorkspaceId),
      this.dependencies.claimRepo.findByWorkspaceId(parsedWorkspaceId)
    ]);

    const claimIds = new Set(claims.map((claim) => claim.object_id));
    const orphanedEdges = edges.filter(
      (edge) => !claimIds.has(edge.source_claim_id) || !claimIds.has(edge.target_claim_id)
    );

    for (const edge of orphanedEdges) {
      await this.dependencies.conflictMatrixRepo.delete(edge.object_id);
    }

    return {
      total_edges: edges.length,
      orphaned_deleted: orphanedEdges.length,
      valid_edges: edges.length - orphanedEdges.length
    };
  }

  public async arbitrateSlot(
    slotId: string,
    options: {
      readonly dryRun?: boolean;
    } = {}
  ): Promise<ArbitrationResult> {
    const parsedSlotId = parseObjectId(slotId, "slot_id");
    const slot = await this.dependencies.slotRepo.findById(parsedSlotId);

    if (slot === null) {
      throw new CoreError("NOT_FOUND", "Slot not found");
    }

    const workspaceClaims = await this.dependencies.claimRepo.findByWorkspaceId(slot.workspace_id);
    const candidates = workspaceClaims.filter((claim) => isCandidateForSlot(claim, slot));

    const selection = await this.selectArbitrationDecision(slot, candidates);

    if (options.dryRun !== true) {
      await this.applySelection(slot, candidates, selection);
    }

    const updatedSlot =
      selection.decision === "winner_changed" && options.dryRun !== true
        ? await this.dependencies.slotRepo.findById(slot.object_id)
        : slot;

    return {
      slot: updatedSlot ?? slot,
      decision: selection.decision,
      winner_claim_id: selection.winnerClaimId,
      contested_claim_ids: selection.contestedClaimIds,
      reason: selection.reason
    };
  }

  public async resolveSlotConflict(slotId: string, winnerClaimId: string): Promise<Readonly<Slot>> {
    const parsedSlotId = parseObjectId(slotId, "slot_id");
    const parsedWinnerClaimId = parseObjectId(winnerClaimId, "winner_claim_id");

    const slot = await this.dependencies.slotRepo.findById(parsedSlotId);

    if (slot === null) {
      throw new CoreError("NOT_FOUND", "Slot not found");
    }

    const workspaceClaims = await this.dependencies.claimRepo.findByWorkspaceId(slot.workspace_id);
    const candidates = workspaceClaims.filter((claim) => isCandidateForSlot(claim, slot));

    const winnerCandidate = candidates.find((claim) => claim.object_id === parsedWinnerClaimId) ?? null;

    if (winnerCandidate === null) {
      throw new CoreError("VALIDATION", "winner_claim_id must match a candidate claim in slot");
    }

    await this.applyWinnerChange(slot, candidates, parsedWinnerClaimId, {
      causedBy: TransitionCausedBy.REVIEW,
      lifecycleReasonPrefix: "manual_resolution",
      eventReasonCode: "manual_resolution"
    });

    const updated = await this.dependencies.slotRepo.findById(slot.object_id);

    if (updated === null) {
      throw new CoreError("CONFLICT", "Slot disappeared during conflict resolution");
    }

    return updated;
  }

  private async selectArbitrationDecision(
    slot: Readonly<Slot>,
    candidates: readonly Readonly<ClaimForm>[]
  ): Promise<ArbitrationSelection> {
    if (candidates.length === 0) {
      return {
        decision: "no_change",
        winnerClaimId: slot.winner_claim_id,
        contestedClaimIds: [],
        reason: "no_candidates"
      };
    }

    const candidateIds = new Set(candidates.map((claim) => claim.object_id));
    const edges = await this.loadEdgesForCandidates(candidates);

    const incompatibleIds = collectIncompatibleClaimIds(edges, candidateIds);
    if (incompatibleIds.length > 0) {
      return {
        decision: "contested",
        winnerClaimId: slot.winner_claim_id,
        contestedClaimIds: incompatibleIds,
        reason: "incompatible_with"
      };
    }

    const incumbentId = slot.winner_claim_id;
    const decisiveChallengers = candidates.filter((candidate) => {
      if (incumbentId === null || candidate.object_id === incumbentId) {
        return false;
      }

      return edges.some(
        (edge) =>
          edge.source_claim_id === candidate.object_id &&
          edge.target_claim_id === incumbentId &&
          decisiveEdgeTypes.has(edge.edge_type)
      );
    });

    if (decisiveChallengers.length === 0) {
      if (hasNonConflictCoverage(candidates, edges)) {
        return {
          decision: "no_change",
          winnerClaimId: incumbentId,
          contestedClaimIds: [],
          reason: "non_conflict_edges"
        };
      }

      return {
        decision: candidates.length > 1 ? "contested" : "no_change",
        winnerClaimId: incumbentId,
        contestedClaimIds: candidates.length > 1 ? candidates.map((claim) => claim.object_id) : [],
        reason: candidates.length > 1 ? "same_scope_no_decisive_edge" : "single_candidate"
      };
    }

    const selectedWinner = pickHighestPriorityClaim(decisiveChallengers, edges);

    if (selectedWinner === null) {
      return {
        decision: "contested",
        winnerClaimId: incumbentId,
        contestedClaimIds: decisiveChallengers.map((claim) => claim.object_id),
        reason: "priority_tie"
      };
    }

    if (selectedWinner.object_id === incumbentId) {
      return {
        decision: "no_change",
        winnerClaimId: incumbentId,
        contestedClaimIds: [],
        reason: "incumbent_retained"
      };
    }

    return {
      decision: "winner_changed",
      winnerClaimId: selectedWinner.object_id,
      contestedClaimIds: [],
      reason: "decisive_edge_priority"
    };
  }

  private async applySelection(
    slot: Readonly<Slot>,
    candidates: readonly Readonly<ClaimForm>[],
    selection: ArbitrationSelection
  ): Promise<void> {
    if (selection.decision === "contested") {
      await this.markClaimsContested(candidates, new Set(selection.contestedClaimIds));
      return;
    }

    if (selection.decision === "winner_changed") {
      await this.applyWinnerChange(slot, candidates, selection.winnerClaimId, {
        causedBy: TransitionCausedBy.SYSTEM,
        lifecycleReasonPrefix: "arbitration",
        eventReasonCode: `arbitration_${selection.reason}`
      });
      return;
    }
  }

  private async markClaimsContested(
    candidates: readonly Readonly<ClaimForm>[],
    contestedIds: ReadonlySet<string>
  ): Promise<void> {
    for (const claim of candidates) {
      if (!contestedIds.has(claim.object_id)) {
        continue;
      }

      if (claim.claim_status === ClaimLifecycleState.ACTIVE) {
        await this.dependencies.claimService.transitionLifecycle(
          claim.object_id,
          ClaimLifecycleState.CONTESTED,
          "arbitration_contested",
          TransitionCausedBy.SYSTEM,
          { skipSlotElection: true }
        );
      }
    }
  }

  private async applyWinnerChange(
    slot: Readonly<Slot>,
    candidates: readonly Readonly<ClaimForm>[],
    winnerClaimId: string | null,
    options: WinnerChangeOptions
  ): Promise<Readonly<Slot> | null> {
    if (winnerClaimId === null) {
      return null;
    }

    const winnerClaim = candidates.find((claim) => claim.object_id === winnerClaimId) ?? null;
    const incumbentClaim =
      slot.winner_claim_id === null
        ? null
        : candidates.find((claim) => claim.object_id === slot.winner_claim_id) ?? null;

    if (incumbentClaim !== null && incumbentClaim.object_id !== winnerClaimId) {
      if (
        incumbentClaim.claim_status === ClaimLifecycleState.WINNER ||
        incumbentClaim.claim_status === ClaimLifecycleState.ACTIVE
      ) {
        await this.dependencies.claimService.transitionLifecycle(
          incumbentClaim.object_id,
          ClaimLifecycleState.SUPERSEDED,
          `${options.lifecycleReasonPrefix}_superseded`,
          options.causedBy,
          { skipSlotElection: true }
        );
      }
    }

    if (winnerClaim !== null && winnerClaim.claim_status !== ClaimLifecycleState.WINNER) {
      if (
        winnerClaim.claim_status === ClaimLifecycleState.ACTIVE ||
        winnerClaim.claim_status === ClaimLifecycleState.CONTESTED
      ) {
        await this.dependencies.claimService.transitionLifecycle(
          winnerClaim.object_id,
          ClaimLifecycleState.WINNER,
          `${options.lifecycleReasonPrefix}_winner`,
          options.causedBy,
          { skipSlotElection: true }
        );
      }
    }

    const timestamp = this.now();
    const event = await this.dependencies.eventLogRepo.append({
      event_type: SlotEventType.SOUL_SLOT_WINNER_CHANGED,
      entity_type: "slot",
      entity_id: slot.object_id,
      workspace_id: slot.workspace_id,
      run_id: null,
      caused_by: options.causedBy,
      payload_json: SoulSlotWinnerChangedPayloadSchema.parse({
        object_id: slot.object_id,
        object_kind: slot.object_kind,
        workspace_id: slot.workspace_id,
        run_id: null,
        from_claim_id: slot.winner_claim_id,
        to_claim_id: winnerClaimId,
        reason_code: options.eventReasonCode,
        caused_by: options.causedBy,
        evidence_refs: null,
        occurred_at: timestamp
      })
    });

    const updatedSlot = await this.dependencies.slotRepo.updateWinner(slot.object_id, winnerClaimId, timestamp, timestamp);
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return updatedSlot;
  }

  private async loadEdgesForCandidates(
    candidates: readonly Readonly<ClaimForm>[]
  ): Promise<readonly Readonly<ConflictMatrixEdge>[]> {
    if (candidates.length === 0) {
      return [];
    }

    const candidateIds = new Set(candidates.map((claim) => claim.object_id));
    const workspaceId = candidates[0].workspace_id;
    const workspaceEdges = await this.dependencies.conflictMatrixRepo.findByWorkspace(workspaceId);
    const edgesById = new Map<string, Readonly<ConflictMatrixEdge>>();

    for (const edge of workspaceEdges) {
      if (!candidateIds.has(edge.source_claim_id) || !candidateIds.has(edge.target_claim_id)) {
        continue;
      }

      edgesById.set(edge.object_id, edge);
    }

    return [...edgesById.values()];
  }
}

function parseEdgeInput(value: ConflictMatrixEdgeInput): ConflictMatrixEdgeInput {
  const sourceClaimId = parseObjectId(value.source_claim_id, "source_claim_id");
  const targetClaimId = parseObjectId(value.target_claim_id, "target_claim_id");

  if (sourceClaimId === targetClaimId) {
    throw new CoreError("VALIDATION", "source_claim_id and target_claim_id must be different");
  }

  return {
    source_claim_id: sourceClaimId,
    target_claim_id: targetClaimId,
    edge_type: parseEdgeType(value.edge_type),
    created_by: parseNonEmptyString(value.created_by, "created_by")
  };
}

function parseEdgeType(value: ConflictEdgeTypeType): ConflictEdgeTypeType {
  try {
    return ConflictEdgeTypeSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid conflict edge type", { cause: error });
  }
}

function parseEdge(value: ConflictMatrixEdge): Readonly<ConflictMatrixEdge> {
  try {
    return ConflictMatrixEdgeSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid conflict matrix edge payload", { cause: error });
  }
}

function isCandidateForSlot(claim: Readonly<ClaimForm>, slot: Readonly<Slot>): boolean {
  return (
    claim.workspace_id === slot.workspace_id &&
    claim.claim_kind === slot.claim_kind &&
    claim.scope_class === slot.scope_class &&
    claim.governance_subject.canonical_key === slot.governance_subject.canonical_key &&
    (claim.claim_status === ClaimLifecycleState.ACTIVE ||
      claim.claim_status === ClaimLifecycleState.CONTESTED ||
      claim.claim_status === ClaimLifecycleState.WINNER)
  );
}

function collectIncompatibleClaimIds(
  edges: readonly Readonly<ConflictMatrixEdge>[],
  candidateIds: ReadonlySet<string>
): readonly string[] {
  const ids = new Set<string>();

  for (const edge of edges) {
    if (edge.edge_type !== incompatibleEdgeType) {
      continue;
    }

    if (candidateIds.has(edge.source_claim_id)) {
      ids.add(edge.source_claim_id);
    }

    if (candidateIds.has(edge.target_claim_id)) {
      ids.add(edge.target_claim_id);
    }
  }

  return [...ids].sort((left, right) => left.localeCompare(right));
}

function hasNonConflictCoverage(
  candidates: readonly Readonly<ClaimForm>[],
  edges: readonly Readonly<ConflictMatrixEdge>[]
): boolean {
  if (candidates.length < 2) {
    return false;
  }

  const totalPairs = (candidates.length * (candidates.length - 1)) / 2;
  const coveredPairs = new Set<string>();
  const candidateIds = new Set(candidates.map((candidate) => candidate.object_id));

  for (const edge of edges) {
    if (!candidateIds.has(edge.source_claim_id) || !candidateIds.has(edge.target_claim_id)) {
      continue;
    }

    if (decisiveEdgeTypes.has(edge.edge_type) || edge.edge_type === incompatibleEdgeType) {
      return false;
    }

    if (!nonConflictEdgeTypes.has(edge.edge_type)) {
      continue;
    }

    const left = edge.source_claim_id < edge.target_claim_id ? edge.source_claim_id : edge.target_claim_id;
    const right = edge.source_claim_id < edge.target_claim_id ? edge.target_claim_id : edge.source_claim_id;
    coveredPairs.add(`${left}:${right}`);
  }

  return coveredPairs.size === totalPairs;
}

function pickHighestPriorityClaim(
  claims: readonly Readonly<ClaimForm>[],
  edges: readonly Readonly<ConflictMatrixEdge>[]
): Readonly<ClaimForm> | null {
  if (claims.length === 0) {
    return null;
  }

  let selected: Readonly<ClaimForm> | null = null;
  let selectedScore: readonly [number, number, number, number] | null = null;
  let hasTie = false;

  for (const claim of claims) {
    const score = scoreClaim(claim, edges);

    if (selected === null || selectedScore === null) {
      selected = claim;
      selectedScore = score;
      hasTie = false;
      continue;
    }

    const comparison = compareScores(score, selectedScore);

    if (comparison > 0) {
      selected = claim;
      selectedScore = score;
      hasTie = false;
      continue;
    }

    if (comparison === 0) {
      hasTie = true;
    }
  }

  if (hasTie) {
    return null;
  }

  return selected;
}

function scoreClaim(
  claim: Readonly<ClaimForm>,
  edges: readonly Readonly<ConflictMatrixEdge>[]
): readonly [number, number, number, number] {
  const domainScore = securityDomains.has(claim.governance_subject.subject_domain) ? 1 : 0;
  const explicitExceptionScore =
    claim.claim_kind === "exception" ||
    edges.some(
      (edge) => edge.source_claim_id === claim.object_id && edge.edge_type === ConflictEdgeType.EXCEPTION_TO
    )
      ? 1
      : 0;
  const originScore = originTierPriority[claim.origin_tier];
  const precedenceScore = claim.precedence_basis === "user_override" ? 1 : 0;

  return [domainScore, explicitExceptionScore, precedenceScore, originScore];
}

function compareScores(
  left: readonly [number, number, number, number],
  right: readonly [number, number, number, number]
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) {
      return 1;
    }

    if (left[index] < right[index]) {
      return -1;
    }
  }

  return 0;
}