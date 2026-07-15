import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShardArchiveRef } from "../../cli/merge-command-shards.js";
import type { LongMemEvalWorkerShardPlan } from "../runner-concurrency.js";
import {
  LONGMEMEVAL_RUN_PROVENANCE_FILENAME,
  isLongMemEvalRunProvenanceGateEligible,
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "./run.js";
import {
  selectionContractIdentity,
  type LongMemEvalSelectionContract,
  type LongMemEvalSelectionContractIdentity
} from "../selection/contract.js";

interface LoadedShardProvenance {
  readonly body: Buffer;
  readonly parsed: LongMemEvalRunProvenance;
}

export interface MergedRunProvenanceSidecars {
  readonly sidecars: readonly { readonly filename: string; readonly contents: string }[];
  readonly artifacts: readonly {
    readonly role: "run_provenance" | "shard_run_provenance";
    readonly path: string;
    readonly contents: string;
  }[];
  readonly gateEligible: boolean;
  readonly selectionManifestSha256: string | null;
  readonly selectionContract: LongMemEvalSelectionContract | null;
  readonly executions: readonly LongMemEvalRunProvenance["execution"][];
}

export async function buildMergedRunProvenanceSidecars(input: {
  readonly shardArchiveRefs: readonly ShardArchiveRef[];
  readonly requestedConcurrency?: number;
  readonly selectionContract: LongMemEvalSelectionContract | null;
}): Promise<MergedRunProvenanceSidecars> {
  const loaded = await Promise.all(input.shardArchiveRefs.map(loadShardProvenance));
  const present = loaded.filter((item): item is LoadedShardProvenance => item !== null);
  if (present.length > 0 && present.length !== loaded.length) {
    throw new Error("merge refused: incomplete per-shard run provenance");
  }
  if (present.length > 0) validateShardSet(present, input.shardArchiveRefs);
  return buildSidecars(input, loaded, present);
}

async function loadShardProvenance(
  shard: ShardArchiveRef
): Promise<LoadedShardProvenance | null> {
  const verified = shard.verifiedEvidence?.runProvenance;
  if (verified !== undefined) {
    return { body: Buffer.from(verified.contents, "utf8"), parsed: verified.parsed };
  }
  const source = join(shard.root, "public", shard.slug, LONGMEMEVAL_RUN_PROVENANCE_FILENAME);
  let body: Buffer;
  try {
    body = await readFile(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return {
      body,
      parsed: LongMemEvalRunProvenanceSchema.parse(JSON.parse(body.toString("utf8")))
    };
  } catch (error) {
    throw new Error(`merge refused: invalid shard run provenance at ${source}`, { cause: error });
  }
}

function validateShardSet(
  shards: readonly LoadedShardProvenance[],
  refs: readonly ShardArchiveRef[]
): void {
  const identity = stableIdentity(shards[0]!.parsed);
  for (const [index, shard] of shards.entries()) {
    if (stableIdentity(shard.parsed) !== identity) {
      throw new Error(`merge refused: shard ${index} run provenance is incoherent`);
    }
    validateExecution(shard.parsed, refs[index]!, index);
  }
  assertNonOverlappingExecutions(shards.map((shard) => shard.parsed.execution));
}

function validateExecution(
  provenance: LongMemEvalRunProvenance,
  ref: ShardArchiveRef,
  index: number
): void {
  const execution = provenance.execution;
  if (
    execution.evaluated_count !== ref.payload.evaluated_count ||
    (execution.limit !== null && execution.evaluated_count !== execution.limit) ||
    provenance.code.commit_sha7 !== ref.payload.alaya_commit
  ) {
    throw new Error(`merge refused: shard ${index} execution provenance mismatch`);
  }
}

function assertNonOverlappingExecutions(
  executions: readonly LongMemEvalRunProvenance["execution"][]
): void {
  const ranges = executions
    .filter((execution) => execution.limit !== null)
    .map((execution) => [execution.offset, execution.offset + execution.limit!] as const)
    .sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]![0] < ranges[index - 1]![1]) {
      throw new Error("merge refused: shard execution provenance ranges overlap");
    }
  }
}

function buildSidecars(
  input: Parameters<typeof buildMergedRunProvenanceSidecars>[0],
  loaded: readonly (LoadedShardProvenance | null)[],
  present: readonly LoadedShardProvenance[]
): MergedRunProvenanceSidecars {
  const childSidecars = present.map((item, index) => ({
    filename: shardFilename(index),
    contents: item.body.toString("utf8")
  }));
  const gateEligible = present.length === loaded.length && present.every((item) =>
    isLongMemEvalRunProvenanceGateEligible(item.parsed)
  );
  const selectionContract = gateEligible ? input.selectionContract : null;
  const aggregate = renderAggregate(
    input, loaded, gateEligible && selectionContract !== null, selectionContract
  );
  const sidecars = [{ filename: LONGMEMEVAL_RUN_PROVENANCE_FILENAME, contents: aggregate }, ...childSidecars];
  return {
    sidecars,
    artifacts: sidecars.map((sidecar, index) => ({
      role: index === 0 ? "run_provenance" as const : "shard_run_provenance" as const,
      path: sidecar.filename,
      contents: sidecar.contents
    })),
    gateEligible: gateEligible && selectionContract !== null,
    selectionManifestSha256: present[0]?.parsed.question_manifest?.file_sha256 ?? null,
    selectionContract,
    executions: present.map((item) => item.parsed.execution)
  };
}

function renderAggregate(
  input: Parameters<typeof buildMergedRunProvenanceSidecars>[0],
  loaded: readonly (LoadedShardProvenance | null)[],
  gateEligible: boolean,
  selectionContract: LongMemEvalSelectionContract | null
): string {
  const shards = loaded.map((item, index) => ({
    shard_index: index,
    source_slug: input.shardArchiveRefs[index]!.slug,
    filename: item === null ? null : shardFilename(index),
    sha256: item === null ? null : sha256(item.body),
    execution: item?.parsed.execution ?? null
  }));
  return `${JSON.stringify({
    schema_version: 1,
    kind: "longmemeval_sharded_run_provenance",
    gate_eligible: gateEligible,
    requested_concurrency: input.requestedConcurrency ?? null,
    effective_concurrency: input.shardArchiveRefs.length,
    evaluated_count: input.shardArchiveRefs.reduce((sum, shard) => sum + shard.payload.evaluated_count, 0),
    executed_dist: loaded[0]?.parsed.code.executed_dist ?? null,
    selection_contract: selectionContract === null
      ? null
      : selectionContractIdentity(selectionContract),
    shards
  }, null, 2)}\n`;
}

export async function validateShardRunProvenancePlans(input: {
  readonly shardArchiveRefs: readonly ShardArchiveRef[];
  readonly plans: readonly LongMemEvalWorkerShardPlan[];
  readonly requestedConcurrency: number;
  readonly selectionContract: LongMemEvalSelectionContract | null;
}): Promise<void> {
  if (input.shardArchiveRefs.length !== input.plans.length) {
    throw new Error("merge refused: shard provenance plan count mismatch");
  }
  const built = await buildMergedRunProvenanceSidecars(input);
  validatePlans(built.executions, input.plans);
}

function validatePlans(
  executions: readonly LongMemEvalRunProvenance["execution"][],
  plans: readonly LongMemEvalWorkerShardPlan[]
): void {
  for (const [index, execution] of executions.entries()) {
    const plan = plans[index]!;
    if (execution.offset !== plan.offset || execution.limit !== plan.limit) {
      throw new Error(`merge refused: shard ${index} execution provenance mismatch`);
    }
  }
}

function stableIdentity(provenance: LongMemEvalRunProvenance): string {
  return JSON.stringify({
    dataset_sha256: provenance.dataset_sha256,
    code: provenance.code,
    extraction_cache: provenance.extraction_cache,
    runtime: provenance.runtime,
    recall_config: provenance.recall_config,
    question_manifest: provenance.question_manifest
  });
}

function shardFilename(index: number): string {
  return `longmemeval-run-provenance.shard-${index}.json`;
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}
