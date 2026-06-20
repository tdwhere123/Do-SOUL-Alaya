import { KeyedMutex } from "../shared/keyed-mutex.js";
import {
  DEFAULT_CONFLICT_TAG_OVERLAP_THRESHOLD,
  DEFAULT_MAX_LLM_CANDIDATES,
  DEFAULT_SIMILARITY_FLOOR,
  DEFAULT_TOP_K,
  RECONCILE_LEASE_TTL_MS,
  type MemoryEntry,
  type ReconciliationDecision,
  type ReconciliationInput,
  type ReconciliationLeasePort,
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

import { reconciliationServiceRunWithDecision } from "./reconciliation-service-methods-1.js";
import { reconciliationServiceRunDecisionSection } from "./reconciliation-service-methods-2.js";
import { reconciliationServiceDecide } from "./reconciliation-service-methods-3.js";
import { reconciliationServiceDecideWithLlm } from "./reconciliation-service-methods-4.js";
import { reconciliationServiceRetrieveNeighbors, reconciliationServiceApplyUpdate } from "./reconciliation-service-methods-5.js";
import { reconciliationServiceAuditDrop, reconciliationServiceWarn } from "./reconciliation-service-methods-6.js";

export class ReconciliationService {
public readonly similarityFloor: number;

public readonly conflictTagOverlapThreshold: number;

public readonly topK: number;

public readonly maxLlmCandidates: number;

public readonly mutex: KeyedMutex;

public readonly lease?: ReconciliationLeasePort;

public readonly leaseTtlMs: number;

public readonly now: () => Date;

public constructor(public readonly deps: ReconciliationServiceDependencies) {
    const thresholds = deps.thresholds ?? {};
    this.similarityFloor = thresholds.similarityFloor ?? DEFAULT_SIMILARITY_FLOOR;
    this.conflictTagOverlapThreshold =
      thresholds.conflictTagOverlapThreshold ?? DEFAULT_CONFLICT_TAG_OVERLAP_THRESHOLD;
    this.topK = thresholds.topK ?? DEFAULT_TOP_K;
    this.maxLlmCandidates = thresholds.maxLlmCandidates ?? DEFAULT_MAX_LLM_CANDIDATES;
    this.mutex = deps.mutex ?? new KeyedMutex();
    this.lease = deps.lease;
    this.leaseTtlMs = deps.leaseTtlMs ?? RECONCILE_LEASE_TTL_MS;
    this.now = deps.now ?? (() => new Date());
  }

  public async runWithDecision(input: ReconciliationInput, applyVerdict: ReconciliationVerdictApplier): Promise<ReconciliationDecision> {
    return reconciliationServiceRunWithDecision(this, input, applyVerdict);
  }

  private async runDecisionSection(input: ReconciliationInput, applyVerdict: ReconciliationVerdictApplier): Promise<ReconciliationDecision> {
    return reconciliationServiceRunDecisionSection(this, input, applyVerdict);
  }

  private async decide(input: ReconciliationInput): Promise<ReconciliationDecision> {
    return reconciliationServiceDecide(this, input);
  }

  private async decideWithLlm(input: ReconciliationInput, incomingContent: string, candidates: readonly { readonly objectId: string; readonly content: string }[], bestSimilarity: number): Promise<ReconciliationDecision> {
    return reconciliationServiceDecideWithLlm(this, input, incomingContent, candidates, bestSimilarity);
  }

  private async retrieveNeighbors(workspaceId: string, incomingContent: string): Promise<readonly Readonly<MemoryEntry>[]> {
    return reconciliationServiceRetrieveNeighbors(this, workspaceId, incomingContent);
  }

  private async applyUpdate(targetObjectId: string, incomingContent: string, incomingDomainTags: readonly string[], incomingEvidenceRef: string | undefined): Promise<boolean> {
    return reconciliationServiceApplyUpdate(this, targetObjectId, incomingContent, incomingDomainTags, incomingEvidenceRef);
  }

  private async auditDrop(input: ReconciliationInput, survivingObjectId: string, similarity: number): Promise<void> {
    return reconciliationServiceAuditDrop(this, input, survivingObjectId, similarity);
  }

  private warn(message: string, meta: Record<string, unknown>): void {
    return reconciliationServiceWarn(this, message, meta);
  }
}
