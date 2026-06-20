import {
  type PathAnchorRef,
  type PathRelation,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";





import {
  computeUsedSignalWeight,
  isMemoryEntryAnchorUsage,
  isObjectAnchor,
  isRetiredPath,
  maxIsoNullable,
  throwIfPathPlasticityAborted,
  uniqueStrings} from "./helpers.js";

import type {
  DirectionalPathUsage,
  MutableDirectionalPathUsage,
  MutableObjectUsageCounts,
  PathAggregate,
  PathPlasticityComputeResult,
  PathPlasticityMutationPlan,
  PathPlasticityPromotionRecord,
  PathPlasticityServiceDependencies} from "./types.js";
type PathPlasticityServiceMethodOwner = {
  now: () => string;
  dependencies: PathPlasticityServiceDependencies;
  [key: string]: any;
};

interface MutablePlasticityComputeSummary {
  reinforced: number;
  weakened: number;
  retired: number;
  dormant: number;
  revived: number;
  readonly affected: Set<string>;
  readonly promotions: PathPlasticityPromotionRecord[];
}

interface ComputeAndApplyPlasticityParams {
  readonly workspaceId: string;
  readonly sinceIso: string;
  readonly untilIso?: string;
  readonly abortSignal?: AbortSignal;
  readonly onMutationBoundaryEntered?: () => void;
}

export async function pathPlasticityServiceComputeAndApplyPlasticity(owner: PathPlasticityServiceMethodOwner, params: ComputeAndApplyPlasticityParams): Promise<PathPlasticityComputeResult> {
    throwIfPathPlasticityAborted(params.abortSignal);
    const usageRecords = await owner.dependencies.usageProofReader.listRecentUsage(
      params.workspaceId,
      params.sinceIso,
      params.untilIso
    );
    throwIfPathPlasticityAborted(params.abortSignal);

    if (usageRecords.length === 0) {
      return emptyPlasticityComputeResult();
    }

    const pathAggregates = await owner.aggregatePathUsage(
      params.workspaceId,
      usageRecords,
      params.abortSignal
    );
    throwIfPathPlasticityAborted(params.abortSignal);

    const summary = createPlasticityComputeSummary();
    const mutationPlans: PathPlasticityMutationPlan[] = [];
    for (const { path, counts } of pathAggregates.values()) {
      if (isRetiredPath(path)) {
        continue;
      }
      const plan = owner.planDeltasForPath(path, counts, params.abortSignal);
      if (plan === null) {
        continue;
      }
      mutationPlans.push(plan);
      applyPlanToComputeSummary(summary, plan);
    }

    owner.applyMutationPlans(
      mutationPlans,
      params.abortSignal,
      params.onMutationBoundaryEntered
    );

    return Object.freeze({
      reinforced: summary.reinforced,
      weakened: summary.weakened,
      retired: summary.retired,
      dormant: summary.dormant,
      revived: summary.revived,
      affectedPathIds: Object.freeze([...summary.affected]),
      promotions: Object.freeze(summary.promotions)
    });
  }

export async function pathPlasticityServiceAggregatePathUsage(owner: PathPlasticityServiceMethodOwner, workspaceId: string, usageRecords: readonly Readonly<UsageProofRecord>[], abortSignal?: AbortSignal): Promise<ReadonlyMap<string, PathAggregate>> {
    const pathAggregates = new Map<string, PathAggregate>();
    const seenAuditEventIds = new Set<string>();

    for (const record of usageRecords) {
      throwIfPathPlasticityAborted(abortSignal);
      if (seenAuditEventIds.has(record.audit_event_id)) {
        continue;
      }
      seenAuditEventIds.add(record.audit_event_id);
      await aggregateSingleUsageRecord(owner, workspaceId, record, pathAggregates, abortSignal);
    }

    return pathAggregates;
  }

function emptyPlasticityComputeResult(): PathPlasticityComputeResult {
    return Object.freeze({
      reinforced: 0,
      weakened: 0,
      retired: 0,
      dormant: 0,
      revived: 0,
      affectedPathIds: [],
      promotions: []
    });
  }

function createPlasticityComputeSummary(): MutablePlasticityComputeSummary {
    return {
      reinforced: 0,
      weakened: 0,
      retired: 0,
      dormant: 0,
      revived: 0,
      affected: new Set<string>(),
      promotions: []
    };
  }

function applyPlanToComputeSummary(summary: MutablePlasticityComputeSummary, plan: Readonly<PathPlasticityMutationPlan>): void {
    if (plan.outcome === "reinforced") {
      summary.reinforced += 1;
    } else if (plan.outcome === "weakened") {
      summary.weakened += 1;
    } else if (plan.outcome === "retired") {
      summary.retired += 1;
    } else if (plan.outcome === "dormant") {
      summary.dormant += 1;
    } else if (plan.outcome === "revived") {
      summary.revived += 1;
    }
    summary.affected.add(plan.pathId);
    if (plan.promotion.governance !== null || plan.promotion.stability !== null) {
      summary.promotions.push(Object.freeze({
        path_id: plan.pathId,
        governance_promoted: plan.promotion.governance,
        stability_promoted: plan.promotion.stability
      }));
    }
  }

async function aggregateSingleUsageRecord(owner: PathPlasticityServiceMethodOwner, workspaceId: string, record: Readonly<UsageProofRecord>, pathAggregates: Map<string, PathAggregate>, abortSignal?: AbortSignal): Promise<void> {
    const targetObjectIds = await resolveRecordTargetObjectIds(owner, record, abortSignal);
    if (targetObjectIds.length === 0) {
      return;
    }
    const pathsTouchedByReceipt = await collectPathsTouchedByReceipt(
      owner,
      workspaceId,
      targetObjectIds,
      abortSignal
    );
    for (const [pathId, path] of pathsTouchedByReceipt.entries()) {
      applyUsageStateCounts(pathAggregates, pathId, path, record);
    }
    const directionalUsage = await owner.resolveDirectionalPathUsage(workspaceId, record, abortSignal);
    for (const [pathId, usage] of directionalUsage.entries()) {
      applyDirectionalUsageCounts(pathAggregates, pathId, usage, record);
    }
  }

async function resolveRecordTargetObjectIds(owner: PathPlasticityServiceMethodOwner, record: Readonly<UsageProofRecord>, abortSignal?: AbortSignal): Promise<readonly string[]> {
    if (record.usage_state === "used") {
      return uniqueStrings([
        ...record.used_object_ids,
        ...(record.per_anchor_usage ?? [])
          .filter(isMemoryEntryAnchorUsage)
          .map((usage) => usage.object_id)
      ]);
    }
    if (record.usage_state !== "skipped" && record.usage_state !== "not_applicable") {
      return [];
    }
    const targetObjectIds = record.used_object_ids.length > 0
      ? record.used_object_ids
      : await owner.resolveDeliveredMemoryObjectIds(record.delivery_id);
    throwIfPathPlasticityAborted(abortSignal);
    return targetObjectIds;
  }

async function collectPathsTouchedByReceipt(owner: PathPlasticityServiceMethodOwner, workspaceId: string, targetObjectIds: readonly string[], abortSignal?: AbortSignal): Promise<ReadonlyMap<string, Readonly<PathRelation>>> {
    const pathsTouchedByReceipt = new Map<string, Readonly<PathRelation>>();
    for (const objectId of targetObjectIds) {
      throwIfPathPlasticityAborted(abortSignal);
      const anchorRef: PathAnchorRef = Object.freeze({ kind: "object", object_id: objectId });
      const paths = await owner.dependencies.pathRelationRepo.findByAnchor(workspaceId, anchorRef);
      throwIfPathPlasticityAborted(abortSignal);
      for (const path of paths) {
        if (!pathsTouchedByReceipt.has(path.path_id)) {
          pathsTouchedByReceipt.set(path.path_id, path);
        }
      }
    }
    return pathsTouchedByReceipt;
  }

function applyUsageStateCounts(pathAggregates: Map<string, PathAggregate>, pathId: string, path: Readonly<PathRelation>, record: Readonly<UsageProofRecord>): void {
    const existing = pathAggregates.get(pathId);
    const counts = existing?.counts ?? createEmptyObjectUsageCounts();
    if (record.usage_state === "used") {
      counts.usedWeight += computeUsedSignalWeight(record, counts.used);
      counts.used += 1;
    } else if (record.usage_state === "skipped") {
      counts.skipped += 1;
    } else if (record.usage_state === "not_applicable") {
      counts.notApplicable += 1;
    }
    counts.lastReportedAt = maxIsoNullable(counts.lastReportedAt, record.reported_at);
    if (existing === undefined) {
      pathAggregates.set(pathId, { path, counts });
    }
  }

function applyDirectionalUsageCounts(pathAggregates: Map<string, PathAggregate>, pathId: string, usage: Readonly<DirectionalPathUsage>, record: Readonly<UsageProofRecord>): void {
    const existing = pathAggregates.get(pathId);
    const counts = existing?.counts ?? createEmptyObjectUsageCounts();
    if (usage.sourceUsed) {
      counts.sourceAnchorUsage += 1;
    }
    if (usage.targetUsed) {
      counts.targetAnchorUsage += 1;
    }
    counts.lastReportedAt = maxIsoNullable(counts.lastReportedAt, record.reported_at);
    if (existing === undefined) {
      pathAggregates.set(pathId, { path: usage.path, counts });
    }
  }

function createEmptyObjectUsageCounts(): MutableObjectUsageCounts {
    return {
      used: 0,
      usedWeight: 0,
      skipped: 0,
      notApplicable: 0,
      sourceAnchorUsage: 0,
      targetAnchorUsage: 0,
      lastReportedAt: null
    };
  }

export async function pathPlasticityServiceResolveDeliveredMemoryObjectIds(owner: PathPlasticityServiceMethodOwner, deliveryId: string): Promise<readonly string[]> {
    const deliveredObjects =
      await owner.dependencies.usageProofReader.findDeliveredObjects?.(deliveryId);
    if (deliveredObjects !== undefined && deliveredObjects !== null) {
      return uniqueStrings(
        deliveredObjects
          .filter((object) => object.object_kind === "memory_entry")
          .map((object) => object.object_id)
      );
    }

    return (await owner.dependencies.usageProofReader.findDeliveredObjectIds(deliveryId)) ?? [];
  }

export async function pathPlasticityServiceResolveDirectionalPathUsage(owner: PathPlasticityServiceMethodOwner, workspaceId: string, record: Readonly<UsageProofRecord>, abortSignal?: AbortSignal): Promise<ReadonlyMap<string, DirectionalPathUsage>> {
    // invariant: only memory_entry anchors drive PathRelation direction bias.
    // A synthesis_capsule shares the delivered-objects scope with memory and
    // could collide with a path anchor object_id, so it is filtered here too,
    // not only on the used/skipped strength-crediting paths above.
    const perAnchorUsage = (record.per_anchor_usage ?? []).filter(isMemoryEntryAnchorUsage);
    if (record.usage_state !== "used" || perAnchorUsage.length === 0) {
      return new Map();
    }

    const directionalUsage = new Map<string, MutableDirectionalPathUsage>();
    for (const usage of perAnchorUsage) {
      throwIfPathPlasticityAborted(abortSignal);
      const paths = await owner.dependencies.pathRelationRepo.findByAnchor(
        workspaceId,
        Object.freeze({ kind: "object", object_id: usage.object_id })
      );
      throwIfPathPlasticityAborted(abortSignal);
      for (const path of paths) {
        const matchesSource =
          usage.anchor_role === "source" &&
          isObjectAnchor(path.anchors.source_anchor, usage.object_id);
        const matchesTarget =
          usage.anchor_role === "target" &&
          isObjectAnchor(path.anchors.target_anchor, usage.object_id);
        if (!matchesSource && !matchesTarget) {
          continue;
        }
        const existing = directionalUsage.get(path.path_id) ?? {
          path,
          sourceUsed: false,
          targetUsed: false
        };
        directionalUsage.set(path.path_id, {
          path,
          sourceUsed: existing.sourceUsed || matchesSource,
          targetUsed: existing.targetUsed || matchesTarget
        });
      }
    }

    return directionalUsage;
  }
