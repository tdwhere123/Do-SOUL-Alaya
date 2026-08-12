import {
  OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { getCoreConfig } from "../../config/install-core-config.js";
import { createBoundedNonMemoryPreview } from "../../recall/coarse-filter/non-memory-preview.js";
import { hasEvidenceDocumentEmbeddingAuthority } from
  "../../shared/evidence-recall-authority.js";
import {
  BACKFILL_BATCH_CONCURRENCY_MAX,
  BACKFILL_BATCH_MAX_INPUT_CHARS,
  BACKFILL_BATCH_SIZE,
  BACKFILL_TIMEOUT_MS,
  resolveBackfillBatchConcurrency
} from "../embedding-backfill-handler-shared.js";
import type {
  EmbeddingProviderPort,
  EvidenceDocumentEmbeddingRepoPort,
  EvidenceDocumentEmbeddingSource
} from "../types.js";
import {
  EvidenceDocumentEmbeddingEngine,
  type EvidenceDocumentEmbeddingInput
} from "./evidence-document-embedding-engine.js";

export interface EvidenceDocumentEmbeddingBackfillResult {
  readonly documentsAffected: number;
  readonly auditEntries: readonly string[];
}

export interface EvidenceDocumentEmbeddingBackfillDependencies {
  readonly evidenceDocumentEmbeddingRepo: EvidenceDocumentEmbeddingRepoPort;
  readonly provider: EmbeddingProviderPort;
  readonly now?: () => string;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly batchConcurrency?: number | string;
}

type BackfillDocument = EvidenceDocumentEmbeddingInput["documents"][number];

export class EvidenceDocumentEmbeddingBackfillHandler {
  private readonly engine: EvidenceDocumentEmbeddingEngine;
  private readonly batchConcurrency: number;

  public constructor(
    private readonly dependencies: EvidenceDocumentEmbeddingBackfillDependencies
  ) {
    this.engine = new EvidenceDocumentEmbeddingEngine(
      dependencies.provider,
      BACKFILL_BATCH_SIZE * BACKFILL_BATCH_CONCURRENCY_MAX,
      dependencies.evidenceDocumentEmbeddingRepo,
      dependencies.now,
      dependencies.warn
    );
    this.batchConcurrency = resolveBackfillBatchConcurrency(
      dependencies.batchConcurrency ??
      getCoreConfig().embedding.backfillConcurrency
    );
  }

  public async handle(
    task: Pick<GardenTaskDescriptor, "workspace_id">
  ): Promise<EvidenceDocumentEmbeddingBackfillResult> {
    if (!this.dependencies.provider.isAvailable) {
      return result(0, ["evidence_embedding_backfill_skipped:provider_unavailable"]);
    }
    const sources = await this.dependencies.evidenceDocumentEmbeddingRepo
      .listSourcesByWorkspace(task.workspace_id);
    const documents = buildBackfillDocuments(sources, task.workspace_id);
    if (documents.length === 0) {
      return result(0, ["evidence_embedding_backfill_skipped:no_documents"]);
    }
    const batches = buildBatches(documents);
    const persistedCounts = await mapConcurrent(
      batches,
      this.batchConcurrency,
      async (batch) => await this.embedBackfillBatch(task.workspace_id, batch)
    );
    const affected = persistedCounts.reduce((total, count) => total + count, 0);
    return result(affected, [`evidence_embedding_backfill:persisted:${affected}`]);
  }

  private async embedBackfillBatch(
    workspaceId: string,
    documents: readonly BackfillDocument[]
  ): Promise<number> {
    const embedded = await this.engine.embedDocuments({
      workspaceId,
      documents
    }, BACKFILL_TIMEOUT_MS);
    if (embedded.inferenceCalls > 0 && embedded.persistedCount === 0) {
      throw new Error("Evidence embedding backfill could not persist its cold batch.");
    }
    return embedded.persistedCount;
  }
}

function toBackfillDocument(
  source: Readonly<EvidenceDocumentEmbeddingSource>,
  workspaceId: string
): readonly BackfillDocument[] {
  if (!hasEvidenceDocumentEmbeddingAuthority(source, workspaceId)) return [];
  return [{
    ownerObjectId: source.ownerObjectId,
    documentIdentity: source.documentIdentity,
    content: createBoundedNonMemoryPreview(source.content)
  }];
}

function buildBackfillDocuments(
  sources: readonly Readonly<EvidenceDocumentEmbeddingSource>[],
  workspaceId: string
): readonly BackfillDocument[] {
  const documents = sources.flatMap((source) =>
    toBackfillDocument(source, workspaceId)
  );
  return documents.filter((document) =>
    document.documentIdentity !== OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY ||
    !documents.some((candidate) =>
      candidate.ownerObjectId === document.ownerObjectId &&
      candidate.documentIdentity === "owner" &&
      candidate.content === document.content
    )
  );
}

function buildBatches(
  documents: readonly BackfillDocument[]
): readonly (readonly BackfillDocument[])[] {
  const batches: BackfillDocument[][] = [];
  let batch: BackfillDocument[] = [];
  let chars = 0;
  for (const document of documents) {
    const full = batch.length >= BACKFILL_BATCH_SIZE;
    const tooLong = batch.length > 0 &&
      chars + document.content.length > BACKFILL_BATCH_MAX_INPUT_CHARS;
    if (full || tooLong) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(document);
    chars += document.content.length;
  }
  if (batch.length > 0) batches.push(batch);
  return Object.freeze(batches.map((entries) => Object.freeze(entries)));
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<R>
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await action(values[index]!);
      }
    }
  ));
  return Object.freeze(results);
}

function result(
  documentsAffected: number,
  auditEntries: readonly string[]
): EvidenceDocumentEmbeddingBackfillResult {
  return Object.freeze({
    documentsAffected,
    auditEntries: Object.freeze([...auditEntries])
  });
}
