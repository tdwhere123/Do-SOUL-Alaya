import { randomUUID } from "node:crypto";

import {
  ClaimLifecycleState,
  TransitionCausedBy,
  type ClaimForm,
  type ConflictMatrixEdge,
  type Slot
} from "@do-soul/alaya-protocol";

import { CoreError } from "../shared/errors.js";
import { parseNonEmptyString, parseObjectId } from "../shared/validators.js";

import {
  buildConflictMatrixEdge,
  buildConflictMatrixEdgeCreatedEntry,
  buildNoChallengerDecision,
  buildSelectedWinnerDecision,
  buildWinnerChangedEntry,
  collectDecisiveChallengers,
  collectIncompatibleClaimIds,
  isCandidateForSlot,
  parseEdgeInput,
  pickHighestPriorityClaim,
  type ArbitrationResult,
  type ArbitrationSelection,
  type ArbitrationServiceDependencies,
  type ConflictMatrixEdgeInput,
  type ConflictMatrixRebuildResult,
  type WinnerChangeOptions
} from "./arbitration-service-ports.js";

export type {
  ArbitrationResult,
  ArbitrationRuntimeNotifierPort,
  ArbitrationServiceClaimRepoPort,
  ArbitrationServiceClaimServicePort,
  ArbitrationServiceConflictMatrixRepoPort,
  ArbitrationServiceDependencies,
  ArbitrationServiceEventLogRepoPort,
  ArbitrationServiceSlotRepoPort,
  ConflictMatrixEdgeInput,
  ConflictMatrixRebuildResult
} from "./arbitration-service-ports.js";

export class ArbitrationService {
  public readonly generateObjectId: () => string;

  public readonly now: () => string;

  public constructor(public readonly dependencies: ArbitrationServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async listEdgesByWorkspace(workspaceId: string): Promise<readonly Readonly<ConflictMatrixEdge>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    return await this.dependencies.conflictMatrixRepo.findByWorkspace(parsedWorkspaceId);
  }

  public async createEdge(
    input: ConflictMatrixEdgeInput,
    workspaceId: string
  ): Promise<Readonly<ConflictMatrixEdge>> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    const parsedInput = parseEdgeInput(input);
    const { sourceClaim } = await this.requireClaimsForEdge(parsedInput, parsedWorkspaceId);
    const timestamp = this.now();
    const edge = buildConflictMatrixEdge(this.generateObjectId, parsedInput, sourceClaim.workspace_id, timestamp);
    const event = await this.dependencies.eventLogRepo.append(buildConflictMatrixEdgeCreatedEntry(edge));
    const created = await this.dependencies.conflictMatrixRepo.create(edge);
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return created;
  }

  public async deleteEdge(edgeId: string, workspaceId: string): Promise<void> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    const parsedEdgeId = parseObjectId(edgeId, "edge_id");
    const existing = await this.dependencies.conflictMatrixRepo.findById(parsedEdgeId);

    // Cross-workspace edges are indistinguishable from missing ones.
    if (existing === null || existing.workspace_id !== parsedWorkspaceId) {
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

  public async arbitrateSlot(slotId: string, options: {
      readonly dryRun?: boolean;
    } = {}): Promise<ArbitrationResult> {
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

  public async resolveSlotConflict(
    slotId: string,
    winnerClaimId: string,
    workspaceId: string
  ): Promise<Readonly<Slot>> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    const parsedSlotId = parseObjectId(slotId, "slot_id");
    const parsedWinnerClaimId = parseObjectId(winnerClaimId, "winner_claim_id");

    const slot = await this.dependencies.slotRepo.findById(parsedSlotId);

    // Cross-workspace slots are indistinguishable from missing ones.
    if (slot === null || slot.workspace_id !== parsedWorkspaceId) {
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

  private async selectArbitrationDecision(slot: Readonly<Slot>, candidates: readonly Readonly<ClaimForm>[]): Promise<ArbitrationSelection> {
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
    const decisiveChallengers = collectDecisiveChallengers(candidates, edges, incumbentId);

    if (decisiveChallengers.length === 0) {
      return buildNoChallengerDecision(candidates, edges, incumbentId);
    }

    const selectedWinner = pickHighestPriorityClaim(decisiveChallengers, edges);
    return buildSelectedWinnerDecision(selectedWinner, decisiveChallengers, incumbentId);
  }

  private async applySelection(slot: Readonly<Slot>, candidates: readonly Readonly<ClaimForm>[], selection: ArbitrationSelection): Promise<void> {
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

  private async markClaimsContested(candidates: readonly Readonly<ClaimForm>[], contestedIds: ReadonlySet<string>): Promise<void> {
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

  private async applyWinnerChange(slot: Readonly<Slot>, candidates: readonly Readonly<ClaimForm>[], winnerClaimId: string | null, options: WinnerChangeOptions): Promise<Readonly<Slot> | null> {
    if (winnerClaimId === null) {
      return null;
    }

    const winnerClaim = candidates.find((claim) => claim.object_id === winnerClaimId) ?? null;
    const incumbentClaim =
      slot.winner_claim_id === null
        ? null
        : candidates.find((claim) => claim.object_id === slot.winner_claim_id) ?? null;

    await this.transitionIncumbentClaimIfNeeded(incumbentClaim, winnerClaimId, options);
    await this.transitionWinnerClaimIfNeeded(winnerClaim, options);
    const timestamp = this.now();
    const event = await this.dependencies.eventLogRepo.append(
      buildWinnerChangedEntry(slot, winnerClaimId, options, timestamp)
    );
    const updatedSlot = await this.dependencies.slotRepo.updateWinner(slot.object_id, winnerClaimId, timestamp, timestamp);
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return updatedSlot;
  }

  private async loadEdgesForCandidates(candidates: readonly Readonly<ClaimForm>[]): Promise<readonly Readonly<ConflictMatrixEdge>[]> {
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

  private async requireClaimsForEdge(input: ConflictMatrixEdgeInput, workspaceId: string): Promise<{
    readonly sourceClaim: Readonly<ClaimForm>;
    readonly targetClaim: Readonly<ClaimForm>;
  }> {
    const sourceClaim = await this.dependencies.claimRepo.findById(input.source_claim_id);
    const targetClaim = await this.dependencies.claimRepo.findById(input.target_claim_id);
    // Cross-workspace claims are indistinguishable from missing ones so the
    // edge cannot bridge or leak across the bound workspace.
    if (sourceClaim === null || sourceClaim.workspace_id !== workspaceId) {
      throw new CoreError("NOT_FOUND", "Source claim not found");
    }
    if (targetClaim === null || targetClaim.workspace_id !== workspaceId) {
      throw new CoreError("NOT_FOUND", "Target claim not found");
    }
    if (sourceClaim.workspace_id !== targetClaim.workspace_id) {
      throw new CoreError("VALIDATION", "Claims must belong to the same workspace");
    }
    return { sourceClaim, targetClaim };
  }

  private async transitionIncumbentClaimIfNeeded(
    incumbentClaim: Readonly<ClaimForm> | null,
    winnerClaimId: string,
    options: WinnerChangeOptions
  ): Promise<void> {
    if (
      incumbentClaim === null ||
      incumbentClaim.object_id === winnerClaimId ||
      (incumbentClaim.claim_status !== ClaimLifecycleState.WINNER &&
        incumbentClaim.claim_status !== ClaimLifecycleState.ACTIVE)
    ) {
      return;
    }

    await this.dependencies.claimService.transitionLifecycle(
      incumbentClaim.object_id,
      ClaimLifecycleState.SUPERSEDED,
      `${options.lifecycleReasonPrefix}_superseded`,
      options.causedBy,
      { skipSlotElection: true }
    );
  }

  private async transitionWinnerClaimIfNeeded(
    winnerClaim: Readonly<ClaimForm> | null,
    options: WinnerChangeOptions
  ): Promise<void> {
    if (
      winnerClaim === null ||
      winnerClaim.claim_status === ClaimLifecycleState.WINNER ||
      (winnerClaim.claim_status !== ClaimLifecycleState.ACTIVE &&
        winnerClaim.claim_status !== ClaimLifecycleState.CONTESTED)
    ) {
      return;
    }

    await this.dependencies.claimService.transitionLifecycle(
      winnerClaim.object_id,
      ClaimLifecycleState.WINNER,
      `${options.lifecycleReasonPrefix}_winner`,
      options.causedBy,
      { skipSlotElection: true }
    );
  }
}
