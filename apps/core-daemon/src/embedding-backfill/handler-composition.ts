import {
  type EmbeddingBackfillHandler,
  type EvidenceDocumentEmbeddingBackfillHandler
} from "@do-soul/alaya-core";
import type { EmbeddingBackfillMode } from "./execution-mode.js";

const MEMORY_CACHE_ONLY_EVIDENCE_AUDIT =
  "evidence_embedding_backfill_skipped:memory_cache_only";

export function composeEmbeddingBackfillHandlers(
  memoryHandler: Pick<EmbeddingBackfillHandler, "handle">,
  evidenceHandler: Pick<EvidenceDocumentEmbeddingBackfillHandler, "handle">
) {
  return {
    handle: async (
      task: Parameters<EmbeddingBackfillHandler["handle"]>[0],
      mode: EmbeddingBackfillMode = "production"
    ) => {
      const memory = await memoryHandler.handle(task);
      if (mode === "memory_cache_only") {
        return Object.freeze({
          objectsAffected: memory.objectsAffected,
          auditEntries: Object.freeze([
            ...memory.auditEntries,
            MEMORY_CACHE_ONLY_EVIDENCE_AUDIT
          ])
        });
      }
      const evidence = await evidenceHandler.handle(task);
      return Object.freeze({
        objectsAffected: memory.objectsAffected,
        auditEntries: Object.freeze([...memory.auditEntries, ...evidence.auditEntries])
      });
    }
  };
}
