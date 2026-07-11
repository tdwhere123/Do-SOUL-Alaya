import { createHash } from "node:crypto";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { MemoryEntryRepo } from "@do-soul/alaya-storage";

export interface BackfillFormationObject {
  readonly objectId: string;
  readonly sessionId: string | null;
  readonly formationKey: string;
}

export async function loadBackfillFormationObjects(
  memoryRepo: Pick<MemoryEntryRepo, "findByIds">,
  workspaceId: string,
  objectIds: readonly string[]
): Promise<readonly BackfillFormationObject[]> {
  const requestedIds = new Set(objectIds);
  if (requestedIds.size !== objectIds.length) {
    throw new Error("backfill formation input contains duplicate object ids");
  }
  const entries = await memoryRepo.findByIds(workspaceId, objectIds);
  const foundIds = new Set(entries.map((entry) => entry.object_id));
  if (
    foundIds.size !== requestedIds.size ||
    [...requestedIds].some((objectId) => !foundIds.has(objectId))
  ) {
    throw new Error("persisted formation evidence is unavailable for one or more objects");
  }
  return Object.freeze(entries.map((entry) => Object.freeze({
    objectId: entry.object_id,
    sessionId: entry.surface_id,
    formationKey: memoryFormationKey(entry)
  })));
}

// invariant: topology order uses persisted formation evidence, never UUID or row order.
function memoryFormationKey(entry: Readonly<MemoryEntry>): string {
  return JSON.stringify([
    entry.created_at,
    entry.surface_id,
    entry.run_id,
    entry.created_by,
    entry.source_kind,
    entry.formation_kind,
    entry.dimension,
    entry.scope_class,
    createHash("sha256").update(entry.content, "utf8").digest("hex")
  ]);
}
