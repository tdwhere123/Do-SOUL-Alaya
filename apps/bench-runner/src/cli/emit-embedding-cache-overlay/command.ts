import process from "node:process";
import { emitProductOverlayForSnapshot } from
  "../../bench/snapshot/recall-eval/embedding-cache-overlay/product-emit.js";
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
    const binding = await emitProductOverlayForSnapshot({
      snapshotDbPath: parsed.snapshot,
      receiptPath: parsed.receipt
    });
    process.stdout.write(
      `Done. Overlay receipt: ${parsed.receipt}\n` +
        `  memory_embeddings=${binding.memory_embedding_count}\n` +
        `  evidence_embeddings=${binding.evidence_embedding_count}\n`
    );
    return 0;
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
