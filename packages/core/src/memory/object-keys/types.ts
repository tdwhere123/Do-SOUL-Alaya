import type { MemoryObjectKey } from "@do-soul/alaya-protocol";

export interface MintableEvidence {
  readonly object_id: string;
  readonly gist: string;
}

export interface MintMemoryObjectKeysInput {
  readonly workspace_id: string;
  readonly owner_id: string;
  readonly memory_content: string;
  readonly evidence: readonly Readonly<MintableEvidence>[];
}

export type DraftMemoryObjectKey = Omit<MemoryObjectKey, "schema_version" | "key_id" | "normalized_surface">;
