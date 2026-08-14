import type { MemoryObjectKey } from "@do-soul/alaya-protocol";
import { mintMemoryObjectKeys } from "../mint/mint.js";
import type { MintableEvidence } from "../types.js";

export interface ObjectKeyRetrofitOwner {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly content: string;
  readonly evidence_refs: readonly string[];
}

export interface ObjectKeyRetrofitReport {
  readonly schema_version: 1;
  readonly owner_count: number;
  readonly objects_with_keys: number;
  readonly key_count: number;
  readonly elapsed_ms: number;
}

export function retrofitMemoryObjectKeys(input: Readonly<{
  readonly owners: readonly Readonly<ObjectKeyRetrofitOwner>[];
  readonly evidence: readonly Readonly<MintableEvidence>[];
  readonly replaceOwnerKeys: (
    workspaceId: string,
    ownerId: string,
    keys: readonly Readonly<MemoryObjectKey>[]
  ) => void;
}>): Readonly<ObjectKeyRetrofitReport> {
  const started = Date.now();
  const evidenceById = new Map(input.evidence.map((item) => [item.object_id, item]));
  let objectsWithKeys = 0;
  let keyCount = 0;
  for (const owner of input.owners) {
    const keys = mintMemoryObjectKeys({
      workspace_id: owner.workspace_id,
      owner_id: owner.object_id,
      memory_content: owner.content,
      evidence: owner.evidence_refs.flatMap((id) => {
        const source = evidenceById.get(id);
        return source === undefined ? [] : [source];
      })
    });
    input.replaceOwnerKeys(owner.workspace_id, owner.object_id, keys);
    if (keys.length > 0) objectsWithKeys += 1;
    keyCount += keys.length;
  }
  return Object.freeze({
    schema_version: 1,
    owner_count: input.owners.length,
    objects_with_keys: objectsWithKeys,
    key_count: keyCount,
    elapsed_ms: Date.now() - started
  });
}
