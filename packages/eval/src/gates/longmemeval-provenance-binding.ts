import { createHash } from "node:crypto";
import { z } from "zod";
import type { KpiPayload } from "../schema/kpi-schema.js";
import {
  createLongMemEvalSelectionContractIdentity,
  type LongMemEvalSelectionAssignment,
  type LongMemEvalSelectionContractIdentity
} from "../schema/longmemeval-selection-contract.js";
import { canonicalJson } from "./canonical-json.js";
import {
  LongMemEvalFanoutAuthoritySchema,
  LongMemEvalShardAuthorityReferenceSchema,
  assertLongMemEvalExtractionAuthorityIntegrity,
  assertLongMemEvalExpansionBinding,
  assertLongMemEvalFanoutAuthorityBinding,
  assertLongMemEvalFanoutReferenceBinding,
  assertLongMemEvalFullExtractionClosure,
  hydrateLongMemEvalExtractionAuthority,
  type LongMemEvalArtifactDescriptor,
  type LongMemEvalExtractionAuthority,
  type LongMemEvalFanoutAuthority
} from "./longmemeval-authority-wire.js";
import {
  MergedRunProvenanceBindingSchema,
  SingleRunProvenanceBindingSchema,
  type MergedRunProvenanceBinding,
  type RunProvenanceBinding,
  type SingleRunProvenanceBinding
} from "./longmemeval-provenance-schemas.js";

export { RunProvenanceBindingSchema } from
  "./longmemeval-provenance-schemas.js";
export type { RunProvenanceBinding } from
  "./longmemeval-provenance-schemas.js";

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
    SingleRunProvenanceBindingSchema.parse(input.provenance),
    input.artifacts
  );
}

function assertSingleProvenanceBinding(
  payload: KpiPayload,
  manifest: EvidenceManifestIdentity,
  provenance: SingleRunProvenanceBinding,
  artifacts: readonly EvidenceArtifact[]
): void {
  if (provenance.code.commit_sha7 !== payload.alaya_commit ||
      !provenance.code.commit_sha.startsWith(payload.alaya_commit) ||
      provenance.dataset_sha256 !== manifest.run.dataset_sha256 ||
      provenance.extraction_cache.dataset_revision !== provenance.dataset_sha256 ||
      provenance.extraction_cache.cached_turns < provenance.extraction_cache.requested_turns ||
      provenance.execution.evaluated_count !== payload.evaluated_count) {
    throw new Error("run provenance is not release-bound to KPI evidence");
  }
  assertLongMemEvalFullExtractionClosure(provenance.extraction_cache);
  const orphanAuthority = artifacts.some((artifact) =>
    artifact.role === "extraction_authority" ||
    artifact.role === "fanout_authority" ||
    artifact.role === "shard_extraction_authority_ref"
  );
  if (orphanAuthority) {
    throw new Error("single-run evidence rejects orphan compact authority artifacts");
  }
  if (payload.evaluated_count === 500 &&
      provenance.extraction_cache.expansion_lineage !== undefined) {
    assertProductBRun(provenance, payload.alaya_commit, true);
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
  assertMerged500ParentAuthority(input.payload, input.provenance);
  const loadedShards = loadChildProvenance(input.provenance, shardArtifacts);
  const shards = bindMergedExtractionAuthority(input, loadedShards);
  const expectedSelections = expectedChildSelections(input);
  const stableIdentity = childStableIdentity(shards[0]!);
  for (const [index, shard] of shards.entries()) {
    const plan = input.provenance.shards[index]!;
    if (shard.dataset_sha256 !== input.manifest.run.dataset_sha256 ||
        shard.code.commit_sha7 !== input.payload.alaya_commit ||
        !shard.code.commit_sha.startsWith(input.payload.alaya_commit) ||
        shard.code.executed_dist.sha256 !== input.provenance.executed_dist.sha256 ||
        canonicalJson(shard.execution) !== canonicalJson(plan.execution) ||
        canonicalJson(shard.selection) !== canonicalJson(expectedSelections[index]) ||
        childStableIdentity(shard) !== stableIdentity) {
      throw new Error("merged child provenance differs from canonical shard plan");
    }
    if (input.payload.evaluated_count === 500 &&
        input.provenance.fanout_authority !== null) {
      assertProductBRun(shard, input.payload.alaya_commit, false);
    }
    if (index > 0) assertContiguousPlan(input.provenance.shards, index);
  }
}

function assertMerged500ParentAuthority(
  payload: KpiPayload,
  provenance: MergedRunProvenanceBinding
): void {
  if (payload.evaluated_count === 500 &&
      (provenance.extraction_authority === null ||
        provenance.fanout_authority === null)) {
    throw new Error("merged 500Q evidence requires compact parent authorities");
  }
}

function bindMergedExtractionAuthority(
  input: Parameters<typeof assertMergedProvenanceBinding>[0],
  shards: readonly SingleRunProvenanceBinding[]
): SingleRunProvenanceBinding[] {
  const authorityArtifacts = artifactsByRole(input.artifacts, "extraction_authority");
  const fanoutArtifacts = artifactsByRole(input.artifacts, "fanout_authority");
  const referenceArtifacts = artifactsByRole(
    input.artifacts,
    "shard_extraction_authority_ref"
  );
  const descriptor = input.provenance.extraction_authority;
  const fanoutDescriptor = input.provenance.fanout_authority;
  if (descriptor === null && fanoutDescriptor === null) {
    assertNoCompactAuthority(
      input.provenance, shards,
      [...authorityArtifacts, ...fanoutArtifacts], referenceArtifacts
    );
    shards.forEach((shard) =>
      assertLongMemEvalFullExtractionClosure(shard.extraction_cache));
    return [...shards];
  }
  if (descriptor === null || fanoutDescriptor === null ||
      authorityArtifacts.length !== 1 || fanoutArtifacts.length !== 1 ||
      referenceArtifacts.length !== shards.length) {
    throw new Error("merged compact provenance has incomplete parent authority");
  }
  const authorityArtifact = authorityArtifacts[0]!;
  const fanoutArtifact = fanoutArtifacts[0]!;
  assertArtifactDescriptor(authorityArtifact, descriptor);
  assertArtifactDescriptor(fanoutArtifact, fanoutDescriptor);
  const authority = assertLongMemEvalExtractionAuthorityIntegrity(
    parseArtifactJson(authorityArtifact)
  );
  const fanout = LongMemEvalFanoutAuthoritySchema.parse(
    parseArtifactJson(fanoutArtifact)
  );
  assertFanoutAggregate(input.provenance, fanout);
  return shards.map((shard, index) => bindCompactShard({
    plan: input.provenance.shards[index]!,
    shard,
    referenceArtifact: referenceArtifacts[index]!,
    descriptor,
    authority,
    fanoutDescriptor,
    fanout
  }));
}

function assertNoCompactAuthority(
  provenance: MergedRunProvenanceBinding,
  shards: readonly SingleRunProvenanceBinding[],
  authorityArtifacts: readonly EvidenceArtifact[],
  referenceArtifacts: readonly EvidenceArtifact[]
): void {
  const planHasReference = provenance.shards.some((shard) =>
    shard.extraction_authority_ref_filename != null ||
    shard.extraction_authority_ref_sha256 != null
  );
  const compactChild = shards.some((shard) =>
    !("content_closure_index" in shard.extraction_cache)
  );
  if (authorityArtifacts.length > 0 || referenceArtifacts.length > 0 ||
      planHasReference || compactChild) {
    throw new Error("merged extraction authority descriptor is missing");
  }
}

function bindCompactShard(input: {
  readonly plan: MergedRunProvenanceBinding["shards"][number];
  readonly shard: SingleRunProvenanceBinding;
  readonly referenceArtifact: EvidenceArtifact;
  readonly descriptor: LongMemEvalArtifactDescriptor;
  readonly authority: LongMemEvalExtractionAuthority;
  readonly fanoutDescriptor: LongMemEvalArtifactDescriptor;
  readonly fanout: LongMemEvalFanoutAuthority;
}): SingleRunProvenanceBinding {
  if (input.plan.extraction_authority_ref_filename !== input.referenceArtifact.path ||
      input.plan.extraction_authority_ref_sha256 !==
        artifactSha256(input.referenceArtifact)) {
    throw new Error("merged extraction authority reference order differs");
  }
  const reference = LongMemEvalShardAuthorityReferenceSchema.parse(
    parseArtifactJson(input.referenceArtifact)
  );
  assertLongMemEvalFanoutAuthorityBinding({
    fanout: input.fanout,
    authority: input.authority,
    compact: input.shard.extraction_cache,
    extractionDescriptor: input.descriptor
  });
  assertLongMemEvalFanoutReferenceBinding({
    reference,
    fanout: input.fanout,
    fanoutDescriptor: input.fanoutDescriptor,
    extractionDescriptor: input.descriptor,
    sourceManifestSha256: input.authority.source_manifest_sha256
  });
  if (reference.plan.offset !== input.plan.execution.offset ||
      reference.plan.limit !== input.plan.execution.limit ||
      input.shard.code.commit_sha !== input.fanout.code.commit_sha ||
      input.shard.code.worktree_state_sha256 !==
        input.fanout.code.worktree_state_sha256 ||
      input.shard.code.gate_sha256 !== input.fanout.promotion.contract_sha256 ||
      canonicalJson(input.shard.code.executed_dist) !==
        canonicalJson(input.fanout.code.executed_dist)) {
    throw new Error("merged child execution differs from parent fanout plan");
  }
  const hydrated = SingleRunProvenanceBindingSchema.parse(
    hydrateLongMemEvalExtractionAuthority({
      compact: input.shard,
      authority: input.authority
    })
  );
  assertLongMemEvalFullExtractionClosure(hydrated.extraction_cache);
  return hydrated;
}

function assertFanoutAggregate(
  provenance: MergedRunProvenanceBinding,
  fanout: LongMemEvalFanoutAuthority
): void {
  if (provenance.requested_concurrency !== fanout.requested_concurrency ||
      provenance.effective_concurrency !== fanout.effective_concurrency ||
      provenance.shards.length !== fanout.plans.length ||
      provenance.executed_dist.sha256 !== fanout.code.executed_dist.sha256) {
    throw new Error("merged provenance differs from parent fanout authority");
  }
}

function assertArtifactDescriptor(
  artifact: EvidenceArtifact,
  descriptor: LongMemEvalArtifactDescriptor
): void {
  if (artifact.path !== descriptor.path ||
      artifactSha256(artifact) !== descriptor.sha256 ||
      artifactBytes(artifact).byteLength !== descriptor.bytes) {
    throw new Error("merged extraction authority artifact differs from descriptor");
  }
}

function artifactsByRole(
  artifacts: readonly EvidenceArtifact[],
  role: string
): EvidenceArtifact[] {
  return artifacts.filter((artifact) => artifact.role === role);
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

function assertProductBRun(
  provenance: SingleRunProvenanceBinding,
  commitSha7: string,
  requireFullSelection: boolean
): void {
  const runtime = provenance.runtime;
  const bi = ProductBiEncoderRuntimeSchema.safeParse(runtime.embedding_supplement);
  const cross = ProductCrossEncoderRuntimeSchema.safeParse(runtime.answer_rerank);
  if (!bi.success || !cross.success) {
    throw new Error("500Q run provenance differs from product-B runtime defaults");
  }
  assertLongMemEvalExpansionBinding(provenance.extraction_cache, {
    code: {
      commit_sha: provenance.code.commit_sha,
      commit_sha7: provenance.code.commit_sha7,
      worktree_state_sha256: provenance.code.worktree_state_sha256,
      executed_dist: provenance.code.executed_dist
    }
  });
  if ((requireFullSelection && provenance.selection.selected_count !== 500) ||
      provenance.code.commit_sha7 !== commitSha7 ||
      provenance.extraction_cache.window_offset !== 0 ||
      provenance.extraction_cache.window_limit !== 500 ||
      runtime.embedding_mode !== "env" ||
      runtime.embedding_provider_kind !== "local_onnx" ||
      runtime.embedding_provider_label !== `local_onnx:${PRODUCT_BI_MODEL}` ||
      runtime.onnx_threads !== null || bi.data.effective_model_id !== PRODUCT_BI_MODEL ||
      runtime.onnx_model_artifact_sha256 !== bi.data.model_artifact_sha256 ||
      cross.data.enabled !== false || provenance.recall_config.schema_version !== 2 ||
      provenance.recall_config.max_results !== 10 ||
      provenance.recall_config.conflict_awareness !== true ||
      provenance.recall_config.conf_slice_compatibility !== false ||
      provenance.seed_capabilities?.facet_tags_enabled !== false ||
      provenance.question_manifest !== null) {
    throw new Error("500Q run provenance differs from product-B runtime defaults");
  }
}

const PRODUCT_BI_MODEL =
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const ProductBiEncoderRuntimeSchema = z.object({
  enabled: z.literal(true),
  provider_kind: z.literal("local_onnx"),
  effective_model_id: z.literal(PRODUCT_BI_MODEL),
  model_artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  effective_schema_version: z.literal(1),
  d2q_input: z.literal("raw_content")
}).strict();
const ProductCrossEncoderRuntimeSchema = z.object({
  enabled: z.literal(false)
}).strict();

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
