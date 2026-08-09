import process from "node:process";
import { fillQuerySemanticFactorCache } from
  "../../longmemeval/query-factors/query-semantic-factor-cache.js";
import type { ParsedFlags } from "../cli-options.js";

export async function runQuerySemanticFactorCacheFillCommand(
  opts: ParsedFlags
): Promise<number> {
  if (opts.snapshot === undefined || opts.querySemanticFactorCache === undefined) {
    process.stderr.write(
      "alaya-bench-runner query-semantic-factor-cache-fill: --snapshot and " +
      "--query-semantic-factor-cache are required\n"
    );
    return 2;
  }
  if (opts.limit !== undefined || opts.offset !== undefined) {
    process.stderr.write(
      "alaya-bench-runner query-semantic-factor-cache-fill: snapshot query set " +
      "cannot be sliced; materialize a separately bounded snapshot\n"
    );
    return 2;
  }
  try {
    process.stdout.write("Filling immutable query semantic factor cache...\n");
    const binding = await fillQuerySemanticFactorCache({
      snapshot_db_path: opts.snapshot,
      output_path: opts.querySemanticFactorCache,
      ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
      log: (line) => process.stdout.write(`${line}\n`)
    });
    process.stdout.write(
      `Done. entries=${binding.entry_count} ` +
      `cache_sha256=${binding.cache_content_sha256} ` +
      `prompt_sha256=${binding.system_prompt_sha256}\n`
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      "alaya-bench-runner query-semantic-factor-cache-fill: " +
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }
}
