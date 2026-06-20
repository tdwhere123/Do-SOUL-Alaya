
import {
  MemoryDimension,
  MemoryGovernanceEventType,
  RevokeReason,
  SoulMemoryUpdatedPayloadSchema,
  type FactualPolicyCondition,
  type MemoryEntry,
  type ScopeClass} from "@do-soul/alaya-protocol";

import { CoreError } from "../../shared/errors.js";



import { parseNonEmptyString, parseObjectId } from "../../shared/validators.js";

import type {
  MemoryEntryRepoUpdateFields,
  MemoryEntryUpdateFields,
  MemoryListPageOptions,
  MemoryServiceDependencies
} from "./types.js";

import {
  parseFactualPolicyCondition,
  parseMemoryEntry,
  parseReason,
  parseUpdateFields,
  shouldRevokeGreenForEvidenceRewrite,
  toUpdatedFieldNames
} from "./validators.js";
type MemoryServiceMethodOwner = {
  generateObjectId: () => string;
  now: () => string;
  dependencies: MemoryServiceDependencies;
  [key: string]: any;
};


const MEMORY_SERVICE_SCAN_PAGE_LIMIT = 500;

async function collectMemoryPages(
  readPage: (page: MemoryListPageOptions) => Promise<readonly Readonly<MemoryEntry>[]>
): Promise<readonly Readonly<MemoryEntry>[]> {
  const rows: Readonly<MemoryEntry>[] = [];
  for (let offset = 0; ; offset += MEMORY_SERVICE_SCAN_PAGE_LIMIT) {
    const pageRows = await readPage({
      limit: MEMORY_SERVICE_SCAN_PAGE_LIMIT,
      offset
    });
    rows.push(...pageRows);
    if (pageRows.length < MEMORY_SERVICE_SCAN_PAGE_LIMIT) {
      break;
    }
  }
  return Object.freeze(rows);
}

export async function memoryServiceFindByDimensionAll(owner: MemoryServiceMethodOwner, workspaceId: string, dimension: MemoryEntry["dimension"]): Promise<readonly Readonly<MemoryEntry>[]> {
    const findByDimensionAll = owner.dependencies.memoryEntryRepo.findByDimensionAll;
    if (findByDimensionAll !== undefined) {
      return await findByDimensionAll.call(owner.dependencies.memoryEntryRepo, workspaceId, dimension);
    }

    return await collectMemoryPages((page) =>
      owner.dependencies.memoryEntryRepo.findByDimension(workspaceId, dimension, page)
    );
  }

export async function memoryServiceCountByDimension(owner: MemoryServiceMethodOwner, workspaceId: string, dimension: MemoryEntry["dimension"]): Promise<number> {
    const countByDimension = owner.dependencies.memoryEntryRepo.countByDimension;
    if (countByDimension !== undefined) {
      return await countByDimension.call(owner.dependencies.memoryEntryRepo, workspaceId, dimension);
    }
    return (await owner.findByDimensionAll(workspaceId, dimension)).length;
  }

export function memoryServiceFindByScopeClass(owner: MemoryServiceMethodOwner, workspaceId: string, scopeClass: ScopeClass, page?: MemoryListPageOptions): Promise<readonly Readonly<MemoryEntry>[]> {
    if (page === undefined) {
      return owner.dependencies.memoryEntryRepo.findByScopeClass(workspaceId, scopeClass);
    }
    return owner.dependencies.memoryEntryRepo.findByScopeClass(workspaceId, scopeClass, page);
}

export async function memoryServiceFindByScopeClassAll(owner: MemoryServiceMethodOwner, workspaceId: string, scopeClass: ScopeClass): Promise<readonly Readonly<MemoryEntry>[]> {
    const findByScopeClassAll = owner.dependencies.memoryEntryRepo.findByScopeClassAll;
    if (findByScopeClassAll !== undefined) {
      return await findByScopeClassAll.call(owner.dependencies.memoryEntryRepo, workspaceId, scopeClass);
    }

    return await collectMemoryPages((page) =>
      owner.dependencies.memoryEntryRepo.findByScopeClass(workspaceId, scopeClass, page)
    );
  }

export function memoryServiceValidateFactualPolicyBoundary(owner: MemoryServiceMethodOwner, entry: MemoryEntry, condition: FactualPolicyCondition): boolean {
    const parsedEntry = parseMemoryEntry(entry);
    const parsedCondition = parseFactualPolicyCondition(condition);

    if (parsedEntry.dimension !== MemoryDimension.FACT) {
      return false;
    }

    return (
      parsedCondition.affects_execution_paths ||
      parsedCondition.affects_tool_choices ||
      parsedCondition.affects_write_permissions ||
      parsedCondition.affects_governance_decisions
    );
  }

export async function memoryServiceUpdateInternal(owner: MemoryServiceMethodOwner, input: {
    readonly objectId: string;
    readonly workspaceId?: string;
    readonly fields: MemoryEntryUpdateFields;
    readonly reason: string;
  }): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(input.objectId);
    const parsedWorkspaceId =
      input.workspaceId === undefined ? undefined : parseNonEmptyString(input.workspaceId, "workspaceId");
    const parsedReason = parseReason(input.reason);
    const parsedFields = parseUpdateFields(input.fields);

    if (parsedFields.evidence_refs !== undefined) {
      await owner.validateEvidenceRefs(parsedFields.evidence_refs);
    }

    const existing = await owner.dependencies.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null || (parsedWorkspaceId !== undefined && existing.workspace_id !== parsedWorkspaceId)) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    if (existing.lifecycle_state === "archived") {
      throw new CoreError("VALIDATION", "Memory entry is archived and cannot be updated");
    }

    const updatedFields = toUpdatedFieldNames(parsedFields);
    const occurredAt = owner.now();

    // invariant: append SOUL_MEMORY_UPDATED only after repo write succeeds.
    const repoFields = {
      ...parsedFields,
      updated_at: occurredAt
    };
    const updated =
      parsedWorkspaceId === undefined
        ? await owner.dependencies.memoryEntryRepo.update(parsedObjectId, repoFields)
        : await owner.updateRepoScoped(parsedObjectId, parsedWorkspaceId, repoFields);

    const event = await owner.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedReason,
      payload_json: SoulMemoryUpdatedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        updated_fields: updatedFields
      })
    });

    await owner.dependencies.runtimeNotifier.notifyEntry(event);
    if (
      parsedFields.evidence_refs !== undefined &&
      shouldRevokeGreenForEvidenceRewrite(existing.evidence_refs, parsedFields.evidence_refs)
    ) {
      await owner.dependencies.greenService?.pierce?.({
        targetObjectId: existing.object_id,
        workspaceId: existing.workspace_id,
        reason: RevokeReason.MAPPING_REVOKED,
        runId: existing.run_id
      });
    }
    return updated;
  }

export async function memoryServiceUpdateRepoScoped(owner: MemoryServiceMethodOwner, objectId: string, workspaceId: string, fields: MemoryEntryRepoUpdateFields): Promise<Readonly<MemoryEntry>> {
    if (owner.dependencies.memoryEntryRepo.updateScoped === undefined) {
      throw new CoreError("VALIDATION", "Scoped memory update is not available");
    }

    return await owner.dependencies.memoryEntryRepo.updateScoped(objectId, workspaceId, fields);
  }

export async function memoryServiceValidateEvidenceRefs(owner: MemoryServiceMethodOwner, evidenceRefs: readonly string[]): Promise<void> {
    if (evidenceRefs.length === 0) {
      return;
    }

    const distinctEvidenceRefs = [...new Set(evidenceRefs)];
    const findByIds = owner.dependencies.evidenceService.findByIds;
    if (findByIds !== undefined) {
      const evidence = await findByIds.call(owner.dependencies.evidenceService, distinctEvidenceRefs);
      const foundEvidenceRefs = new Set(evidence.map((entry) => entry.object_id));
      const firstMissing = distinctEvidenceRefs.find((evidenceRef) => !foundEvidenceRefs.has(evidenceRef));
      if (firstMissing !== undefined) {
        throw new CoreError("VALIDATION", `Evidence reference not found: ${firstMissing}`);
      }
      return;
    }

    const results = await Promise.all(
      distinctEvidenceRefs.map(async (evidenceRef) => ({
        evidenceRef,
        evidence: await owner.dependencies.evidenceService.findById(evidenceRef)
      }))
    );

    const firstMissing = results.find((result) => result.evidence === null);

    if (firstMissing !== undefined) {
      throw new CoreError("VALIDATION", `Evidence reference not found: ${firstMissing.evidenceRef}`);
    }
  }
