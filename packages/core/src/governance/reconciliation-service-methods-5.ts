import {
  errorMessage,
  type MemoryEntry,
  type ReconciliationServiceMethodOwner
} from "./reconciliation-service-internal.js";
import { reconciliationServiceWarn } from "./reconciliation-service-methods-6.js";

export async function reconciliationServiceRetrieveNeighbors(owner: ReconciliationServiceMethodOwner, workspaceId: string, incomingContent: string): Promise<readonly Readonly<MemoryEntry>[]> {
    let hits: readonly { readonly object_id: string }[];
    try {
      hits = await owner.deps.keywordSearch.searchByKeyword(
        workspaceId,
        incomingContent,
        owner.topK
      );
    } catch (error) {
      reconciliationServiceWarn(owner, "reconciliation keyword search failed", {
        workspace_id: workspaceId,
        error: errorMessage(error)
      });
      return [];
    }
    if (hits.length === 0) {
      return [];
    }
    try {
      const entries = await owner.deps.memoryRepo.findByIds(
        hits.map((hit) => hit.object_id)
      );
      return entries.filter(
        (entry) =>
          entry.workspace_id === workspaceId && entry.lifecycle_state !== "archived"
      );
    } catch (error) {
      reconciliationServiceWarn(owner, "reconciliation neighbor fetch failed", {
        workspace_id: workspaceId,
        error: errorMessage(error)
      });
      return [];
    }
  }

export async function reconciliationServiceApplyUpdate(owner: ReconciliationServiceMethodOwner, targetObjectId: string, incomingContent: string, incomingDomainTags: readonly string[], incomingEvidenceRef: string | undefined): Promise<boolean> {
    try {
      const existing = await owner.deps.memoryRepo.findByIds([targetObjectId]);
      const row = existing[0];
      if (row === undefined || row.lifecycle_state === "archived") {
        reconciliationServiceWarn(owner, "reconciliation update target missing or archived", {
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
        // The fresh ingest path derives a memory_entry's domain_tags
        // directly from the signal's domain_tags (buildMemoryInput); an
        // in-place refine mirrors that so the row's tags track its
        // current content. see also:
        // packages/soul/src/garden/materialization-router/inputs.ts buildMemoryInput
        domain_tags: incomingDomainTags
      };
      if (incomingEvidenceRef !== undefined && incomingEvidenceRef.trim().length > 0) {
        fields.evidence_refs = row.evidence_refs.includes(incomingEvidenceRef)
          ? row.evidence_refs
          : [...row.evidence_refs, incomingEvidenceRef];
      }
      await owner.deps.memoryUpdate.update(
        targetObjectId,
        fields,
        "reconciliation_refine"
      );
      return true;
    } catch (error) {
      reconciliationServiceWarn(owner, "reconciliation update failed", {
        object_id: targetObjectId,
        error: errorMessage(error)
      });
      return false;
    }
  }
