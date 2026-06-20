import { randomUUID } from "node:crypto";
import {
  getPathAnchorBackingObjectId,
  pathRelationMatchesIdentity,
  type PathAnchorRef} from "@do-soul/alaya-protocol";
import { EventPublisherPropagationError } from "../runtime/event-publisher.js";
import {
  CO_RECALLED_SEED_PROFILE,
  PATH_RELATION_COUNTER_DEFAULT_TTL_MS,
  PATH_RELATION_PROPOSE_THRESHOLD,
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
  AUTO_BUILD_GOVERNANCE_CEILING,
  COHERES_WITH_SEED_PROFILE,
  CO_RECALLED_SEED_PROFILE,
  CONTRADICTS_SEED_PROFILE,
  DERIVES_FROM_SEED_PROFILE,
  EXCEPTION_TO_SEED_PROFILE,
  INCOMPATIBLE_SEED_PROFILE,
  PATH_RELATION_COUNTER_DEFAULT_TTL_MS,
  PATH_RELATION_PROPOSE_THRESHOLD,
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
// PathRelation entities. It accepts seeding signals from many producers
// (co-usage, co-recall, LLM supports/derives, shared-entity, signal
// graph-ref) and mints a PathRelation through one shared materialize path.
// Each signal differs only in its seed profile (relation_kind / initial
// strength / governance_class / evidence_basis / recall_bias sign); the
// propose/materialize machinery is identical. invariant: counter-gated
// seeders (co-usage, co-recall) accrue to a threshold before minting;
// candidate-driven seeders (LLM/entity/signal via submitCandidate) mint
// once on submission. invariant: counter state is durable via
// CoUsageCounterPort; counts toward the threshold are persisted, not held
// in process memory.
// invariant: agents and producers only propose; Alaya decides durable
// recall topology. auto-build governance has a hard ceiling of
// recall_allowed — strictly_governed is reserved for user/operator action
// and submitCandidate clamps any caller that asks for it down to
// recall_allowed. A counter-seeded path is born at attention_only and
// reaches recall_allowed only by accruing support_events_count >= 8
// through the legitimate path-manifestation-policy ladder, which
// PathPlasticityService drives from anchor-matched usage receipts
// independently of this service's counters.
// invariant: positive and negative relation families share one plasticity
// model. The family is expressed only by the sign of effect_vector
// .recall_bias (supports +, contradicts/supersedes -). Negative families
// carry harder initial seed parameters (evidence_basis >= 1, higher
// initial strength, governance >= recall_allowed) but run the same
// decay/reinforcement/lifecycle dynamics — there is no second mechanism.
// invariant: counter rows carry updated_at timestamps so the daemon can
// periodically call evictExpired(now, ttlMs) to discard stale pairs that
// never reached the threshold. A pair that reaches the threshold has its
// counter row dropped once its PathRelation is written; durable
// double-propose protection comes from findByAnchorMemoryId against
// persisted PathRelations.
// invariant: row insert and `path.relation_created` EventLog row are
// emitted in one SQLite transaction via EventPublisher.appendManyWithMutation,
// matching the PathPlasticityService pattern. Crash-mid-write cannot leave
// a path_relations row without its audit event or vice versa.
// see also: crossLinkRecalledMemories — co-usage caller hook
// see also: PathPlasticityService — strength evolution
// see also: PathRelationRepo — durable write side
// see also: SqliteCoUsageCounterRepo — durable counter backing
// see also: spine-activation-design.md §E2 — seed-profile table source


export class PathRelationProposalService {
  private readonly counterStore: CoUsageCounterPort;
  private readonly threshold: number;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly counterTtlMs: number;
  private readonly generateId: () => string;

  public constructor(private readonly deps: PathRelationProposalServiceDeps) {
    this.counterStore = deps.counterStore;
    this.threshold = deps.threshold ?? PATH_RELATION_PROPOSE_THRESHOLD;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.counterTtlMs = deps.counterTtlMs ?? PATH_RELATION_COUNTER_DEFAULT_TTL_MS;
    this.generateId = deps.generateId ?? (() => randomUUID());
  }

  // Co-usage seeder: memories reported used together. Counter-gated; on
  // reaching the threshold it mints a co_recalled-family path. Co-usage and
  // co-recall share one counter space and one seed profile.
  public async onCoUsage(
    usedObjectIds: readonly string[],
    workspaceId: string
  ): Promise<void> {
    await this.accrueCoOccurrence(usedObjectIds, workspaceId);
  }

  // invariant: co-recall seeder. Counts a pair when delivered together in
  // one recall; does not require a used-report. This is the receiving API —
  // the recall-side hook that calls it is owned by the recall delivery path,
  // not this file. Shares one counter space and the co_recalled seed profile
  // with onCoUsage, so both signals reinforce one count toward the threshold.
  //
  // `allowedPairKeys`, when provided, restricts accrual to the listed
  // unordered pairs (canonical `${low}|${high}` keys, low/high = sorted
  // object_ids — the same ordering accrueCoOccurrence derives internally). The
  // recall delivery path computes this set from object-to-object semantic
  // endpoint coherence so only genuinely-related deliveries strengthen a path;
  // the embedding math stays on the recall/embedding side and never enters this
  // truth-boundary service. When undefined, every unordered pair accrues — the
  // unchanged behavior the bench-harness co-recall warmup and the unit tests
  // depend on.
  // see also: apps/core-daemon/src/mcp-memory/tool-handler.ts accrueCoRecallPlasticity (production caller)
  // see also: apps/core-daemon/src/index.ts CO_RECALL_COHERENCE_FLOOR (gate floor)
  public async onCoRecall(
    recalledObjectIds: readonly string[],
    workspaceId: string,
    allowedPairKeys?: ReadonlySet<string>
  ): Promise<void> {
    await this.accrueCoOccurrence(recalledObjectIds, workspaceId, allowedPairKeys);
  }

  // Generalized candidate intake. Non-counter producers submit a fully
  // differentiated candidate; it mints once (subject to durable dedup and
  // governance clamp). This is the stable signature Wave-2 edge folding
  // calls. Returns a discriminated PathMintOutcome: applied / already_present
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
        runId: input.runId ?? null
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
  // see also: packages/storage/src/repos/proposal/accept-workflows.ts acceptPendingPathRelationGovernanceWithEvents
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

  // Shared counter-gated accrual for co-usage and co-recall. Each unordered
  // pair increments the durable counter; on reaching the threshold it mints
  // a co_recalled-family path via the same materialize path submitCandidate
  // uses. When `allowedPairKeys` is provided, only the listed unordered pairs
  // accrue (semantic-coherence gate, computed on the recall/embedding side);
  // an undefined set keeps the all-pairs behavior every other caller relies on.
  private async accrueCoOccurrence(
    objectIds: readonly string[],
    workspaceId: string,
    allowedPairKeys?: ReadonlySet<string>
  ): Promise<void> {
    if (objectIds.length < 2) {
      return;
    }
    const unique = [...new Set(objectIds)].sort();
    const seenAt = this.now();
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const low = unique[i]!;
        const high = unique[j]!;
        // Coherence gate: skip any pair the caller did not mark as a
        // semantically-related endpoint. `low`/`high` are already sorted, so
        // the key matches the canonical `${low}|${high}` the caller built.
        if (allowedPairKeys !== undefined && !allowedPairKeys.has(`${low}|${high}`)) {
          continue;
        }
        const count = await this.counterStore.increment({
          workspaceId,
          lowMemoryId: low,
          highMemoryId: high,
          seenAt
        });
        if (count < this.threshold) {
          continue;
        }
        try {
          const proposed = await this.proposeCoRecalled(workspaceId, low, high);
          // applied / already_present / rejected all settle the pair: a
          // permanent rejection (bad anchor) can never mint, so keeping the
          // counter would re-query it on every future co-occurrence. Only a
          // transient "failed" leaves the counter so a later threshold hit
          // retries the mint.
          if (proposed !== "failed") {
            await this.counterStore.delete(workspaceId, low, high);
          }
        } catch (err) {
          this.warn("PathRelation propose failed", {
            workspace_id: workspaceId,
            source_object_id: low,
            target_object_id: high,
            error: errorMessage(err)
          });
        }
      }
    }
  }

  private async proposeCoRecalled(
    workspaceId: string,
    sourceMemoryId: string,
    targetMemoryId: string
  ): Promise<PathMintOutcome> {
    const profile = CO_RECALLED_SEED_PROFILE;
    return await this.materialize({
      workspaceId,
      sourceAnchor: { kind: "object", object_id: sourceMemoryId },
      targetAnchor: { kind: "object", object_id: targetMemoryId },
      relationKind: profile.relationKind,
      initialStrength: profile.initialStrength,
      governanceClass: clampGovernanceToAutoBuildCeiling(profile.governanceClass),
      evidenceBasis: profile.evidenceBasis,
      recallBias: profile.recallBiasSign * profile.recallBiasMagnitude,
      supportEventsCount: this.threshold,
      why: [`co-recalled-used >= ${this.threshold} times`],
      // Counter-gated co-recall accrues across many runs; no single run
      // owns the mint, so attribution stays null.
      runId: null
    });
  }

  // Single materialize path for every seeder. Differentiated parameters
  // arrive resolved (governance already clamped, recall_bias already
  // signed). Durable dedup + event-first transactional write live here.
  private async materialize(params: MaterializePathRelationInput): Promise<PathMintOutcome> {
    const sourceId = getPathAnchorBackingObjectId(params.sourceAnchor);
    if (this.deps.repo.findByAnchorMemoryId !== undefined) {
      const existing = await this.deps.repo.findByAnchorMemoryId(sourceId, params.workspaceId);
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
    } catch {
      // best-effort projection: never break the mint flow on an inbox write.
    }
  }

  private warn(message: string, meta: Record<string, unknown>): void {
    if (this.deps.warn !== undefined) {
      this.deps.warn(message, meta);
    }
  }
}
