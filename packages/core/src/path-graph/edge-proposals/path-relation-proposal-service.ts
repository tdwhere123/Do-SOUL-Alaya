import { randomUUID } from "node:crypto";
import {
  getPathAnchorBackingObjectId,
  pathRelationMatchesIdentity,
  type PathAnchorRef} from "@do-soul/alaya-protocol";
import { EventPublisherPropagationError } from "../../runtime/event-publisher.js";
import {
  PATH_RELATION_COUNTER_DEFAULT_TTL_MS,
  clampGovernanceToAutoBuildCeiling,
  errorMessage,
  type AnchorValidationFailure,
  type CoUsageCounterPort,
  type MemoryAnchorExistencePort,
  type PathMintOutcome,
  type PathRelationProposalServiceDeps} from "./path-relation-proposal-service-shared.js";
import {
  buildPathRelation,
  buildPathRelationCreatedEventInput,
  buildPathRelationRejectedEventInput,
  type MaterializePathRelationInput,
  type SubmitCandidateInput
} from "./path-relation-proposal-materialization.js";
export {
  ANSWERS_WITH_SEED_PROFILE,
  AUTO_BUILD_GOVERNANCE_CEILING,
  COHERES_WITH_SEED_PROFILE,
  CO_RECALLED_SEED_PROFILE,
  CONTRADICTS_SEED_PROFILE,
  DERIVES_FROM_SEED_PROFILE,
  EXCEPTION_TO_SEED_PROFILE,
  INCOMPATIBLE_SEED_PROFILE,
  PATH_RELATION_COUNTER_DEFAULT_TTL_MS,
  SHARES_ENTITY_SEED_PROFILE,
  SIGNAL_GRAPH_REF_SEED_PROFILE,
  SUPERSEDES_SEED_PROFILE,
  SUPPORTS_SEED_PROFILE
} from "./path-relation-proposal-service-shared.js";
export type { SubmitCandidateInput } from "./path-relation-proposal-materialization.js";
export type {
  CoUsageCounterPort,
  MemoryAnchorExistencePort,
  PathMintOutcome,
  PathRelationProposalEventPublisherPort,
  PathRelationProposalRepoPort,
  PathRelationProposalServiceDeps,
  PathSeedProfile
} from "./path-relation-proposal-service-shared.js";

// invariant: PathRelationProposalService is the single producer of
// PathRelation entities. Producers submit a fully differentiated
// candidate through submitCandidate; seed profiles differ only in
// relation_kind / strength / governance / evidence / recall_bias sign.
// invariant: agents and producers only propose; Alaya decides durable
// recall topology. auto-build governance has a hard ceiling of
// recall_allowed — strictly_governed is reserved for user/operator action
// and submitCandidate clamps any caller that asks for it down to
// recall_allowed. Causal usage receipts affect only the bounded temporal
// soft-strength projection.
// invariant: positive and negative relation families share one plasticity
// model. The family is expressed only by the sign of effect_vector
// .recall_bias (supports +, contradicts/supersedes -).
// invariant: leftover co-usage counter rows carry updated_at so the
// daemon can evict stale pairs. Durable double-propose protection comes
// from findByAnchorMemoryId against persisted PathRelations.
// invariant: row insert and `path.relation_created` EventLog row are
// emitted in one SQLite transaction via EventPublisher.appendManyWithMutation.
// see also: PathRelationRepo — durable write side
// see also: SqliteCoUsageCounterRepo — durable counter backing
// see also: spine-activation-design.md §E2 — seed-profile table source


export class PathRelationProposalService {
  private readonly counterStore: CoUsageCounterPort;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly counterTtlMs: number;
  private readonly generateId: () => string;

  public constructor(private readonly deps: PathRelationProposalServiceDeps) {
    this.counterStore = deps.counterStore;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.counterTtlMs = deps.counterTtlMs ?? PATH_RELATION_COUNTER_DEFAULT_TTL_MS;
    this.generateId = deps.generateId ?? (() => randomUUID());
  }

  // Generalized candidate intake. Producers submit a fully
  // differentiated candidate; it mints once (subject to durable dedup and
  // governance clamp). Edge folding reuses this entry point instead of a
  // parallel mint path. Returns a discriminated PathMintOutcome: applied / already_present
  // on success, rejected on a permanent anchor refusal, failed on a
  // transient (caught) error so a no-drop consumer can keep the work pending.
  public async submitCandidate(input: SubmitCandidateInput): Promise<PathMintOutcome> {
    const recallBias = input.recallBiasSign * (input.recallBiasMagnitude ?? 0.5);
    const governanceClass = clampGovernanceToAutoBuildCeiling(input.governanceClass);
    try {
      return await this.materialize({
        workspaceId: input.workspaceId,
        sourceAnchor: input.sourceAnchor,
        targetAnchor: input.targetAnchor,
        relationKind: input.relationKind,
        initialStrength: input.initialStrength,
        governanceClass,
        evidenceBasis: input.evidenceBasis,
        recallBias,
        supportEventsCount: 0,
        why: input.why ?? [
          `${input.relationKind} candidate submitted by producer`
        ],
        runId: input.runId ?? null,
        contentScore: input.contentScore
      });
    } catch (err) {
      // invariant: distinguish a post-commit propagation error from a true mint
      // failure. EventPublisher commits the path_relations row + PATH_RELATION_CREATED
      // event inside the transaction, THEN runs propagate(); a propagate() throw
      // surfaces as EventPublisherPropagationError AFTER the durable row already
      // landed. The path EXISTS and propagation is eventually-consistent (the
      // final-listener replay pattern handles it), so this is an "applied"
      // outcome — returning "failed" here would make a no-drop consumer record a
      // misleading PATH_MINT_FAILED audit and needlessly revert an accepted
      // proposal whose path is durable.
      // see also: packages/core/src/runtime/event-publisher.ts:appendManyWithMutation,
      //   edge-proposal-service.ts handleMintFailure (the revert this avoids).
      if (err instanceof EventPublisherPropagationError) {
        this.warn("PathRelation submitCandidate committed but propagation failed", {
          workspace_id: input.workspaceId,
          relation_kind: input.relationKind,
          error: errorMessage(err)
        });
        return "applied";
      }
      this.warn("PathRelation submitCandidate failed", {
        workspace_id: input.workspaceId,
        relation_kind: input.relationKind,
        error: errorMessage(err)
      });
      return "failed";
    }
  }

  // invariant: the SAME backing-object existence + ownership gate the mint sink
  // runs (validateObjectAnchors), exposed for the second durable path-insert
  // route — the proposal accept-apply path mints a stored proposed_path_relation
  // through the storage transaction, which cannot import this service. The
  // workflow calls this before that insert so an anchor whose backing memory
  // object (resolved from every variant via getPathAnchorBackingObjectId) is
  // missing or foreign is refused with the same path.relation_rejected audit,
  // and no durable path lands. Returns "accepted" when both anchors' backing
  // objects pass (or the existence port is unwired) and "rejected" — after
  // emitting the audit — on the first failure. This is decided, never transient:
  // a rejected accept-apply must NOT retry.
  // see also: apps/core-daemon/src/mcp-memory/proposal-workflow.ts accept path
  // see also: packages/storage/src/repos/proposal/writes/accept-workflows.ts acceptPendingPathRelationGovernanceWithEvents
  public async validateProposedObjectAnchors(input: {
    readonly workspaceId: string;
    readonly relationKind: string;
    readonly sourceAnchor: PathAnchorRef;
    readonly targetAnchor: PathAnchorRef;
  }): Promise<"accepted" | "rejected"> {
    const failure = await this.validateObjectAnchors(
      input.workspaceId,
      input.sourceAnchor,
      input.targetAnchor
    );
    if (failure === undefined) {
      return "accepted";
    }
    await this.emitRejection(input.workspaceId, input.relationKind, failure);
    return "rejected";
  }

  public async evictExpired(nowMs?: number, ttlMs?: number): Promise<number> {
    const cutoffMs = (nowMs ?? this.nowMs()) - (ttlMs ?? this.counterTtlMs);
    return await this.counterStore.evictExpired(new Date(cutoffMs).toISOString());
  }

  public async counterSize(): Promise<number> {
    return await this.counterStore.size();
  }

  // Single materialize path for every seeder. Differentiated parameters
  // arrive resolved (governance already clamped, recall_bias already
  // signed). Durable dedup + event-first transactional write live here.
  private async materialize(params: MaterializePathRelationInput): Promise<PathMintOutcome> {
    const sourceId = getPathAnchorBackingObjectId(params.sourceAnchor);
    if (this.deps.repo.findByAnchorMemoryId !== undefined) {
      const existing = await this.deps.repo.findByAnchorMemoryId(
        sourceId,
        params.workspaceId,
        params.relationKind
      );
      const alreadyLinked = existing.some((relation) =>
        pathRelationMatchesIdentity(relation, {
          sourceAnchor: params.sourceAnchor,
          targetAnchor: params.targetAnchor,
          relationKind: params.relationKind,
          recallBias: params.recallBias
        })
      );
      if (alreadyLinked) {
        // Counter row is stale once this durable path identity exists; caller
        // drops it so the pair stops re-querying on every future co-occurrence.
        return "already_present";
      }
    }

    // invariant: refuse the mint when any memory-backed anchor names an object
    // missing from, or owned by a workspace other than, this relation's
    // workspace. The check runs BEFORE the EventLog append + DB insert so an
    // untrusted agent/Garden ref cannot become durable governed topology.
    // A refusal emits an auditable path.relation_rejected event and returns
    // "rejected" — no path_relations row, no audit "created" row, no graph
    // neighbor. This is a DECIDED no, distinct from a transient "failed": a
    // no-drop consumer must NOT retry it (the same anchors can never pass).
    const validationFailure = await this.validateObjectAnchors(
      params.workspaceId,
      params.sourceAnchor,
      params.targetAnchor
    );
    if (validationFailure !== undefined) {
      await this.emitRejection(params.workspaceId, params.relationKind, validationFailure);
      return "rejected";
    }

    const occurredAt = this.now();
    const relation = buildPathRelation(params, this.generateId(), occurredAt);
    const eventInput = buildPathRelationCreatedEventInput(relation, params.runId);

    await this.deps.eventPublisher.appendManyWithMutation(
      [eventInput],
      () => {
        this.deps.repo.create(relation);
      }
    );
    return "applied";
  }

  // invariant: every PathAnchorRef variant carries a backing memory object id,
  // and that object must exist in the candidate workspace before durable
  // topology can be minted. Returns the first failure found (source checked
  // before target), or undefined when both backing objects exist in this
  // workspace. No-op when the existence port is unwired (isolated unit tests);
  // the daemon always wires it.
  private async validateObjectAnchors(
    workspaceId: string,
    sourceAnchor: PathAnchorRef,
    targetAnchor: PathAnchorRef
  ): Promise<AnchorValidationFailure | undefined> {
    const port = this.deps.memoryExistence;
    if (port === undefined) {
      return undefined;
    }
    const sourceFailure = await this.checkObjectAnchor(port, workspaceId, sourceAnchor, "source");
    if (sourceFailure !== undefined) {
      return sourceFailure;
    }
    return await this.checkObjectAnchor(port, workspaceId, targetAnchor, "target");
  }

  private async checkObjectAnchor(
    port: MemoryAnchorExistencePort,
    workspaceId: string,
    anchor: PathAnchorRef,
    anchorRole: "source" | "target"
  ): Promise<AnchorValidationFailure | undefined> {
    const objectId = getPathAnchorBackingObjectId(anchor);
    const owningWorkspace = await port.workspaceOfObject(objectId);
    if (owningWorkspace === null) {
      return { anchorRole, objectId, reason: "object_missing" };
    }
    if (owningWorkspace !== workspaceId) {
      return { anchorRole, objectId, reason: "object_foreign_workspace" };
    }
    return undefined;
  }

  private async emitRejection(
    workspaceId: string,
    relationKind: string,
    failure: AnchorValidationFailure
  ): Promise<void> {
    const eventInput = buildPathRelationRejectedEventInput(
      workspaceId,
      relationKind,
      failure,
      this.now()
    );
    // No mutation: the rejection emits an audit row only. The empty mutate
    // callback keeps the same single transactional append the mint uses.
    await this.deps.eventPublisher.appendManyWithMutation([eventInput], () => undefined);
    this.warn("PathRelation candidate rejected: anchor failed existence/ownership", {
      workspace_id: workspaceId,
      relation_kind: relationKind,
      anchor_role: failure.anchorRole,
      rejected_object_id: failure.objectId,
      rejection_reason: failure.reason
    });
    // invariant: D-EDGEAUDIT. The reject is durably audited above; ALSO surface
    // it to the operator-triage inbox (best-effort, after the audit committed).
    // target_object_id = the rejected anchor's backing object id (no path row
    // exists). A port throw must not break the mint flow.
    await this.recordPathFailureToInbox(workspaceId, failure.objectId);
  }

  private async recordPathFailureToInbox(workspaceId: string, targetObjectId: string): Promise<void> {
    const port = this.deps.healthInboxPort;
    if (port === undefined) {
      return;
    }
    try {
      await port.recordPathRelationFailure({
        workspaceId,
        targetObjectId,
        observedAt: this.now()
      });
    } catch (error) {
      // best-effort projection: never break the mint flow, but surface the swallow.
      this.warn("PathRelation health-inbox write failed", {
        workspace_id: workspaceId,
        target_object_id: targetObjectId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private warn(message: string, meta: Record<string, unknown>): void {
    if (this.deps.warn !== undefined) {
      this.deps.warn(message, meta);
    }
  }
}
