import { pct } from "./result-format.js";
import { writeMergedLongMemEvalArchive } from "./merge-command-archive.js";
import {
  buildMergedLongMemEvalPayload,
  loadMergeShards
} from "./merge-command-shards.js";
import { exitCodeForMergedLongMemEvalResult } from "./merge-shared.js";

export interface MergeLongMemEvalCommandOptions {
  readonly historyRoot: string;
  readonly shards?: readonly string[];
}

/**
 * @anchor merge-longmemeval — combine N shard kpi.jsons into one final entry
 */
export async function runMergeLongMemEvalCommand(
  opts: MergeLongMemEvalCommandOptions
): Promise<number> {
  try {
    const shards = opts.shards ?? [];
    if (shards.length === 0) {
      process.stderr.write(
        "alaya-bench-runner merge-longmemeval: --shards <dir1> <dir2> ... required\n"
      );
      return 2;
    }

    process.stdout.write(`Merging ${shards.length} shard(s)...\n`);
    const loaded = await loadMergeShards(shards);
    const build = buildMergedLongMemEvalPayload(loaded);
    const archive = await writeMergedLongMemEvalArchive({
      historyRoot: opts.historyRoot,
      build,
      shardArchiveRefs: loaded.archiveRefs
    });

    process.stdout.write(
      `Merged ${shards.length} shards -> slug ${archive.slug}\n` +
        `  evaluated=${archive.merged.evaluated_count} R@1=${pct(build.rAt1)} R@5=${pct(build.rAt5)} R@10=${pct(build.rAt10)}\n` +
        (build.hasExactMergedLatency
          ? `  latency p50=${build.latencyP50}ms p95=${build.latencyP95}ms\n`
          : `  latency p50<=${build.latencyP50}ms p95<=${build.latencyP95}ms (worst-shard upper bound)\n`) +
        `  KPI: ${archive.kpiPath}\n`
    );
    return exitCodeForMergedLongMemEvalResult(archive.merged);
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner merge-longmemeval: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}
