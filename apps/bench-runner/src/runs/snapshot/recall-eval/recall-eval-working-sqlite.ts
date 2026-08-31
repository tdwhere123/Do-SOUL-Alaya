import { join } from "node:path";
import type { RecallEvalOptions } from
  "../../lifecycle/recall-eval/recall-eval-contract.js";
import type { RecallEvalSnapshotBundle } from "./recall-eval-loader.js";
import { prepareRecallEvalRestoredDb } from "./recall-eval-db.js";
import { applyEmbeddingCacheOverlay } from
  "./embedding-cache-overlay/importer.js";
import type {
  EmbeddingCacheOverlayBinding,
  EmbeddingCacheOverlayExpectedSourceBinding
} from "./embedding-cache-overlay/contract.js";
import {
  rebuildEvidenceSearchProjectionsOnWorkingCopy,
  type EvidenceSearchProjectionRebuildReport
} from "./evidence-search-projection-rebuild.js";
import type { WarmDerivedSnapshotReceipt } from
  "./warm-derived/warm-derived-snapshot-receipt.js";

export async function openRecallEvalWorkingSqlite(input: {
  readonly restoredDbPath: string;
  readonly options: RecallEvalOptions;
  readonly manifest: RecallEvalSnapshotBundle["manifest"];
  readonly sourceExtractionSystemPromptSha256?: string;
  readonly warm: WarmDerivedSnapshotReceipt | null;
  readonly overlayExpected?: EmbeddingCacheOverlayExpectedSourceBinding;
  readonly snapshotBytePath?: string;
}): Promise<Readonly<{
  evidenceProjectionRebuild: EvidenceSearchProjectionRebuildReport | null;
  embeddingCacheOverlay: EmbeddingCacheOverlayBinding | null;
}>> {
  const evidenceProjectionRebuild = await prepareRecallEvalWorkingDb(input);
  const embeddingCacheOverlay = await bindOverlayIfRequested(input);
  return Object.freeze({ evidenceProjectionRebuild, embeddingCacheOverlay });
}

async function prepareRecallEvalWorkingDb(input: {
  readonly restoredDbPath: string;
  readonly options: RecallEvalOptions;
  readonly manifest: RecallEvalSnapshotBundle["manifest"];
  readonly sourceExtractionSystemPromptSha256?: string;
  readonly warm: WarmDerivedSnapshotReceipt | null;
  readonly snapshotBytePath?: string;
}): Promise<EvidenceSearchProjectionRebuildReport | null> {
  prepareRecallEvalRestoredDb({
    manifest: input.manifest,
    restoredDbPath: input.restoredDbPath,
    legacySnapshot: input.options.legacySnapshot === true,
    derivedEvidenceProjectionRebuild:
      input.options.derivedEvidenceProjectionRebuild === true,
    ...(input.warm === null ? {} : { warmDerivedSnapshot: input.warm }),
    ...(input.snapshotBytePath === undefined ? {} : { snapshotBytePath: input.snapshotBytePath })
  });
  if (input.options.derivedEvidenceProjectionRebuild !== true) {
    return input.warm?.rebuildReport ?? null;
  }
  return rebuildEvidenceSearchProjectionsOnWorkingCopy({
    workingDbPath: input.restoredDbPath,
    ...(input.options.backfillMissingFactFrameFormations === true
      ? { backfillMissingFactFrameFormations: true }
      : {}),
    ...(input.options.factFrameRetrofitLedgerPath === undefined
      ? {}
      : { factFrameRetrofitLedgerPath: input.options.factFrameRetrofitLedgerPath }),
    ...(input.sourceExtractionSystemPromptSha256 === undefined
      ? {}
      : { sourceExtractionSystemPromptSha256: input.sourceExtractionSystemPromptSha256 })
  });
}

async function bindOverlayIfRequested(input: {
  readonly restoredDbPath: string;
  readonly options: RecallEvalOptions;
  readonly overlayExpected?: EmbeddingCacheOverlayExpectedSourceBinding;
}): Promise<EmbeddingCacheOverlayBinding | null> {
  if (input.options.embeddingCacheOverlayReceiptPath === undefined) return null;
  if (input.overlayExpected === undefined) {
    throw new Error("embedding cache overlay runtime binding is missing");
  }
  return applyEmbeddingCacheOverlay({
    receiptPath: input.options.embeddingCacheOverlayReceiptPath,
    restoredDbPath: input.restoredDbPath,
    expected: input.overlayExpected
  });
}

export function recallEvalWorkingDbPath(dataDirRoot: string): string {
  return join(dataDirRoot, "alaya.db");
}
