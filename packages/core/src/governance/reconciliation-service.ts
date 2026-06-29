import { randomUUID } from "node:crypto";

import {
  SignalEventType,
  SoulSignalTriagedPayloadSchema,
  type MemoryEntry
} from "@do-soul/alaya-protocol";

import { KeyedMutex } from "../shared/keyed-mutex.js";
import { assertGovernanceRunWorkspace, type GovernanceRunWorkspaceLookup } from "./run-workspace-guard.js";
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
  type ReconciliationMemoryProjectionFields,
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
  ReconciliationMemoryProjectionFields,
  ReconciliationMemoryUpdatePort,
  ReconciliationServiceDependencies,
  ReconciliationServiceThresholds,
  ReconciliationVerdictApplier
} from "./reconciliation-service-internal.js";

function buildProjectionMergeFields(
  existing: Readonly<MemoryEntry>,
  incoming: ReconciliationMemoryProjectionFields | undefined
): MutableProjectionMergeFields {
  if (incoming === undefined) {
    return {};
  }
  const fields: MutableProjectionMergeFields = {};
  for (const key of PROJECTION_FIELD_KEYS) {
    if (existing[key] === undefined || existing[key] === null) {
      const value = incoming[key];
      if (value !== undefined && value !== null) {
        fields[key] = value as never;
      }
    }
  }
  return fields;
}

function buildProjectionReplacementFields(
  incoming: ReconciliationMemoryProjectionFields | undefined
): MutableProjectionMergeFields {
  if (incoming === undefined) {
    return {};
  }
  const fields: MutableProjectionMergeFields = {};
  for (const key of PROJECTION_FIELD_KEYS) {
    const value = incoming[key];
    if (value !== undefined) {
      fields[key] = value as never;
    }
  }
  return fields;
}

function updateFieldsMatch(
  row: Readonly<MemoryEntry>,
  fields: {
    readonly content: string;
    readonly domain_tags: readonly string[];
    readonly evidence_refs?: readonly string[];
  } & Partial<ReconciliationMemoryProjectionFields>
): boolean {
  if (row.content !== fields.content || !sameStringSet(row.domain_tags, fields.domain_tags)) {
    return false;
  }
  if (fields.evidence_refs !== undefined && !sameStringSet(row.evidence_refs, fields.evidence_refs)) {
    return false;
  }
  return PROJECTION_FIELD_KEYS.every(
    (key) => fields[key] === undefined || projectionValuesMatch(row[key], fields[key])
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((item, index) => item === sortedRight[index]);
}

function projectionValuesMatch(
  actual: MemoryEntry[(typeof PROJECTION_FIELD_KEYS)[number]] | undefined,
  expected: MemoryEntry[(typeof PROJECTION_FIELD_KEYS)[number]] | undefined
): boolean {
  if (expected === null) {
    return actual === null || actual === undefined;
  }
  return actual === expected;
}

type MutableProjectionMergeFields = {
  -readonly [K in keyof ReconciliationMemoryProjectionFields]?: ReconciliationMemoryProjectionFields[K];
};

const PROJECTION_FIELD_KEYS = [
  "projection_schema_version",
  "event_time_start",
  "event_time_end",
  "valid_from",
  "valid_to",
  "time_precision",
  "time_source",
  "preference_subject",
  "preference_predicate",
  "preference_object",
  "preference_category",
  "preference_polarity"
] as const;

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
    this.runLookup = deps.runLookup;
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
      await assertGovernanceRunWorkspace(this.runLookup, input.runId, input.workspaceId);
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
        input.workspaceId,
        decision.survivingObjectId,
        input.incomingContent.trim(),
        input.incomingDomainTags,
        incomingEvidenceRef,
        input.incomingProjectionFields,
        input.incomingFacetTags
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

  private async applyUpdate(
    workspaceId: string,
    targetObjectId: string,
    incomingContent: string,
    incomingDomainTags: readonly string[],
    incomingEvidenceRef: string | undefined,
    incomingProjectionFields: ReconciliationMemoryProjectionFields | undefined,
    incomingFacetTags: MemoryEntry["facet_tags"] | undefined
  ): Promise<boolean> {
    const existing = await this.findUpdateTarget(workspaceId, targetObjectId);
    if (existing === null) {
      return false;
    }
    const fields = this.buildUpdateFields(
      existing,
      incomingContent,
      incomingDomainTags,
      incomingEvidenceRef,
      incomingProjectionFields,
      incomingFacetTags
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

  private buildUpdateFields(
    existing: Readonly<MemoryEntry>,
    incomingContent: string,
    incomingDomainTags: readonly string[],
    incomingEvidenceRef: string | undefined,
    incomingProjectionFields: ReconciliationMemoryProjectionFields | undefined,
    incomingFacetTags: MemoryEntry["facet_tags"] | undefined
  ): {
    readonly content: string;
    readonly domain_tags: readonly string[];
    readonly evidence_refs?: readonly string[];
    readonly facet_tags?: MemoryEntry["facet_tags"];
  } & Partial<ReconciliationMemoryProjectionFields> {
    const fields = {
      content: incomingContent,
      domain_tags: incomingDomainTags
    } as {
      content: string;
      domain_tags: readonly string[];
      evidence_refs?: readonly string[];
      facet_tags?: MemoryEntry["facet_tags"];
    } & Partial<ReconciliationMemoryProjectionFields>;
    if (incomingEvidenceRef !== undefined && incomingEvidenceRef.trim().length > 0) {
      fields.evidence_refs = existing.evidence_refs.includes(incomingEvidenceRef)
        ? existing.evidence_refs
        : [...existing.evidence_refs, incomingEvidenceRef];
    }
    Object.assign(fields, buildProjectionReplacementFields(incomingProjectionFields));
    // content-derived: refresh on the same UPDATE that rewrites content; merge/match leave it untouched.
    if (incomingFacetTags !== undefined) {
      fields.facet_tags = incomingFacetTags;
    }
    return fields;
  }

  private async updateAppearsApplied(
    workspaceId: string,
    targetObjectId: string,
    fields: {
      readonly content: string;
      readonly domain_tags: readonly string[];
      readonly evidence_refs?: readonly string[];
    } & Partial<ReconciliationMemoryProjectionFields>
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
      return null;
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
