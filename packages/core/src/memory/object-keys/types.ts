import type {
  MemoryObjectKey,
  OpenSemanticFactorGraph
} from "@do-soul/alaya-protocol";

export interface MintableEvidence {
  readonly object_id: string;
  readonly gist: string;
  readonly fact_key_contents: readonly string[];
  readonly osf_graph: Readonly<OpenSemanticFactorGraph> | null;
}

export interface MintMemoryObjectKeysInput {
  readonly workspace_id: string;
  readonly owner_id: string;
  readonly memory_content: string;
  readonly evidence: readonly Readonly<MintableEvidence>[];
}

export type DraftMemoryObjectKey = Omit<MemoryObjectKey, "schema_version" | "key_id" | "normalized_surface">;
