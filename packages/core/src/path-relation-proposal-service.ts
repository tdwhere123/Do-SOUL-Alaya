import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  getPathAnchorBackingObjectId,
  pathRelationMatchesIdentity,
  PathRelationSchema,
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type EventLogEntry,
  type PathAnchorRef,
  type PathGovernanceClass,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { EventPublisherPropagationError, type EventPublisher, type EventPublisherInput } from "./event-publisher.js";

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

export const PATH_RELATION_PROPOSE_THRESHOLD =
  DYNAMICS_CONSTANTS.path_plasticity.co_usage_threshold;
export const PATH_RELATION_COUNTER_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// Seed-profile catalog. Each named seeder maps to the differentiated
// initial parameters from spine-activation-design.md §E2. submitCandidate
// callers may pass an explicit profile, or reference one of these by
// passing the matching fields. The recall_bias sign decides family:
// positive = associative (supports recall), negative = lifecycle
// (suppresses recall but never drops graph_support below baseline),
// zero = neutral marker (exception_to) that records topology without
// biasing recall in either direction.
//
// see also: spine-activation-design.md §E2 — authoritative seeding table
// anti-patterns-lint-allow: forward intake catalog for Wave-2 edge folding;
// exported as the stable producer contract before its callers exist.
export interface PathSeedProfile {
  readonly relationKind: string;
  readonly initialStrength: number;
  readonly governanceClass: PathGovernanceClass;
  readonly recallBiasSign: 1 | 0 | -1;
  readonly recallBiasMagnitude: number;
  readonly evidenceBasis: readonly string[];
}

// Positive associative families. recall_bias positive; born below the
// recall-eligible band (auto-build ceiling honored downstream).
export const CO_RECALLED_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "co_recalled",
  initialStrength: 0.3,
  governanceClass: "attention_only",
  recallBiasSign: 1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["recalls_edge_co_usage"]) as readonly string[]
});

export const SUPPORTS_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "supports",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: 1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["llm_supports_inference"]) as readonly string[]
});

export const DERIVES_FROM_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "derives_from",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: 1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["llm_derives_inference"]) as readonly string[]
});

export const SHARES_ENTITY_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "shares_entity",
  initialStrength: 0.2,
  governanceClass: "hint_only",
  recallBiasSign: 1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["shared_entity_overlap"]) as readonly string[]
});

export const SIGNAL_GRAPH_REF_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "signal_graph_ref",
  initialStrength: 0.6,
  governanceClass: "recall_allowed",
  recallBiasSign: 1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["signal_graph_reference"]) as readonly string[]
});

// Neutral marker family. recall_bias is exactly 0: exception_to records a
// scoped-exception edge in the topology without biasing recall up or down.
// Carries evidence_basis >= 1 and governance recall_allowed like the
// negative families, and runs the same unified plasticity model.
// see also: memory-graph.ts exception_to (contribution_weight 0) — the
// edge-type whose recall-neutral semantics this profile mirrors.
export const EXCEPTION_TO_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "exception_to",
  initialStrength: 0.9,
  governanceClass: "recall_allowed",
  recallBiasSign: 0,
  recallBiasMagnitude: 0,
  evidenceBasis: Object.freeze(["exception_evidence"]) as readonly string[]
});

// Negative lifecycle families. Harder seed: evidence_basis >= 1, initial
// strength 0.9, governance >= recall_allowed, recall_bias negative. These
// still run the unified plasticity model — only the seed differs.
export const SUPERSEDES_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "supersedes",
  initialStrength: 0.9,
  governanceClass: "recall_allowed",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["supersession_evidence"]) as readonly string[]
});

export const CONTRADICTS_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "contradicts",
  initialStrength: 0.9,
  governanceClass: "recall_allowed",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.4,
  evidenceBasis: Object.freeze(["contradiction_evidence"]) as readonly string[]
});

export const INCOMPATIBLE_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "incompatible_with",
  initialStrength: 0.9,
  governanceClass: "recall_allowed",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.3,
  evidenceBasis: Object.freeze(["incompatibility_evidence"]) as readonly string[]
});

// invariant: discriminated mint outcome. submitCandidate (and the shared
// materialize path) report one of four decided results so a no-drop
// consumer can tell a DECIDED "no" apart from a TRANSIENT failure:
//   - "applied": a fresh PathRelation row + audit event were written.
//   - "already_present": durable dedup found the pair already linked; no
//     write, but the owed path exists, so nothing is owed.
//   - "rejected": a permanent refusal (object anchor missing / owned by a
//     foreign workspace). A path.relation_rejected audit event is emitted;
//     retrying with the same anchors can never succeed.
//   - "failed": a transient error (repo throw, event-publisher throw). The
//     owed path is NOT written; a retry MAY succeed, so a no-drop consumer
//     must keep the work pending instead of marking it processed.
// invariant: only "failed" is retry-worthy. applied / already_present are
// successes; rejected is a decided no that retry cannot fix. A consumer
// that retries a "rejected" candidate creates an infinite poison loop, so
// it MUST treat rejected as terminal (no retry) — distinct from "failed".
// see also: edge-auto-producer-service.ts / conflict-detection-service.ts —
//   no-drop consumers; garden-runtime.ts BULK_ENRICH worker — claim release.
export type PathMintOutcome = "applied" | "already_present" | "rejected" | "failed";

// invariant: auto-build governance hard ceiling. No producer-driven seed
// may be born at strictly_governed; that band is reserved for explicit
// user/operator governance. submitCandidate clamps requests down to this
// ceiling rather than rejecting, so a mis-tuned producer cannot silently
// gain a higher band than it is entitled to.
export const AUTO_BUILD_GOVERNANCE_CEILING: PathGovernanceClass = "recall_allowed";

const GOVERNANCE_RANK: Readonly<Record<PathGovernanceClass, number>> = Object.freeze({
  hint_only: 0,
  attention_only: 1,
  recall_allowed: 2,
  strictly_governed: 3
});

function clampGovernanceToAutoBuildCeiling(
  requested: PathGovernanceClass
): PathGovernanceClass {
  return GOVERNANCE_RANK[requested] > GOVERNANCE_RANK[AUTO_BUILD_GOVERNANCE_CEILING]
    ? AUTO_BUILD_GOVERNANCE_CEILING
    : requested;
}

export interface PathRelationProposalRepoPort {
  create(relation: PathRelation): Readonly<PathRelation>;
  findByAnchorMemoryId?(
    memoryId: string,
    workspaceId: string
  ): Promise<readonly Readonly<PathRelation>[]>;
}

// invariant: durable counter backing. The daemon wires this to the SQLite
// co-usage counter repo; tests may supply an in-memory fake. Memory ids are
// already ordered low <= high by the service before reaching this port.
// Co-usage and co-recall share this counter space: a pair that is recalled
// together and used together is the same relation, so both signals
// reinforce one count toward the same threshold.
export interface CoUsageCounterPort {
  increment(input: {
    readonly workspaceId: string;
    readonly lowMemoryId: string;
    readonly highMemoryId: string;
    readonly seenAt: string;
  }): number | Promise<number>;
  delete(workspaceId: string, lowMemoryId: string, highMemoryId: string): void | Promise<void>;
  evictExpired(cutoff: string): number | Promise<number>;
  size(): number | Promise<number>;
}

export type PathRelationProposalEventPublisherPort = Pick<
  EventPublisher,
  "appendManyWithMutation"
>;

// invariant: object-anchor existence + ownership gate. A path object anchor
// names a durable memory entry by object id; this port answers "does this
// object id exist, and in which workspace" so the mint sink can refuse a
// candidate whose source/target memory is missing or owned by another
// workspace. This is the single referential check the durable graph plane
// has — path_relations carries memory ids inside anchors_json with no SQL FK,
// so without this gate an untrusted agent/Garden ref would become durable
// governed topology pointing at a non-existent or foreign object.
// Returns null when the object id is unknown; otherwise the owning workspace.
// see also: SqliteMemoryEntryRepo.findById — daemon wiring of this port.
export interface MemoryAnchorExistencePort {
  workspaceOfObject(objectId: string): Promise<string | null>;
}

type AnchorValidationFailure = {
  readonly anchorRole: "source" | "target";
  readonly objectId: string;
  readonly reason: "object_missing" | "object_foreign_workspace";
};

export interface PathRelationProposalServiceDeps {
  readonly repo: PathRelationProposalRepoPort;
  readonly counterStore: CoUsageCounterPort;
  readonly eventPublisher: PathRelationProposalEventPublisherPort;
  // invariant: when wired (the daemon always wires it), object-anchor mints are
  // gated before EventLog append + DB insert. Left undefined only in unit
  // tests that exercise the seed/dedup machinery in isolation; the daemon
  // composition MUST supply it so the MCP and Garden mint paths are covered.
  readonly memoryExistence?: MemoryAnchorExistencePort;
  readonly threshold?: number;
  readonly now?: () => string;
  readonly nowMs?: () => number;
  readonly counterTtlMs?: number;
  readonly generateId?: () => string;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

// Stable intake contract for non-counter producers (Wave-2 edge folding,
// future entity/signal seeders). source/target anchors are PathAnchorRef so
// object_facet / obligation / risk_concern / time_concern anchors are
// expressible, not just plain object pairs. recallBiasSign decides family
// (positive associative / negative lifecycle / 0 neutral marker such as
// exception_to); governanceClass is clamped to the auto-build ceiling. why
// is optional provenance appended to constitution.why_this_relation_exists.
//
// see also: spine-activation-design.md §E2 — seed-profile table
export interface SubmitCandidateInput {
  readonly workspaceId: string;
  readonly sourceAnchor: PathAnchorRef;
  readonly targetAnchor: PathAnchorRef;
  readonly relationKind: string;
  readonly initialStrength: number;
  readonly governanceClass: PathGovernanceClass;
  readonly evidenceBasis: readonly string[];
  readonly recallBiasSign: 1 | 0 | -1;
  readonly recallBiasMagnitude?: number;
  readonly why?: readonly string[];
  // Run attribution for the PATH_RELATION_CREATED audit row. Producers
  // that hold a run id (auto-producer, signal-ref router, conflict
  // detection) pass it so a minted path is programmatically traceable to
  // its triggering run; counter-gated co-recall has none and leaves it null.
  readonly runId?: string | null;
}

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
  // see also: recall-service co-recall delivery hook (caller, owned elsewhere)
  public async onCoRecall(
    recalledObjectIds: readonly string[],
    workspaceId: string
  ): Promise<void> {
    await this.accrueCoOccurrence(recalledObjectIds, workspaceId);
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
      // see also: event-publisher.ts appendManyWithMutation (commit-then-propagate),
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

  // invariant: the SAME object-anchor existence + ownership gate the mint sink
  // runs (validateObjectAnchors), exposed for the second durable path-insert
  // route — the proposal accept-apply path mints a stored proposed_path_relation
  // through the storage transaction, which cannot import this service. The
  // workflow calls this before that insert so an object anchor naming a missing
  // or foreign memory is refused with the same path.relation_rejected audit,
  // and no durable path lands. Returns "accepted" when both anchors pass (or
  // are non-object / the existence port is unwired) and "rejected" — after
  // emitting the audit — on the first failure. This is decided, never transient:
  // a rejected accept-apply must NOT retry.
  // see also: apps/core-daemon/src/mcp-memory-proposal-workflow.ts accept path
  // see also: packages/storage/src/repos/proposal-repo.ts acceptPendingPathRelationGovernanceWithEvents
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
  // uses.
  private async accrueCoOccurrence(
    objectIds: readonly string[],
    workspaceId: string
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
  private async materialize(params: {
    readonly workspaceId: string;
    readonly sourceAnchor: PathAnchorRef;
    readonly targetAnchor: PathAnchorRef;
    readonly relationKind: string;
    readonly initialStrength: number;
    readonly governanceClass: PathGovernanceClass;
    readonly evidenceBasis: readonly string[];
    readonly recallBias: number;
    readonly supportEventsCount: number;
    readonly why: readonly string[];
    readonly runId: string | null;
  }): Promise<PathMintOutcome> {
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
    const relation: PathRelation = PathRelationSchema.parse({
      path_id: this.generateId(),
      workspace_id: params.workspaceId,
      anchors: {
        source_anchor: params.sourceAnchor,
        target_anchor: params.targetAnchor
      },
      constitution: {
        relation_kind: params.relationKind,
        why_this_relation_exists: params.why
      },
      effect_vector: {
        salience: 0.5,
        recall_bias: params.recallBias,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "lens_entry"
      },
      plasticity_state: {
        strength: params.initialStrength,
        direction_bias: "bidirectional_asymmetric",
        stability_class: "stable",
        support_events_count: params.supportEventsCount,
        contradiction_events_count: 0
      },
      lifecycle: {
        status: "active",
        retirement_rule: "manual"
      },
      legitimacy: {
        evidence_basis: params.evidenceBasis,
        // see also: path-manifestation-policy.ts GOVERNANCE_PROMOTION_THRESHOLDS
        governance_class: params.governanceClass
      },
      created_at: occurredAt,
      updated_at: occurredAt
    });

    const payload = parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_CREATED,
      {
        path_id: relation.path_id,
        workspace_id: relation.workspace_id,
        relation_kind: relation.constitution.relation_kind,
        source_anchor_kind: relation.anchors.source_anchor.kind,
        target_anchor_kind: relation.anchors.target_anchor.kind,
        initial_strength: relation.plasticity_state.strength,
        governance_class: relation.legitimacy.governance_class,
        created_at: relation.created_at
      }
    );

    const eventInput: EventPublisherInput = {
      event_type: RuntimeGovernanceEventType.PATH_RELATION_CREATED,
      entity_type: "path_relation",
      entity_id: relation.path_id,
      workspace_id: relation.workspace_id,
      run_id: params.runId,
      caused_by: "system",
      payload_json: payload as unknown as Record<string, unknown>
    };

    await this.deps.eventPublisher.appendManyWithMutation(
      [eventInput],
      (_entries: readonly EventLogEntry[]) => {
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
    const payload = parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_REJECTED,
      {
        workspace_id: workspaceId,
        relation_kind: relationKind,
        anchor_role: failure.anchorRole,
        rejected_object_id: failure.objectId,
        rejection_reason: failure.reason,
        rejected_at: this.now()
      }
    );
    const eventInput: EventPublisherInput = {
      event_type: RuntimeGovernanceEventType.PATH_RELATION_REJECTED,
      entity_type: "path_relation",
      // No path row exists; the rejection is scoped to the workspace whose
      // durable topology was protected from the bad anchor.
      entity_id: workspaceId,
      workspace_id: workspaceId,
      run_id: null,
      caused_by: "system",
      payload_json: payload as unknown as Record<string, unknown>
    };
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
  }

  private warn(message: string, meta: Record<string, unknown>): void {
    if (this.deps.warn !== undefined) {
      this.deps.warn(message, meta);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
