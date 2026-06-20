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
type ArbitrationServiceMethodOwner = {
  generateObjectId: () => string;
  now: () => string;
  dependencies: ArbitrationServiceDependencies;
  [key: string]: any;
};


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

export async function arbitrationServiceListEdgesByWorkspace(owner: ArbitrationServiceMethodOwner, workspaceId: string): Promise<readonly Readonly<ConflictMatrixEdge>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    return await owner.dependencies.conflictMatrixRepo.findByWorkspace(parsedWorkspaceId);
  }

export async function arbitrationServiceCreateEdge(owner: ArbitrationServiceMethodOwner, input: ConflictMatrixEdgeInput): Promise<Readonly<ConflictMatrixEdge>> {
    const parsedInput = parseEdgeInput(input);
    const { sourceClaim, targetClaim } = await requireClaimsForEdge(owner, parsedInput);
    const timestamp = owner.now();
    const edge = buildConflictMatrixEdge(owner, parsedInput, sourceClaim.workspace_id, timestamp);
    const event = await appendConflictMatrixEdgeCreatedEvent(owner, edge);
    const created = await owner.dependencies.conflictMatrixRepo.create(edge);
    await owner.dependencies.runtimeNotifier.notifyEntry(event);
    return created;
  }

export async function arbitrationServiceDeleteEdge(owner: ArbitrationServiceMethodOwner, edgeId: string): Promise<void> {
    const parsedEdgeId = parseObjectId(edgeId, "edge_id");
    const existing = await owner.dependencies.conflictMatrixRepo.findById(parsedEdgeId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Conflict matrix edge not found");
    }

    await owner.dependencies.conflictMatrixRepo.delete(parsedEdgeId);
  }

export async function arbitrationServiceRebuildConflictMatrix(owner: ArbitrationServiceMethodOwner, workspaceId: string): Promise<ConflictMatrixRebuildResult> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    const [edges, claims] = await Promise.all([
      owner.dependencies.conflictMatrixRepo.findByWorkspace(parsedWorkspaceId),
      owner.dependencies.claimRepo.findByWorkspaceId(parsedWorkspaceId)
    ]);

    const claimIds = new Set(claims.map((claim) => claim.object_id));
    const orphanedEdges = edges.filter(
      (edge) => !claimIds.has(edge.source_claim_id) || !claimIds.has(edge.target_claim_id)
    );

    for (const edge of orphanedEdges) {
      await owner.dependencies.conflictMatrixRepo.delete(edge.object_id);
    }

    return {
      total_edges: edges.length,
      orphaned_deleted: orphanedEdges.length,
      valid_edges: edges.length - orphanedEdges.length
    };
  }

async function requireClaimsForEdge(
  owner: ArbitrationServiceMethodOwner,
  input: ConflictMatrixEdgeInput
): Promise<{
  readonly sourceClaim: Readonly<ClaimForm>;
  readonly targetClaim: Readonly<ClaimForm>;
}> {
  const sourceClaim = await owner.dependencies.claimRepo.findById(input.source_claim_id);
  const targetClaim = await owner.dependencies.claimRepo.findById(input.target_claim_id);
  if (sourceClaim === null) {
    throw new CoreError("NOT_FOUND", "Source claim not found");
  }
  if (targetClaim === null) {
    throw new CoreError("NOT_FOUND", "Target claim not found");
  }
  if (sourceClaim.workspace_id !== targetClaim.workspace_id) {
    throw new CoreError("VALIDATION", "Claims must belong to the same workspace");
  }
  return { sourceClaim, targetClaim };
}

function buildConflictMatrixEdge(
  owner: ArbitrationServiceMethodOwner,
  input: ConflictMatrixEdgeInput,
  workspaceId: string,
  timestamp: string
): Readonly<ConflictMatrixEdge> {
  return parseEdge({
    object_id: owner.generateObjectId(),
    object_kind: "conflict_matrix_edge",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: timestamp,
    updated_at: timestamp,
    created_by: input.created_by,
    source_claim_id: input.source_claim_id,
    target_claim_id: input.target_claim_id,
    edge_type: input.edge_type,
    workspace_id: workspaceId
  });
}

async function appendConflictMatrixEdgeCreatedEvent(
  owner: ArbitrationServiceMethodOwner,
  edge: Readonly<ConflictMatrixEdge>
): Promise<EventLogEntry> {
  return await owner.dependencies.eventLogRepo.append({
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
}

export async function arbitrationServiceArbitrateSlot(owner: ArbitrationServiceMethodOwner, slotId: string, options: {
      readonly dryRun?: boolean;
    } = {}): Promise<ArbitrationResult> {
    const parsedSlotId = parseObjectId(slotId, "slot_id");
    const slot = await owner.dependencies.slotRepo.findById(parsedSlotId);

    if (slot === null) {
      throw new CoreError("NOT_FOUND", "Slot not found");
    }

    const workspaceClaims = await owner.dependencies.claimRepo.findByWorkspaceId(slot.workspace_id);
    const candidates = workspaceClaims.filter((claim) => isCandidateForSlot(claim, slot));

    const selection = await owner.selectArbitrationDecision(slot, candidates);

    if (options.dryRun !== true) {
      await owner.applySelection(slot, candidates, selection);
    }

    const updatedSlot =
      selection.decision === "winner_changed" && options.dryRun !== true
        ? await owner.dependencies.slotRepo.findById(slot.object_id)
        : slot;

    return {
      slot: updatedSlot ?? slot,
      decision: selection.decision,
      winner_claim_id: selection.winnerClaimId,
      contested_claim_ids: selection.contestedClaimIds,
      reason: selection.reason
    };
  }
