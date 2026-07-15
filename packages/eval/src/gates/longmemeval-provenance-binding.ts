import { createHash } from "node:crypto";
import { z } from "zod";
import type { KpiPayload } from "../schema/kpi-schema.js";
import {
  createLongMemEvalSelectionContractIdentity,
  LongMemEvalSelectionContractIdentitySchema,
  type LongMemEvalSelectionAssignment,
  type LongMemEvalSelectionContractIdentity
} from "../schema/longmemeval-selection-contract.js";
import { canonicalJson } from "./canonical-json.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const SingleRunProvenanceBindingSchema = z.object({
  schema_version: z.literal(1),
  dataset_sha256: Sha256Schema,
  selection: LongMemEvalSelectionContractIdentitySchema,
  code: z.object({
    commit_sha7: z.string().min(7),
    commit_sha: z.string().regex(/^[a-f0-9]{40}$/u),
    gate_sha256: Sha256Schema,
    gate_contract_path: z.string().min(1),
    worktree_state_sha256: Sha256Schema,
    worktree_clean: z.literal(true),
    executed_dist: z.object({ sha256: Sha256Schema }).passthrough()
  }).passthrough(),
  extraction_cache: z.object({
    dataset_revision: Sha256Schema,
    requested_turns: z.number().int().nonnegative(),
    cached_turns: z.number().int().nonnegative(),
    coverage: z.literal(1)
  }).passthrough(),
  execution: z.object({ evaluated_count: z.number().int().nonnegative() }).passthrough(),
  recall_config: z.object({
    schema_version: z.literal(2),
    max_results: z.number().int().positive(),
    conflict_awareness: z.boolean(),
    effective_config_sha256: Sha256Schema
  }).passthrough()
}).passthrough();

const MergedRunProvenanceBindingSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("longmemeval_sharded_run_provenance"),
  gate_eligible: z.literal(true),
  evaluated_count: z.number().int().nonnegative(),
  executed_dist: z.object({ sha256: Sha256Schema }).passthrough(),
  selection_contract: LongMemEvalSelectionContractIdentitySchema,
  shards: z.array(z.object({
    filename: z.string().min(1),
    sha256: Sha256Schema,
    execution: z.object({
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      evaluated_count: z.number().int().nonnegative()
    }).passthrough()
  }).passthrough())
}).passthrough();

export const RunProvenanceBindingSchema = z.union([
  SingleRunProvenanceBindingSchema,
  MergedRunProvenanceBindingSchema
]);

export type RunProvenanceBinding = z.infer<typeof RunProvenanceBindingSchema>;

interface EvidenceArtifact {
  readonly role: string;
  readonly path: string;
  readonly contents?: string | Uint8Array;
}

interface EvidenceManifestIdentity {
  readonly run: {
    readonly dataset_sha256: string;
    readonly selection_contract: LongMemEvalSelectionContractIdentity;
  };
}

interface CohortIdentity {
  readonly rows: readonly {
    readonly question_id: string;
    readonly dataset_cohort: "answerable" | "abstention";
  }[];
}

export function assertLongMemEvalProvenanceBinding(input: {
  readonly payload: KpiPayload;
  readonly manifest: EvidenceManifestIdentity;
  readonly provenance: RunProvenanceBinding;
  readonly cohort: CohortIdentity;
  readonly artifacts: readonly EvidenceArtifact[];
}): void {
  if (input.provenance.kind === "longmemeval_sharded_run_provenance") {
    assertMergedProvenanceBinding({
      ...input,
      provenance: MergedRunProvenanceBindingSchema.parse(input.provenance)
    });
    return;
  }
  assertSingleProvenanceBinding(
    input.payload,
    input.manifest,
    SingleRunProvenanceBindingSchema.parse(input.provenance)
  );
}

function assertSingleProvenanceBinding(
  payload: KpiPayload,
  manifest: EvidenceManifestIdentity,
  provenance: z.infer<typeof SingleRunProvenanceBindingSchema>
): void {
  if (provenance.code.commit_sha7 !== payload.alaya_commit ||
      !provenance.code.commit_sha.startsWith(payload.alaya_commit) ||
      provenance.dataset_sha256 !== manifest.run.dataset_sha256 ||
      provenance.extraction_cache.dataset_revision !== provenance.dataset_sha256 ||
      provenance.extraction_cache.cached_turns < provenance.extraction_cache.requested_turns ||
      provenance.execution.evaluated_count !== payload.evaluated_count) {
    throw new Error("run provenance is not release-bound to KPI evidence");
  }
}

function assertMergedProvenanceBinding(input: {
  readonly payload: KpiPayload;
  readonly manifest: EvidenceManifestIdentity;
  readonly provenance: z.infer<typeof MergedRunProvenanceBindingSchema>;
  readonly cohort: CohortIdentity;
  readonly artifacts: readonly EvidenceArtifact[];
}): void {
  const shardArtifacts = input.artifacts.filter((item) =>
    item.role === "shard_run_provenance"
  );
  if (input.provenance.evaluated_count !== input.payload.evaluated_count ||
      canonicalJson(input.provenance.selection_contract) !==
        canonicalJson(input.manifest.run.selection_contract) ||
      shardArtifacts.length !== input.provenance.shards.length) {
    throw new Error("merged run provenance summary differs from KPI evidence");
  }
  const shards = loadChildProvenance(input.provenance, shardArtifacts);
  const expectedSelections = expectedChildSelections(input);
  const stableIdentity = childStableIdentity(shards[0]!);
  for (const [index, shard] of shards.entries()) {
    const plan = input.provenance.shards[index]!;
    if (shard.dataset_sha256 !== input.manifest.run.dataset_sha256 ||
        shard.code.executed_dist.sha256 !== input.provenance.executed_dist.sha256 ||
        canonicalJson(shard.execution) !== canonicalJson(plan.execution) ||
        canonicalJson(shard.selection) !== canonicalJson(expectedSelections[index]) ||
        childStableIdentity(shard) !== stableIdentity) {
      throw new Error("merged child provenance differs from canonical shard plan");
    }
    if (index > 0) assertContiguousPlan(input.provenance.shards, index);
  }
}

function loadChildProvenance(
  provenance: z.infer<typeof MergedRunProvenanceBindingSchema>,
  artifacts: readonly EvidenceArtifact[]
): Array<z.infer<typeof SingleRunProvenanceBindingSchema>> {
  return artifacts.map((artifact, index) => {
    const plan = provenance.shards[index];
    if (plan === undefined || artifact.path !== plan.filename ||
        artifactSha256(artifact) !== plan.sha256) {
      throw new Error("merged run provenance shard artifact order differs");
    }
    return SingleRunProvenanceBindingSchema.parse(parseArtifactJson(artifact));
  });
}

function expectedChildSelections(input: {
  readonly manifest: EvidenceManifestIdentity;
  readonly provenance: z.infer<typeof MergedRunProvenanceBindingSchema>;
  readonly cohort: CohortIdentity;
}): LongMemEvalSelectionContractIdentity[] {
  const assignments: LongMemEvalSelectionAssignment[] = input.cohort.rows.map((row) => ({
    question_id: row.question_id,
    dataset_cohort: row.dataset_cohort
  }));
  let cursor = 0;
  const selections = input.provenance.shards.map((shard) => {
    const count = shard.execution.evaluated_count;
    if (shard.execution.limit !== count) {
      throw new Error("merged child provenance differs from canonical shard plan");
    }
    const selected = assignments.slice(cursor, cursor + count);
    cursor += count;
    return createLongMemEvalSelectionContractIdentity({
      datasetSha256: input.manifest.run.dataset_sha256,
      assignments: selected
    });
  });
  if (cursor !== assignments.length) {
    throw new Error("merged run provenance summary differs from KPI evidence");
  }
  return selections;
}

function assertContiguousPlan(
  shards: z.infer<typeof MergedRunProvenanceBindingSchema>["shards"],
  index: number
): void {
  const current = shards[index]!.execution;
  const previous = shards[index - 1]!.execution;
  if (current.offset !== previous.offset + previous.limit) {
    throw new Error("merged child provenance ranges are not contiguous");
  }
}

function childStableIdentity(
  provenance: z.infer<typeof SingleRunProvenanceBindingSchema>
): string {
  return canonicalJson({
    dataset_sha256: provenance.dataset_sha256,
    code: provenance.code,
    extraction_cache: provenance.extraction_cache,
    runtime: provenance.runtime,
    recall_config: provenance.recall_config,
    question_manifest: provenance.question_manifest
  });
}

function parseArtifactJson(artifact: EvidenceArtifact): unknown {
  if (artifact.contents === undefined) {
    throw new Error(`missing ${artifact.role} artifact bytes`);
  }
  return JSON.parse(artifactText(artifact)) as unknown;
}

function artifactSha256(artifact: EvidenceArtifact): string {
  return createHash("sha256").update(artifactBytes(artifact)).digest("hex");
}

function artifactText(artifact: EvidenceArtifact): string {
  return Buffer.from(artifactBytes(artifact)).toString("utf8");
}

function artifactBytes(artifact: EvidenceArtifact): Uint8Array {
  if (artifact.contents === undefined) {
    throw new Error(`missing ${artifact.role} artifact bytes`);
  }
  return typeof artifact.contents === "string"
    ? Buffer.from(artifact.contents, "utf8")
    : artifact.contents;
}
