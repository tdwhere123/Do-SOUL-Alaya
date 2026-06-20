import { randomUUID } from "node:crypto";

import { SignalEventType, SoulSignalTriagedPayloadSchema } from "@do-soul/alaya-protocol";

import { KeyedMutex } from "../shared/keyed-mutex.js";
import { ReconciliationDecider } from "./reconciliation-decider.js";
import {
  addDecision,
  encodeAuditContent,
  errorMessage,
  DEFAULT_CONFLICT_TAG_OVERLAP_THRESHOLD,
  DEFAULT_MAX_LLM_CANDIDATES,
  DEFAULT_SIMILARITY_FLOOR,
  DEFAULT_TOP_K,
  RECONCILE_LEASE_TTL_MS,
  type ReconciliationDecision,
  type ReconciliationEventLogPort,
  type ReconciliationInput,
  type ReconciliationLeasePort,
  type ReconciliationMemoryRepoPort,
  type ReconciliationMemoryUpdatePort,
  type ReconciliationServiceDependencies,
  type ReconciliationVerdictApplier
} from "./reconciliation-service-internal.js";

export {
  AUDIT_DROPPED_CONTENT_MAX_CHARS,
  RECONCILE_LEASE_TTL_MS,
  createRuleOnlyReconciliationDecisionPort
} from "./reconciliation-service-internal.js";

export type {
  ReconciliationDecision,
  ReconciliationDecisionKind,
  ReconciliationEventLogPort,
  ReconciliationInput,
  ReconciliationKeywordSearchPort,
  ReconciliationLeasePort,
  ReconciliationLlmDecisionPort,
  ReconciliationMemoryRepoPort,
  ReconciliationMemoryUpdatePort,
  ReconciliationServiceDependencies,
  ReconciliationServiceThresholds,
  ReconciliationVerdictApplier
} from "./reconciliation-service-internal.js";

export class ReconciliationService {
  private readonly mutex: KeyedMutex;
  private readonly lease?: ReconciliationLeasePort;
  private readonly leaseTtlMs: number;
  private readonly now: () => Date;
  private readonly decider: ReconciliationDecider;
  private readonly memoryRepo: ReconciliationMemoryRepoPort;
  private readonly memoryUpdate: ReconciliationMemoryUpdatePort;
  private readonly eventLog: ReconciliationEventLogPort;
  private readonly warnFn?: (message: string, meta: Record<string, unknown>) => void;

  public constructor(deps: ReconciliationServiceDependencies) {
    const thresholds = deps.thresholds ?? {};
    const similarityFloor = thresholds.similarityFloor ?? DEFAULT_SIMILARITY_FLOOR;
    const conflictTagOverlapThreshold =
      thresholds.conflictTagOverlapThreshold ?? DEFAULT_CONFLICT_TAG_OVERLAP_THRESHOLD;
    const topK = thresholds.topK ?? DEFAULT_TOP_K;
    const maxLlmCandidates = thresholds.maxLlmCandidates ?? DEFAULT_MAX_LLM_CANDIDATES;
    this.mutex = deps.mutex ?? new KeyedMutex();
    this.lease = deps.lease;
    this.leaseTtlMs = deps.leaseTtlMs ?? RECONCILE_LEASE_TTL_MS;
    this.now = deps.now ?? (() => new Date());
    this.memoryRepo = deps.memoryRepo;
    this.memoryUpdate = deps.memoryUpdate;
    this.eventLog = deps.eventLog;
    this.warnFn = deps.warn;
    this.decider = new ReconciliationDecider({
      keywordSearch: deps.keywordSearch,
      memoryRepo: deps.memoryRepo,
      llmDecision: deps.llmDecision,
      similarityFloor,
      conflictTagOverlapThreshold,
      topK,
      maxLlmCandidates,
      warn: (message, meta) => this.warn(message, meta)
    });
  }

  public async runWithDecision(input: ReconciliationInput, applyVerdict: ReconciliationVerdictApplier): Promise<ReconciliationDecision> {
    return await this.mutex.runExclusive(input.workspaceId, async () => {
      if (this.lease === undefined) {
        return await this.runDecisionSection(input, applyVerdict);
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
        // another process holds this workspace's reconcile — degrade, don't block.
        this.warn("reconciliation lease busy — degrading to ADD", {
          workspace_id: input.workspaceId,
          signal_id: input.signalId
        });
        const degraded = addDecision(
          0,
          true,
          "reconciliation lease held by another process — added with conflict scan"
        );
        await applyVerdict(degraded);
        return degraded;
      }
      try {
        return await this.runDecisionSection(input, applyVerdict);
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

  private async runDecisionSection(input: ReconciliationInput, applyVerdict: ReconciliationVerdictApplier): Promise<ReconciliationDecision> {
    const decision = await this.decider.decide(input);

    if (decision.kind === "update" && decision.survivingObjectId !== undefined) {
      // router creates the evidence_capsule, then the in-place rewrite runs under the lock.
      const { incomingEvidenceRef } = await applyVerdict(decision);
      const applied = await this.applyUpdate(
        decision.survivingObjectId,
        input.incomingContent.trim(),
        input.incomingDomainTags,
        incomingEvidenceRef
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

    if (decision.kind === "noop" && decision.survivingObjectId !== undefined) {
      // NOOP creates nothing, but the verdict still feeds the bench sidecar remap.
      await applyVerdict(decision);
      await this.auditDrop(input, decision.survivingObjectId, decision.bestSimilarity);
      return decision;
    }

    // ADD (or an update/noop with no target): router creates the row under the lock.
    await applyVerdict(decision);
    return decision;
  }

  private async applyUpdate(targetObjectId: string, incomingContent: string, incomingDomainTags: readonly string[], incomingEvidenceRef: string | undefined): Promise<boolean> {
    try {
      const existing = await this.memoryRepo.findByIds([targetObjectId]);
      const row = existing[0];
      if (row === undefined || row.lifecycle_state === "archived") {
        this.warn("reconciliation update target missing or archived", {
          object_id: targetObjectId
        });
        return false;
      }
      const fields: {
        content: string;
        domain_tags: readonly string[];
        evidence_refs?: readonly string[];
      } = {
        content: incomingContent,
        // mirror buildMemoryInput so the refined row's tags track its content.
        // see also: packages/soul/src/garden/materialization-router/inputs.ts
        domain_tags: incomingDomainTags
      };
      if (incomingEvidenceRef !== undefined && incomingEvidenceRef.trim().length > 0) {
        fields.evidence_refs = row.evidence_refs.includes(incomingEvidenceRef)
          ? row.evidence_refs
          : [...row.evidence_refs, incomingEvidenceRef];
      }
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
      return false;
    }
  }

  private async auditDrop(input: ReconciliationInput, survivingObjectId: string, similarity: number): Promise<void> {
    try {
      await this.eventLog.append({
        event_type: SignalEventType.SOUL_SIGNAL_TRIAGED,
        entity_type: "candidate_memory_signal",
        entity_id: input.signalId,
        workspace_id: input.workspaceId,
        run_id: input.runId,
        caused_by: `reconciliation_noop:duplicate_of=${survivingObjectId}:similarity=${similarity.toFixed(3)}:dropped_content=${encodeAuditContent(input.incomingContent)}`,
        payload_json: SoulSignalTriagedPayloadSchema.parse({
          signal_id: input.signalId,
          workspace_id: input.workspaceId,
          run_id: input.runId,
          triage_result: "dropped"
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
