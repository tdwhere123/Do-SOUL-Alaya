import process from "node:process";
import { LOCAL_ONNX_EMBEDDING_DIMENSIONS } from "@do-soul/alaya-core";
import {
  bindOverlaySourceFromSnapshot,
  createProductOverlayEmbeddingProvider,
  emitEmbeddingCacheOverlay
} from "../../bench/snapshot/recall-eval/embedding-cache-overlay/emit.js";
import { resolveEmbeddingSupplementRuntimeProvenance } from
  "../../bench/provenance/embedding/local-onnx.js";
import { recallEvalEmbeddingMode } from
  "../../bench/lifecycle/recall-eval/recall-eval-runtime.js";
import {
  matchFlagToken,
  nextIndex,
  readRequiredFlagValue
} from "../options/flag-values.js";

export async function runEmitEmbeddingCacheOverlayCommand(
  args: ReadonlyArray<string>
): Promise<number> {
  try {
    const parsed = parseArgs(args);
    const env = process.env;
    if (recallEvalEmbeddingMode(env) !== "env") {
      throw new Error("emit-embedding-cache-overlay requires embedding admission");
    }
    const provider = createProductOverlayEmbeddingProvider(env);
    try {
      const supplement = await resolveEmbeddingSupplementRuntimeProvenance(
        "env",
        "local_onnx",
        env
      );
      if (!supplement.enabled || supplement.provider_kind !== "local_onnx") {
        throw new Error("emit-embedding-cache-overlay requires product local_onnx");
      }
      const source = await bindOverlaySourceFromSnapshot({
        snapshotDbPath: parsed.snapshot,
        provider,
        dimensions: LOCAL_ONNX_EMBEDDING_DIMENSIONS,
        modelArtifactSha256: supplement.model_artifact_sha256
      });
      const binding = await emitEmbeddingCacheOverlay({
        snapshotDbPath: parsed.snapshot,
        receiptPath: parsed.receipt,
        provider,
        source
      });
      process.stdout.write(
        `Done. Overlay receipt: ${parsed.receipt}\n` +
          `  memory_embeddings=${binding.memory_embedding_count}\n` +
          `  evidence_embeddings=${binding.evidence_embedding_count}\n`
      );
      return 0;
    } finally {
      await provider.close();
    }
  } catch (error) {
    process.stderr.write(
      `alaya-bench-runner emit-embedding-cache-overlay: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return 2;
  }
}

function parseArgs(args: ReadonlyArray<string>): {
  readonly snapshot: string;
  readonly receipt: string;
} {
  let snapshot: string | undefined;
  let receipt: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (matchFlagToken(token, "--snapshot")) {
      snapshot = readRequiredFlagValue(
        args, index, token, "--snapshot",
        "--snapshot requires a database path"
      );
      index = nextIndex(index, token);
      continue;
    }
    if (matchFlagToken(token, "--receipt")) {
      receipt = readRequiredFlagValue(
        args, index, token, "--receipt",
        "--receipt requires a JSON path"
      );
      index = nextIndex(index, token);
      continue;
    }
    throw new Error(`unknown emit-embedding-cache-overlay flag '${token}'`);
  }
  if (snapshot === undefined || receipt === undefined) {
    throw new Error("--snapshot <db> and --receipt <json> are required");
  }
  return { snapshot, receipt };
}
