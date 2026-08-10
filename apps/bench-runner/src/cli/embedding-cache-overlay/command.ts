import process from "node:process";
import { resolveBenchEmbeddingProviderLabel } from
  "../../longmemeval/runner/runner-helpers.js";
import { resolveEmbeddingSupplementRuntimeProvenance } from
  "../../longmemeval/provenance/embedding/local-onnx.js";
import { withRecallEvalSnapshot } from
  "../../longmemeval/snapshot/recall-eval/recall-eval-loader.js";
import { buildExpectedEmbeddingCacheOverlayBinding } from
  "../../longmemeval/snapshot/recall-eval/embedding-cache-overlay/runtime-binding.js";
import { bindEmbeddingCacheOverlayDimensions } from
  "../../longmemeval/snapshot/recall-eval/embedding-cache-overlay/vector-space.js";
import { writeEmbeddingCacheOverlay } from
  "../../longmemeval/snapshot/recall-eval/embedding-cache-overlay/writer.js";
import type { ParsedFlags } from "../cli-options.js";

export async function runEmbeddingCacheOverlayBuildCommand(
  opts: ParsedFlags
): Promise<number> {
  if (opts.snapshot === undefined || opts.source === undefined || opts.snapshotOut === undefined) {
    process.stderr.write(
      "alaya-bench-runner embedding-cache-overlay-build: " +
      "--snapshot <db>, --source <warmed.db>, and --snapshot-out <receipt.json> required\n"
    );
    return 2;
  }
  const snapshotPath = opts.snapshot;
  const warmedDbPath = opts.source;
  const receiptPath = opts.snapshotOut;
  try {
    const providerLabel = resolveBenchEmbeddingProviderLabel(
      "env",
      process.env,
      opts.embeddingProviderKind
    );
    const supplement = await resolveEmbeddingSupplementRuntimeProvenance(
      "env",
      opts.embeddingProviderKind,
      process.env,
      providerLabel
    );
    const binding = await withRecallEvalSnapshot({
      snapshotDbPath: snapshotPath,
      variant: opts.variant,
      ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
      ...(opts.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: opts.pinnedMetaRoot })
    }, async (bundle) => {
      const expected = buildExpectedEmbeddingCacheOverlayBinding({
        manifest: bundle.manifest,
        snapshotManifestSha256: bundle.snapshotManifestSha256,
        embeddingSupplement: supplement
      });
      return writeEmbeddingCacheOverlay({
        warmedDbPath,
        receiptPath,
        source: bindEmbeddingCacheOverlayDimensions({
          warmedDbPath,
          expected
        })
      });
    });
    process.stdout.write(
      `Embedding cache overlay written: ${receiptPath}\n` +
      `  receipt_sha256=${binding.receipt_sha256}\n` +
      `  overlay_sha256=${binding.overlay_sha256}\n` +
      `  rows=${binding.memory_embedding_count}+${binding.evidence_embedding_count}\n` +
      `  vector_space=${binding.vector_space.provider_kind}:` +
      `${binding.vector_space.model_id}:v${binding.vector_space.schema_version}:` +
      `${binding.vector_space.dimensions}d\n`
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      "alaya-bench-runner embedding-cache-overlay-build: " +
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }
}
