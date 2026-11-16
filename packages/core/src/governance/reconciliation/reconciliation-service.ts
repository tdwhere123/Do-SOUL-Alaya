import { randomUUID } from "node:crypto";

import {
  SignalEventType,
  SoulSignalTriagedPayloadSchema,
  type MemoryEntry
} from "@do-soul/alaya-protocol";

import { KeyedMutex } from "@do-soul/alaya-protocol";
import { assertGovernanceRunWorkspace, type GovernanceRunWorkspaceLookup } from "../policy/run-workspace-guard.js";
import {
  ReconciliationDecider,
  type PreparedReconciliation
} from "./reconciliation-decider.js";
import {
  addDecision,
  deferredDecision,
  auditDroppedContent,
  errorMessage,
  DEFAULT_CONFLICT_TAG_OVERLAP_THRESHOLD,
  DEFAULT_MAX_LLM_CANDIDATES,
  DEFAULT_SIMILARITY_FLOOR,
  RECONCILE_LEASE_TTL_MS,
  type ReconciliationDecision,
  type ReconciliationEventLogPort,
  type ReconciliationInput,
  type ReconciliationLeasePort,
  type ReconciliationMemoryRepoPort,
  type ReconciliationMemoryProjectionFields,
  type ReconciliationMemoryUpdatePort,
  type ReconciliationRewriteAuthorizationPort,
  type ReconciliationServiceDependencies,
  type ReconciliationVerdictApplier
} from "./reconciliation-service-internal.js";
import {
  buildProjectionMergeFields,
  buildUpdateFields,
  updateFieldsMatch,
  type ReconciliationMemoryUpdateFields
} from "./reconciliation-memory-fields.js";

export {
  compareCandidateContent,
  AUDIT_DROPPED_CONTENT_MAX_CHARS,
  RECONCILE_LEASE_TTL_MS,
  createRuleOnlyReconciliationDecisionPort,
  deferredDecision
} from "./reconciliation-service-internal.js";

export type {
  ReconciliationDecision,
  ReconciliationDecisionKind,
  ReconciliationDeferral,
  ReconciliationEventLogPort,
  ReconciliationInput,
  ReconciliationKeywordSearchPort,
  ReconciliationLeasePort,
  ReconciliationLlmDecisionPort,
  ReconciliationMemoryRepoPort,
  ReconciliationMemoryProjectionFields,
  ReconciliationMemoryUpdatePort,
  ReconciliationRewriteAuthorizationPort,
  ReconciliationServiceDependencies,
  ReconciliationServiceThresholds,
  ReconciliationVerdictApplier
} from "./reconciliation-service-internal.js";
export {
  PreWriteRecallService
} from "./pre-write-recall-service.js";
export type {
  PreWriteCandidateFamily,
  PreWriteCandidateNeighbor,
  PreWriteRecallPort,
  PreWriteRecallResult,
  PreWriteRelationKind,
  PreWriteRelationPosterior
} from "./pre-write-recall-service.js";

export class ReconciliationService {
  private readonly mutex: KeyedMutex;
  private readonly lease?: ReconciliationLeasePort;
  private readonly leaseTtlMs: number;
  private readonly now: () => Date;
  private readonly decider: ReconciliationDecider;
  private readonly memoryRepo: ReconciliationMemoryRepoPort;
  private readonly memoryUpdate: ReconciliationMemoryUpdatePort;
  private readonly eventLog: ReconciliationEventLogPort;
  private readonly runLookup: GovernanceRunWorkspaceLookup;
  private readonly rewriteAuthorization?: ReconciliationRewriteAuthorizationPort;
  private readonly warnFn?: (message: string, meta: Record<string, unknown>) => void;

  public constructor(deps: ReconciliationServiceDependencies) {
    const thresholds = deps.thresholds ?? {};
    const similarityFloor = thresholds.similarityFloor ?? DEFAULT_SIMILARITY_FLOOR;
    const conflictTagOverlapThreshold =
      thresholds.conflictTagOverlapThreshold ?? DEFAULT_CONFLICT_TAG_OVERLAP_THRESHOLD;
    const maxLlmCandidates = thresholds.maxLlmCandidates ?? DEFAULT_MAX_LLM_CANDIDATES;
    this.mutex = deps.mutex ?? new KeyedMutex();
    this.lease = deps.lease;
    this.leaseTtlMs = deps.leaseTtlMs ?? RECONCILE_LEASE_TTL_MS;
    this.now = deps.now ?? (() => new Date());
    this.memoryRepo = deps.memoryRepo;
    this.memoryUpdate = deps.memoryUpdate;
    this.eventLog = deps.eventLog;
    this.runLookup = deps.runLookup;
    this.rewriteAuthorization = deps.rewriteAuthorization;
    this.warnFn = deps.warn;
    this.decider = new ReconciliationDecider({
      preWriteRecall: deps.preWriteRecall,
      llmDecision: deps.llmDecision,
      similarityFloor,
      conflictTagOverlapThreshold,
      maxLlmCandidates,
      warn: (message, meta) => this.warn(message, meta)
    });
  }

  public async runWithDecision(input: ReconciliationInput, applyVerdict: ReconciliationVerdictApplier): Promise<ReconciliationDecision> {
    const prepared = await this.withWorkspaceExclusion(
      input,
      async () => {
        const next = await this.decider.prepare(input);
        if (next.kind === "ready") {
          await this.applyDecision(input, next.decision, applyVerdict);
        }
        return next;
      },
      async () => ({
        kind: "ready" as const,
        decision: this.leaseBusyDecision(input)
      })
    );
    if (prepared.kind === "ready") {
      return prepared.decision;
    }

    // Model RTT must not hold mutex/lease; a second ingest would stall for the round trip.
    const nominated = await this.decider.finishWithLlm(input, prepared);
    return await this.withWorkspaceExclusion(
      input,
      async () => {
        const decision = await this.casLlmTarget(input.workspaceId, prepared, nominated);
        return await this.applyDecision(input, decision, applyVerdict);
      },
      async () => this.leaseBusyDecision(input)
    );
  }

  private async withWorkspaceExclusion<T>(
    input: ReconciliationInput,
    section: () => Promise<T>,
    onLeaseBusy: () => Promise<T>
  ): Promise<T> {
    return await this.mutex.runExclusive(input.workspaceId, async () => {
      await assertGovernanceRunWorkspace(this.runLookup, input.runId, input.workspaceId);
      if (this.lease === undefined) {
        return await section();
      }
      const ownerToken = randomUUID();
      const nowDate = this.now();
      const acquired = this.lease.tryAcquire(
        input.workspaceId,
        ownerToken,
        nowDate.toISOString(),
        new Date(nowDate.getTime() + this.leaseTtlMs).toISOString()
      );
      if (acquired === null) {
        return await onLeaseBusy();
      }
      try {
        return await section();
      } finally {
        try {
          this.lease.release(input.workspaceId, ownerToken);
        } catch (error) {
          // A failed release is not fatal: the TTL reclaims the lease.
          this.warn("reconciliation lease release failed", {
            workspace_id: input.workspaceId,
            error: errorMessage(error)
          });
        }
      }
    });
  }

  private leaseBusyDecision(input: ReconciliationInput): ReconciliationDecision {
    this.warn("reconciliation lease busy — not adding", {
      workspace_id: input.workspaceId,
      signal_id: input.signalId
    });
    return deferredDecision(
      "lease_busy",
      "reconciliation lease held by another process — not added"
    );
  }

  private async casLlmTarget(
    workspaceId: string,
    prepared: Extract<PreparedReconciliation, { kind: "needs_llm" }>,
    decision: ReconciliationDecision
  ): Promise<ReconciliationDecision> {
    if (decision.kind === "add" || decision.survivingObjectId === undefined) {
      return decision;
    }
    const snapshot = prepared.snapshots.find((item) => item.objectId === decision.survivingObjectId);
    if (snapshot === undefined) {
      return addDecision(
        decision.bestSimilarity,
        true,
        "LLM target missing from snapshot — added with conflict scan"
      );
    }
    const current = await this.findUpdateTarget(workspaceId, decision.survivingObjectId);
    if (current === null) {
      return addDecision(
        decision.bestSimilarity,
        true,
        "LLM target missing or archived after round trip — added with conflict scan"
      );
    }
    if (current.updated_at !== snapshot.updatedAt || current.content !== snapshot.content) {
      return addDecision(
        decision.bestSimilarity,
        true,
        "LLM target changed during round trip — added with conflict scan"
      );
    }
    return decision;
  }

  private async applyDecision(
    input: ReconciliationInput,
    decision: ReconciliationDecision,
    applyVerdict: ReconciliationVerdictApplier
  ): Promise<ReconciliationDecision> {
    if (decision.kind === "deferred") {
      return decision;
    }
    if (decision.kind === "update" && decision.survivingObjectId !== undefined) {
      return await this.applyUpdateDecision(
        input,
        decision,
        decision.survivingObjectId,
        applyVerdict
      );
    }

    if (decision.kind === "noop" && decision.survivingObjectId !== undefined) {
      // NOOP creates nothing, but the verdict still feeds the bench sidecar remap.
      await applyVerdict(decision);
      await this.applyNoopProjectionMerge(
        input.workspaceId,
        decision.survivingObjectId,
        input.incomingProjectionFields
      );
      await this.auditDrop(input, decision.survivingObjectId, decision.bestSimilarity);
      return decision;
    }

    // ADD (or an update/noop with no target): router creates the row under the lock.
    await applyVerdict(decision);
    return decision;
  }

  private async applyUpdateDecision(
    input: ReconciliationInput,
    decision: ReconciliationDecision,
    targetObjectId: string,
    applyVerdict: ReconciliationVerdictApplier
  ): Promise<ReconciliationDecision> {
    if (!(await this.durableRewriteAuthorized(input.workspaceId, targetObjectId))) {
      return await this.demoteUpdateToCandidate(input, decision, applyVerdict);
    }
    const { incomingEvidenceRef } = await applyVerdict(decision);
    const applied = await this.applyUpdate(
      input.workspaceId,
      targetObjectId,
      input.incomingContent.trim(),
      input.incomingDomainTags,
      incomingEvidenceRef,
      input.incomingProjectionFields
    );
    if (applied) {
      return decision;
    }
    const degraded = addDecision(
      decision.bestSimilarity,
      true,
      "LLM UPDATE could not be applied — added with conflict scan"
    );
    await applyVerdict(degraded);
    return degraded;
  }

  private async demoteUpdateToCandidate(
    input: ReconciliationInput,
    decision: ReconciliationDecision,
    applyVerdict: ReconciliationVerdictApplier
  ): Promise<ReconciliationDecision> {
    this.warn("reconciliation LLM UPDATE demoted to candidate — model output cannot mutate truth", {
      workspace_id: input.workspaceId,
      signal_id: input.signalId,
      target_object_id: decision.survivingObjectId ?? null,
      nominated_reason: decision.reason
    });
    const demoted = addDecision(
      decision.bestSimilarity,
      true,
      "LLM UPDATE demoted to candidate — model output cannot mutate truth"
    );
    await applyVerdict(demoted);
    return demoted;
  }

  private async durableRewriteAuthorized(
    workspaceId: string,
    targetObjectId: string
  ): Promise<boolean> {
    if (this.rewriteAuthorization === undefined) {
      return false;
    }
    try {
      return await this.rewriteAuthorization.allowsDurableRewrite({
        workspaceId,
        targetObjectId
      });
    } catch (error) {
      this.warn("reconciliation rewrite authorization failed — refusing durable rewrite", {
        workspace_id: workspaceId,
        object_id: targetObjectId,
        error: errorMessage(error)
      });
      return false;
    }
  }

  private async applyUpdate(
    workspaceId: string,
    targetObjectId: string,
    incomingContent: string,
    incomingDomainTags: readonly string[],
    incomingEvidenceRef: string | undefined,
    incomingProjectionFields: ReconciliationMemoryProjectionFields | undefined
  ): Promise<boolean> {
    const existing = await this.findUpdateTarget(workspaceId, targetObjectId);
    if (existing === null) {
      return false;
    }
    const fields = buildUpdateFields(
      existing,
      incomingContent,
      incomingDomainTags,
      incomingEvidenceRef,
      incomingProjectionFields
    );

    try {
      await this.memoryUpdate.update(
        targetObjectId,
        fields,
        "reconciliation_refine"
      );
      return true;
    } catch (error) {
      this.warn("reconciliation update failed", {
        object_id: targetObjectId,
        error: errorMessage(error)
      });
      return await this.updateAppearsApplied(workspaceId, targetObjectId, fields);
    }
  }

  private async updateAppearsApplied(
    workspaceId: string,
    targetObjectId: string,
    fields: ReconciliationMemoryUpdateFields
  ): Promise<boolean> {
    const row = await this.findUpdateTarget(workspaceId, targetObjectId);
    return row !== null && updateFieldsMatch(row, fields);
  }

  private async findUpdateTarget(
    workspaceId: string,
    targetObjectId: string
  ): Promise<Readonly<MemoryEntry> | null> {
    try {
      const existing = await this.memoryRepo.findByIds(workspaceId, [targetObjectId]);
      const row = existing[0];
      if (row === undefined || row.lifecycle_state === "archived") {
        this.warn("reconciliation update target missing or archived", {
          object_id: targetObjectId
        });
        return null;
      }
      return row;
    } catch (error) {
      this.warn("reconciliation update target lookup failed", {
        object_id: targetObjectId,
        error: errorMessage(error)
      });
      throw error;
    }
  }

  private async applyNoopProjectionMerge(
    workspaceId: string,
    targetObjectId: string,
    incomingProjectionFields: ReconciliationMemoryProjectionFields | undefined
  ): Promise<void> {
    try {
      const existing = await this.memoryRepo.findByIds(workspaceId, [targetObjectId]);
      const row = existing[0];
      if (row === undefined || row.lifecycle_state === "archived") {
        return;
      }
      const fields = buildProjectionMergeFields(row, incomingProjectionFields);
      if (Object.keys(fields).length === 0) {
        return;
      }
      await this.memoryUpdate.update(targetObjectId, fields, "reconciliation_projection_merge");
    } catch (error) {
      this.warn("reconciliation NOOP projection merge failed", {
        object_id: targetObjectId,
        error: errorMessage(error)
      });
    }
  }

  private async auditDrop(input: ReconciliationInput, survivingObjectId: string, similarity: number): Promise<void> {
    try {
      await this.eventLog.append({
        event_type: SignalEventType.SOUL_SIGNAL_TRIAGED,
        entity_type: "candidate_memory_signal",
        entity_id: `${input.signalId}:noop_audit`,
        workspace_id: input.workspaceId,
        run_id: input.runId,
        caused_by: "reconciliation_noop",
        payload_json: SoulSignalTriagedPayloadSchema.parse({
          signal_id: input.signalId,
          workspace_id: input.workspaceId,
          run_id: input.runId,
          triage_result: "dropped",
          dropped_content: auditDroppedContent(input.incomingContent),
          surviving_object_id: survivingObjectId,
          best_similarity: Number(similarity.toFixed(3))
        })
      });
    } catch (error) {
      this.warn("reconciliation NOOP audit append failed", {
        signal_id: input.signalId,
        error: errorMessage(error)
      });
    }
  }

  private warn(message: string, meta: Record<string, unknown>): void {
    this.warnFn?.(message, meta);
  }
}
