import { createHash } from "node:crypto";
import {
  assertLongMemEvalProvenanceBinding,
  RunProvenanceBindingSchema
} from "../../gates/longmemeval-provenance-binding.js";
import {
  MergedRunProvenanceBindingSchema,
  type MergedRunProvenanceBinding
} from "../../gates/longmemeval-provenance-schemas.js";
import { hashLongMemEvalExpansionArtifact } from
  "../../gates/longmemeval-authority-wire.js";
import { createLongMemEvalSelectionContractIdentity } from
  "../../schema/longmemeval-selection-contract.js";
import type { KpiPayload } from "../../schema/kpi-schema.js";

const DATASET_SHA = "a".repeat(64);
const MANIFEST_SHA = "b".repeat(64);
const DIST_SHA = "c".repeat(64);
const AUTHORITY_PATH = "longmemeval-extraction-authority.json";
const FANOUT_PATH = "longmemeval-fanout-authority.json";
const RUN_NONCE = "11111111-1111-4111-8111-111111111111";

interface Artifact {
  readonly role: string;
  readonly path: string;
  readonly contents: string;
}

export interface CompactFixture {
  provenance: MergedRunProvenanceBinding;
  artifacts: Artifact[];
  readonly questionIds: readonly string[];
}

export function compactFixture(startOffset = 0): CompactFixture {
  const questionIds = Array.from({ length: 500 }, (_, index) => `q-${index}`);
  const authorityContents = renderAuthority();
  const extractionDescriptor = descriptor(AUTHORITY_PATH, authorityContents);
  const plans = shardPlans(startOffset);
  const fanoutContents = renderFanout(extractionDescriptor, plans);
  const fanoutDescriptor = descriptor(FANOUT_PATH, fanoutContents);
  const built = buildProvenance(
    questionIds,
    extractionDescriptor,
    fanoutDescriptor,
    plans
  );
  return {
    provenance: MergedRunProvenanceBindingSchema.parse(built.provenance),
    questionIds,
    artifacts: [
      ...built.children,
      ...built.references,
      { role: "extraction_authority", path: AUTHORITY_PATH, contents: authorityContents },
      { role: "fanout_authority", path: FANOUT_PATH, contents: fanoutContents }
    ]
  };
}

function buildProvenance(
  questionIds: readonly string[],
  extractionDescriptor: ReturnType<typeof descriptor>,
  fanoutDescriptor: ReturnType<typeof descriptor>,
  plans: ReturnType<typeof shardPlans>
) {
  let selectionCursor = 0;
  const children: Artifact[] = [];
  const references: Artifact[] = [];
  const shards = plans.map((plan) => {
    const selected = questionIds.slice(selectionCursor, selectionCursor + plan.limit);
    const execution = executionFor(plan);
    const childContents = `${JSON.stringify(childProvenance(selected, execution))}\n`;
    const filename = `longmemeval-run-provenance.shard-${plan.shard_index}.json`;
    const refContents = renderReference(
      extractionDescriptor,
      fanoutDescriptor,
      plan
    );
    const refFilename =
      `longmemeval-extraction-authority-ref.shard-${plan.shard_index}.json`;
    children.push({ role: "shard_run_provenance", path: filename, contents: childContents });
    references.push({
      role: "shard_extraction_authority_ref",
      path: refFilename,
      contents: refContents
    });
    selectionCursor += plan.limit;
    return {
      shard_index: plan.shard_index,
      source_slug: `shard-${plan.shard_index}`,
      filename,
      sha256: sha256(childContents),
      execution,
      extraction_authority_ref_filename: refFilename,
      extraction_authority_ref_sha256: sha256(refContents)
    };
  });
  return {
    provenance: {
      schema_version: 1 as const,
      kind: "longmemeval_sharded_run_provenance" as const,
      gate_eligible: true as const,
      requested_concurrency: 32,
      effective_concurrency: 32,
      evaluated_count: 500,
      executed_dist: { sha256: DIST_SHA },
      selection_contract: selectionIdentity(questionIds),
      extraction_authority: extractionDescriptor,
      fanout_authority: fanoutDescriptor,
      shards
    },
    children,
    references
  };
}

function childProvenance(
  questionIds: readonly string[],
  execution: ReturnType<typeof executionFor>
) {
  return {
    schema_version: 1,
    dataset_sha256: DATASET_SHA,
    selection: selectionIdentity(questionIds),
    code: runCode(),
    extraction_cache: compactExtractionSummary(),
    runtime: productRuntime(),
    execution,
    recall_config: {
      conf_slice_compatibility: false,
      schema_version: 2,
      max_results: 10,
      conflict_awareness: true,
      effective_config_sha256: "f".repeat(64)
    },
    seed_capabilities: { facet_tags_enabled: false },
    question_manifest: null
  };
}

function compactExtractionSummary() {
  const target = targetCache();
  const expansion = expansionIdentity();
  const shared = {
    ...expansion,
    source_snapshot: {
      db_path: "source.sqlite",
      manifest_sha256: "1".repeat(64),
      db_sha256: "2".repeat(64),
      sidecar_sha256: "3".repeat(64)
    },
    source_cache: sourceCache()
  };
  return {
    schema_version: 3 as const,
    manifest_sha256: MANIFEST_SHA,
    ...target,
    requested_turns: 1,
    cached_turns: 1,
    coverage: 1 as const,
    storage: "git-tracked" as const,
    built_at: "2026-07-17T00:00:00.000Z",
    builder: "fixture",
    fill_status: "complete" as const,
    content_closure_sha256: closureSha256(),
    expansion_source_anchor: {
      schema_version: 1 as const,
      kind: "longmemeval_100_to_500_source_anchor" as const,
      ...shared,
      target_cache: target
    },
    expansion_lineage: {
      schema_version: 1 as const,
      kind: "longmemeval_100_to_500_expansion" as const,
      ...shared,
      target_cache: { ...target, content_closure_sha256: closureSha256() }
    }
  };
}

function renderAuthority(): string {
  const summary = compactExtractionSummary();
  return `${JSON.stringify({
    schema_version: 1,
    source_manifest_schema_version: 3,
    source_manifest_sha256: MANIFEST_SHA,
    extraction_model: summary.extraction_model,
    model_family: summary.model_family,
    request_profile: summary.request_profile,
    system_prompt_sha256: summary.system_prompt_sha256,
    cache_key_algo: summary.cache_key_algo,
    dataset: summary.dataset,
    dataset_revision: summary.dataset_revision,
    requested_turns: summary.requested_turns,
    cached_turns: summary.cached_turns,
    coverage: 1,
    fill_status: "complete",
    window_offset: 0,
    window_limit: 500,
    expected_turns: 1,
    expected_key_set_sha256: summary.expected_key_set_sha256,
    content_closure_sha256: summary.content_closure_sha256,
    content_closure_index: { [cacheKey()]: ["3".repeat(64), 1, 1] },
    expansion_source_anchor_sha256: hashLongMemEvalExpansionArtifact(
      summary.expansion_source_anchor
    ),
    expansion_lineage_sha256: hashLongMemEvalExpansionArtifact(
      summary.expansion_lineage
    )
  })}\n`;
}

function renderFanout(
  extractionDescriptor: ReturnType<typeof descriptor>,
  plans: ReturnType<typeof shardPlans>
): string {
  const summary = compactExtractionSummary();
  const promotion = expansionIdentity();
  return `${JSON.stringify({
    schema_version: 1,
    kind: "longmemeval_parent_fanout_authority",
    run_nonce: RUN_NONCE,
    promotion,
    dataset: { variant: "longmemeval_s", sha256: DATASET_SHA },
    cache: {
      extraction_authority: extractionDescriptor,
      source_manifest_sha256: MANIFEST_SHA,
      content_closure_sha256: summary.content_closure_sha256,
      expansion_source_anchor_sha256: hashLongMemEvalExpansionArtifact(
        summary.expansion_source_anchor
      ),
      expansion_lineage_sha256: hashLongMemEvalExpansionArtifact(
        summary.expansion_lineage
      )
    },
    code: promotion.code,
    requested_concurrency: 32,
    effective_concurrency: 32,
    plans
  })}\n`;
}

function renderReference(
  extractionDescriptor: ReturnType<typeof descriptor>,
  fanoutDescriptor: ReturnType<typeof descriptor>,
  plan: ReturnType<typeof shardPlans>[number]
): string {
  return `${JSON.stringify({
    schema_version: 2,
    kind: "longmemeval_extraction_authority_ref",
    authority: extractionDescriptor,
    fanout: { ...fanoutDescriptor, run_nonce: RUN_NONCE },
    plan,
    source_manifest_sha256: MANIFEST_SHA
  })}\n`;
}

function expansionIdentity() {
  return {
    contract_sha256: "d".repeat(64),
    policy_version: "longmemeval-product-default-v1" as const,
    code: promotionCode(),
    source_selection: selectionIdentity(
      Array.from({ length: 100 }, (_, index) => `source-${index}`)
    ),
    next_selection: selectionIdentity(
      Array.from({ length: 500 }, (_, index) => `q-${index}`)
    ),
    matrix_sha256: "4".repeat(64),
    product_default: {
      cell: "B" as const,
      treatment: { embedding_supplement: true, answer_rerank: false },
      bundle_sha256: "5".repeat(64)
    }
  };
}

function runCode() {
  return {
    ...promotionCode(),
    gate_sha256: "d".repeat(64),
    gate_contract_path: "/tmp/promotion.json",
    worktree_clean: true
  };
}

function promotionCode() {
  return {
    commit_sha7: "abc1234",
    commit_sha: `abc1234${"0".repeat(33)}`,
    worktree_state_sha256: "e".repeat(64),
    executed_dist: {
      algorithm: "sha256-reachable-path-file-sha256-v1" as const,
      sha256: DIST_SHA,
      file_count: 1
    }
  };
}

function productRuntime() {
  const model = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
  const modelArtifactSha256 = "6".repeat(64);
  return {
    node_version: "v24.0.0",
    platform: "linux",
    arch: "x64",
    embedding_mode: "env" as const,
    embedding_provider_kind: "local_onnx" as const,
    embedding_provider_label: `local_onnx:${model}`,
    onnx_threads: null,
    onnx_model_artifact_sha256: modelArtifactSha256,
    embedding_supplement: {
      enabled: true,
      provider_kind: "local_onnx",
      effective_model_id: model,
      model_artifact_sha256: modelArtifactSha256,
      effective_schema_version: 1,
      d2q_input: "raw_content"
    },
    answer_rerank: { enabled: false },
    paired_env: {}
  };
}

function targetCache() {
  return {
    extraction_model: "fixture-model",
    model_family: "fixture-family",
    request_profile: "provider-default-v1" as const,
    provider_url: "redacted",
    system_prompt_sha256: "1".repeat(64),
    cache_key_algo: "sha256-content-v1",
    dataset: "longmemeval_s",
    dataset_revision: DATASET_SHA,
    window_offset: 0 as const,
    window_limit: 500 as const,
    expected_turns: 1,
    expected_key_set_sha256: sha256(cacheKey())
  };
}

function sourceCache() {
  return {
    manifest_sha256: "7".repeat(64),
    extraction_model: "fixture-model",
    model_family: "fixture-family",
    request_profile: "provider-default-v1" as const,
    provider_url: "redacted",
    system_prompt_sha256: "1".repeat(64),
    cache_key_algo: "sha256-content-v1",
    dataset: "longmemeval_s",
    dataset_revision: DATASET_SHA,
    window_offset: 0 as const,
    window_limit: 100 as const,
    expected_turns: 1,
    expected_key_set_sha256: "8".repeat(64),
    content_closure_sha256: "9".repeat(64)
  };
}

function shardPlans(startOffset: number) {
  let cursor = startOffset;
  return Array.from({ length: 32 }, (_, shard_index) => {
    const limit = shard_index < 20 ? 16 : 15;
    const plan = { shard_index, offset: cursor, limit };
    cursor += limit;
    return plan;
  });
}

function executionFor(plan: ReturnType<typeof shardPlans>[number]) {
  return {
    protocol: "sequential" as const,
    concurrency: 1 as const,
    offset: plan.offset,
    limit: plan.limit,
    evaluated_count: plan.limit
  };
}

function descriptor(path: string, contents: string) {
  return { path, sha256: sha256(contents), bytes: Buffer.byteLength(contents) };
}

export function verify(fixture: CompactFixture): void {
  const selection = selectionIdentity(fixture.questionIds);
  assertLongMemEvalProvenanceBinding({
    payload: {
      alaya_commit: "abc1234",
      evaluated_count: fixture.provenance.evaluated_count
    } as KpiPayload,
    manifest: { run: { dataset_sha256: DATASET_SHA, selection_contract: selection } },
    provenance: RunProvenanceBindingSchema.parse(fixture.provenance),
    cohort: {
      rows: fixture.questionIds.map((question_id) => ({
        question_id,
        dataset_cohort: "answerable" as const
      }))
    },
    artifacts: fixture.artifacts
  });
}

function selectionIdentity(questionIds: readonly string[]) {
  return createLongMemEvalSelectionContractIdentity({
    datasetSha256: DATASET_SHA,
    assignments: questionIds.map((question_id) => ({
      question_id,
      dataset_cohort: "answerable" as const
    }))
  });
}

function cacheKey(): string {
  return "2".repeat(64);
}

function closureSha256(): string {
  return sha256(JSON.stringify([
    cacheKey(), "fixture-model", "provider-default-v1", "3".repeat(64), 1, 1
  ]));
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}
