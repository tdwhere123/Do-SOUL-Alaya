import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShardArchiveRef } from "../../cli/merge-command-shards.js";
import type { ShardArchivedRunProvenance } from
  "../../cli/merge/shard-provenance-verifier.js";
import type { LongMemEvalWorkerShardPlan } from "../runner-concurrency.js";
import {
  selectionContractIdentity,
  type LongMemEvalSelectionContract,
  type LongMemEvalSelectionContractIdentity
} from "../selection/contract.js";
import {
  LONGMEMEVAL_RUN_PROVENANCE_FILENAME,
  isLongMemEvalRunProvenanceGateEligible,
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "./run.js";
import {
  LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME,
  type LoadedGlobalExtractionAuthority
} from "./extraction-authority-reference.js";

interface LoadedShardProvenance {
  readonly body: Buffer;
  readonly parsed: ShardArchivedRunProvenance;
  readonly gateEligible: boolean;
  readonly authorityReference: { readonly contents: string } | null;
}

export interface MergedRunProvenanceSidecars {
  readonly sidecars: readonly { readonly filename: string; readonly contents: string }[];
  readonly artifacts: readonly {
    readonly role: "run_provenance" | "shard_run_provenance" |
      "extraction_authority" | "fanout_authority" |
      "shard_extraction_authority_ref";
    readonly path: string;
    readonly contents: string;
  }[];
  readonly gateEligible: boolean;
  readonly selectionManifestSha256: string | null;
  readonly selectionContract: LongMemEvalSelectionContract | null;
  readonly executions: readonly LongMemEvalRunProvenance["execution"][];
  readonly globalExtractionAuthority: LoadedGlobalExtractionAuthority | null;
}

interface ReferenceSidecarSet {
  readonly valid: boolean;
  readonly global: LoadedGlobalExtractionAuthority | null;
  readonly sidecars: readonly { readonly filename: string; readonly contents: string }[];
}

export async function buildMergedRunProvenanceSidecars(input: {
  readonly shardArchiveRefs: readonly ShardArchiveRef[];
  readonly requestedConcurrency?: number;
  readonly selectionContract: LongMemEvalSelectionContract | null;
  readonly globalExtractionAuthority?: LoadedGlobalExtractionAuthority | null;
}): Promise<MergedRunProvenanceSidecars> {
  const loaded = await Promise.all(input.shardArchiveRefs.map(loadShardProvenance));
  const present = loaded.filter((item): item is LoadedShardProvenance => item !== null);
  if (present.length > 0 && present.length !== loaded.length) {
    throw new Error("merge refused: incomplete per-shard run provenance");
  }
  if (present.length > 0) validateShardSet(present, input.shardArchiveRefs);
  return buildSidecars(input, loaded, present);
}

export function resolveMergedRequestedConcurrency(input: {
  readonly requestedConcurrency?: number;
  readonly shardCount: number;
  readonly globalExtractionAuthority?: LoadedGlobalExtractionAuthority | null;
}): number | null {
  const requested = input.requestedConcurrency ?? null;
  const fanout = input.globalExtractionAuthority?.fanout?.authority ?? null;
  if (fanout !== null) {
    if (fanout.effective_concurrency !== input.shardCount ||
        fanout.plans.length !== input.shardCount) {
      throw new Error("merge refused: fanout concurrency differs from shard plan");
    }
    if (requested !== null && requested !== fanout.requested_concurrency) {
      throw new Error("merge refused: requested concurrency differs from fanout authority");
    }
    return fanout.requested_concurrency;
  }
  if (requested === null) return null;
  if (!Number.isSafeInteger(requested) || requested < input.shardCount || requested > 32) {
    throw new Error("merge refused: requested concurrency differs from shard plan");
  }
  return requested;
}

async function loadShardProvenance(
  shard: ShardArchiveRef
): Promise<LoadedShardProvenance | null> {
  const verified = shard.verifiedEvidence?.runProvenance;
  if (verified !== undefined) {
    return {
      body: Buffer.from(verified.contents, "utf8"),
      parsed: verified.parsed,
      gateEligible: verified.gateEligible,
      authorityReference: shard.verifiedEvidence?.extractionAuthorityReference ?? null
    };
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
    const parsed = LongMemEvalRunProvenanceSchema.parse(
      JSON.parse(body.toString("utf8"))
    );
    return {
      body,
      parsed,
      gateEligible: isLongMemEvalRunProvenanceGateEligible(parsed),
      authorityReference: null
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
  provenance: ShardArchivedRunProvenance,
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
  const references = buildReferenceSidecars(present, input.globalExtractionAuthority ?? null);
  const requestedConcurrency = resolveMergedRequestedConcurrency({
    requestedConcurrency: input.requestedConcurrency,
    shardCount: input.shardArchiveRefs.length,
    globalExtractionAuthority: references.global
  });
  const bindingComplete = present.length === loaded.length &&
    present.every((item) => item.gateEligible) && references.valid;
  const gateEligible = bindingComplete && requestedConcurrency !== null;
  const selectionContract = bindingComplete ? input.selectionContract : null;
  const aggregate = renderAggregate(
    input, loaded, gateEligible && selectionContract !== null, selectionContract,
    references, requestedConcurrency
  );
  const typedSidecars = buildTypedSidecars(aggregate, childSidecars, references);
  return {
    sidecars: typedSidecars.map(({ filename, contents }) => ({ filename, contents })),
    artifacts: typedSidecars.map((sidecar) => ({
      role: sidecar.role,
      path: sidecar.filename,
      contents: sidecar.contents
    })),
    gateEligible: gateEligible && selectionContract !== null,
    selectionManifestSha256: present[0]?.parsed.question_manifest?.file_sha256 ?? null,
    selectionContract,
    executions: present.map((item) => item.parsed.execution),
    globalExtractionAuthority: references.global
  };
}

function buildTypedSidecars(
  aggregate: string,
  childSidecars: readonly { readonly filename: string; readonly contents: string }[],
  references: ReferenceSidecarSet
): readonly {
  readonly role: MergedRunProvenanceSidecars["artifacts"][number]["role"];
  readonly filename: string;
  readonly contents: string;
}[] {
  return [
    {
      role: "run_provenance" as const,
      filename: LONGMEMEVAL_RUN_PROVENANCE_FILENAME,
      contents: aggregate
    },
    ...childSidecars.map((sidecar) => ({
      role: "shard_run_provenance" as const,
      ...sidecar
    })),
    ...references.sidecars.map((sidecar) => ({
      role: "shard_extraction_authority_ref" as const,
      ...sidecar
    })),
    ...authoritySidecars(references.global)
  ];
}

function renderAggregate(
  input: Parameters<typeof buildMergedRunProvenanceSidecars>[0],
  loaded: readonly (LoadedShardProvenance | null)[],
  gateEligible: boolean,
  selectionContract: LongMemEvalSelectionContract | null,
  references: ReferenceSidecarSet,
  requestedConcurrency: number | null
): string {
  const shards = loaded.map((item, index) => ({
    shard_index: index,
    source_slug: input.shardArchiveRefs[index]!.slug,
    filename: item === null ? null : shardFilename(index),
    sha256: item === null ? null : sha256(item.body),
    execution: item?.parsed.execution ?? null,
    extraction_authority_ref_filename: item === null || item.authorityReference === null
      ? null
      : references.sidecars[index]?.filename ?? null,
    extraction_authority_ref_sha256: item === null || item.authorityReference === null
      ? null
      : sha256(Buffer.from(item.authorityReference.contents, "utf8"))
  }));
  return `${JSON.stringify({
    schema_version: 1,
    kind: "longmemeval_sharded_run_provenance",
    gate_eligible: gateEligible,
    requested_concurrency: requestedConcurrency,
    effective_concurrency: input.shardArchiveRefs.length,
    evaluated_count: input.shardArchiveRefs.reduce((sum, shard) => sum + shard.payload.evaluated_count, 0),
    executed_dist: loaded[0]?.parsed.code.executed_dist ?? null,
    selection_contract: selectionContract === null
      ? null
      : selectionContractIdentity(selectionContract),
    extraction_authority: references.global?.descriptor ?? null,
    fanout_authority: references.global?.fanout?.descriptor ?? null,
    shards
  }, null, 2)}\n`;
}

export async function validateShardRunProvenancePlans(input: {
  readonly shardArchiveRefs: readonly ShardArchiveRef[];
  readonly plans: readonly LongMemEvalWorkerShardPlan[];
  readonly requestedConcurrency: number;
  readonly selectionContract: LongMemEvalSelectionContract | null;
  readonly globalExtractionAuthority?: LoadedGlobalExtractionAuthority | null;
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

function stableIdentity(provenance: ShardArchivedRunProvenance): string {
  return JSON.stringify({
    dataset_sha256: provenance.dataset_sha256,
    code: provenance.code,
    extraction_cache: provenance.extraction_cache,
    runtime: provenance.runtime,
    recall_config: provenance.recall_config,
    question_manifest: provenance.question_manifest
  });
}

function buildReferenceSidecars(
  shards: readonly LoadedShardProvenance[],
  global: LoadedGlobalExtractionAuthority | null
): ReferenceSidecarSet {
  const present = shards.filter((shard) => shard.authorityReference !== null);
  if (present.length === 0) return { valid: true, global: null, sidecars: [] };
  if (present.length !== shards.length || global === null ||
      global.fanout === null) {
    throw new Error("merge refused: incomplete compact shard extraction authority refs");
  }
  assertExactExpansionExecutions(shards.map((shard) => shard.parsed.execution));
  return {
    valid: true,
    global,
    sidecars: shards.map((shard, index) => ({
      filename: referenceFilename(index),
      contents: shard.authorityReference!.contents
    }))
  };
}

function assertExactExpansionExecutions(
  executions: readonly LongMemEvalRunProvenance["execution"][]
): void {
  let cursor = 0;
  for (const execution of executions) {
    if (execution.limit === null || execution.offset !== cursor ||
        execution.limit !== execution.evaluated_count) {
      throw new Error("merge refused: compact shard ranges have a gap or overlap");
    }
    cursor += execution.limit;
  }
  if (cursor !== 500) {
    throw new Error("merge refused: compact shards must cover exact [0,500)");
  }
}

function authoritySidecars(global: LoadedGlobalExtractionAuthority | null) {
  if (global === null) return [];
  const extraction = {
    role: "extraction_authority" as const,
    filename: LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME,
    contents: global.contents
  };
  if (global.fanout === null) return [extraction];
  return [extraction, {
    role: "fanout_authority" as const,
    filename: global.fanout.descriptor.path,
    contents: global.fanout.contents
  }];
}

function shardFilename(index: number): string {
  return `longmemeval-run-provenance.shard-${index}.json`;
}

function referenceFilename(index: number): string {
  return `longmemeval-extraction-authority-ref.shard-${index}.json`;
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}
