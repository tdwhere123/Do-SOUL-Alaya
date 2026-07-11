import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LongMemEvalWorkerShardPlan } from "../runner-concurrency.js";
import {
  LONGMEMEVAL_RUN_PROVENANCE_FILENAME,
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "./run.js";

interface ShardArchiveRef {
  readonly root: string;
  readonly slug: string;
}

interface LoadedShardProvenance {
  readonly body: Buffer;
  readonly parsed: LongMemEvalRunProvenance;
}

export async function preserveShardRunProvenance(input: {
  readonly shardArchiveRefs: readonly ShardArchiveRef[];
  readonly plans: readonly LongMemEvalWorkerShardPlan[];
  readonly mergedArchiveRoot: string;
  readonly requestedConcurrency: number;
}): Promise<void> {
  if (input.shardArchiveRefs.length !== input.plans.length) {
    throw new Error("merge refused: shard provenance plan count mismatch");
  }
  const loaded = await Promise.all(input.shardArchiveRefs.map(loadShardProvenance));
  const present = loaded.filter((item): item is LoadedShardProvenance => item !== null);
  if (present.length > 0 && present.length !== loaded.length) {
    throw new Error("merge refused: incomplete per-shard run provenance");
  }
  if (present.length > 0) validateShardSet(present, input.plans);
  await copyShardBodies(loaded, input.mergedArchiveRoot);
  await writeAggregate(input, loaded, present.length > 0);
}

async function loadShardProvenance(
  shard: ShardArchiveRef
): Promise<LoadedShardProvenance | null> {
  const source = join(
    shard.root,
    "public",
    shard.slug,
    LONGMEMEVAL_RUN_PROVENANCE_FILENAME
  );
  let body: Buffer;
  try {
    body = await readFile(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return { body, parsed: LongMemEvalRunProvenanceSchema.parse(JSON.parse(body.toString("utf8"))) };
  } catch (error) {
    throw new Error(`merge refused: invalid shard run provenance at ${source}`, { cause: error });
  }
}

function validateShardSet(
  shards: readonly LoadedShardProvenance[],
  plans: readonly LongMemEvalWorkerShardPlan[]
): void {
  const identity = stableIdentity(shards[0]!.parsed);
  for (const [index, shard] of shards.entries()) {
    const plan = plans[index]!;
    if (stableIdentity(shard.parsed) !== identity) {
      throw new Error(`merge refused: shard ${index} run provenance is incoherent`);
    }
    if (
      shard.parsed.execution.offset !== plan.offset ||
      shard.parsed.execution.limit !== plan.limit ||
      shard.parsed.execution.evaluated_count !== plan.limit
    ) throw new Error(`merge refused: shard ${index} execution provenance mismatch`);
  }
}

function stableIdentity(provenance: LongMemEvalRunProvenance): string {
  return JSON.stringify({
    code: provenance.code,
    extraction_cache: provenance.extraction_cache,
    runtime: provenance.runtime,
    recall_config: provenance.recall_config,
    question_manifest: provenance.question_manifest
  });
}

async function copyShardBodies(
  loaded: readonly (LoadedShardProvenance | null)[],
  mergedRoot: string
): Promise<void> {
  await Promise.all(loaded.map(async (item, index) => {
    if (item === null) return;
    const destination = join(mergedRoot, shardFilename(index));
    await writeFile(destination, item.body);
    if (!(await readFile(destination)).equals(item.body)) {
      throw new Error(`merge refused: shard ${index} provenance copy mismatch`);
    }
  }));
}

async function writeAggregate(
  input: Parameters<typeof preserveShardRunProvenance>[0],
  loaded: readonly (LoadedShardProvenance | null)[],
  complete: boolean
): Promise<void> {
  const gateEligible = complete && loaded.every((item) =>
    item !== null && isShardGateEligible(item.parsed)
  );
  const shards = loaded.map((item, index) => ({
    shard_index: index,
    filename: shardFilename(index),
    sha256: item === null ? null : createHash("sha256").update(item.body).digest("hex")
  }));
  const aggregate = {
    schema_version: 1,
    kind: "longmemeval_sharded_run_provenance",
    gate_eligible: gateEligible,
    requested_concurrency: input.requestedConcurrency,
    effective_concurrency: input.plans.length,
    shards
  };
  await writeFile(
    join(input.mergedArchiveRoot, LONGMEMEVAL_RUN_PROVENANCE_FILENAME),
    `${JSON.stringify(aggregate, null, 2)}\n`,
    "utf8"
  );
}

function isShardGateEligible(provenance: LongMemEvalRunProvenance): boolean {
  const cache = provenance.extraction_cache;
  return (
    provenance.code.gate_sha256 !== null &&
    provenance.code.worktree_state_sha256 !== null &&
    cache !== null &&
    cache.requested_turns !== undefined &&
    cache.cached_turns !== undefined &&
    cache.coverage === 1 &&
    cache.cached_turns >= cache.requested_turns &&
    (provenance.runtime.embedding_provider_kind !== "local_onnx" ||
      provenance.runtime.onnx_model_artifact_sha256 !== undefined)
  );
}

function shardFilename(index: number): string {
  return `longmemeval-run-provenance.shard-${index}.json`;
}
