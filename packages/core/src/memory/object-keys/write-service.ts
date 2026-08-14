import type { MemoryEntry, MemoryObjectKey } from "@do-soul/alaya-protocol";
import { mintMemoryObjectKeys } from "./mint.js";
import type { MintableEvidence } from "./types.js";

export interface MemoryObjectKeyWriter {
  materializeForMemory(
    memory: Pick<MemoryEntry, "object_id" | "workspace_id" | "content" | "evidence_refs">
  ): void;
}

export interface MemoryObjectKeyWritePorts {
  readonly readEvidenceSources: (
    workspaceId: string,
    evidenceIds: readonly string[]
  ) => readonly Readonly<MintableEvidence>[];
  readonly replaceOwnerKeys: (
    workspaceId: string,
    ownerId: string,
    keys: readonly Readonly<MemoryObjectKey>[]
  ) => void;
}

export function createMemoryObjectKeyWriter(
  ports: Readonly<MemoryObjectKeyWritePorts>
): MemoryObjectKeyWriter {
  return {
    materializeForMemory(memory) {
      const keys = mintMemoryObjectKeys({
        workspace_id: memory.workspace_id,
        owner_id: memory.object_id,
        memory_content: memory.content,
        evidence: ports.readEvidenceSources(memory.workspace_id, memory.evidence_refs)
      });
      ports.replaceOwnerKeys(memory.workspace_id, memory.object_id, keys);
    }
  };
}
