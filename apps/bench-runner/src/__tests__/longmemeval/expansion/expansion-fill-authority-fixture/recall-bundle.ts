import type { ExtractionCacheManifestV3 } from
  "../../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import { buildLongMemEvalExpansionLineage } from
  "../../../../longmemeval/promotion/expansion/lineage/expansion-lineage.js";
import {
  longMemEvalExpansionCapabilityData,
  type LongMemEvalExpansionCapability
} from "../../../../longmemeval/promotion/expansion/expansion-capability.js";
import type { RecallEvalSnapshotBundle } from
  "../../../../longmemeval/snapshot/recall-eval/recall-eval-loader.js";
import {
  buildSnapshotExtractionAuthority,
  buildSnapshotExtractionSummary
} from "../../../../longmemeval/snapshot/extraction-authority.js";
import { canonicalProductRecallProvenanceConfig } from
  "../../../../longmemeval/promotion/verifiers/product-policy-verifier.js";
import { completion, state, targetManifest } from "./fixture.js";
import { mintCapability, prepare } from "./capability.js";

interface CompleteExpansionFixture {
  readonly capability: LongMemEvalExpansionCapability;
  readonly manifest: ExtractionCacheManifestV3;
}

export async function completeExpansionFixture(): Promise<CompleteExpansionFixture> {
  const capability = await mintCapability();
  const prepared = await prepare(Promise.resolve(capability));
  state.targetCompletion = completion(500, 500, "8", "6");
  const base = targetManifest(prepared.sourceAnchor, "complete");
  const lineage = buildLongMemEvalExpansionLineage(
    capability,
    state.targetCompletion,
    base
  );
  return {
    capability,
    manifest: { ...base, expansion_lineage: lineage }
  };
}

export function recallBundle(
  fixture: CompleteExpansionFixture
): RecallEvalSnapshotBundle {
  const data = longMemEvalExpansionCapabilityData(fixture.capability);
  const manifest = fixture.manifest as ExtractionCacheManifestV3;
  const manifestSha256 = "b".repeat(64);
  const extraction = buildSnapshotExtractionSummary(manifest, manifestSha256);
  const runExtraction = {
    ...extraction,
    storage: manifest.storage,
    built_at: manifest.built_at,
    builder: manifest.builder
  };
  const extractionAuthority = buildSnapshotExtractionAuthority(
    manifest,
    manifestSha256,
    extraction
  );
  return {
    snapshotDbPath: "/bound/target.db",
    manifest: {
      schema_version: 2,
      variant: "longmemeval_s",
      question_count: 500,
      recall_pipeline_version: "test",
      schema_migration_version: 1,
      bench_runner_version: "test",
      alaya_commit: data.code.commit_sha7,
      db_filename: "target.db",
      sidecar_filename: "target.db.sidecar.json",
      extraction_provenance: extraction,
      seed_extraction_path: seedExtractionPath(),
      artifact_integrity: {
        db_sha256: "e".repeat(64),
        sidecar_sha256: "1".repeat(64)
      },
      run_provenance: {
        schema_version: 1,
        dataset_sha256: data.nextSelection.dataset_sha256,
        selection: data.nextSelection,
        code: {
          ...data.code,
          gate_sha256: "a".repeat(64),
          gate_contract_path: "/fixture/promotion-contract.json",
          worktree_clean: true
        },
        extraction_cache: runExtraction,
        runtime: {
          node_version: process.version,
          platform: process.platform,
          arch: process.arch,
          embedding_mode: "disabled",
          embedding_provider_kind: "local_onnx",
          embedding_provider_label: "none",
          onnx_threads: null,
          embedding_supplement: { enabled: false },
          answer_rerank: { enabled: false },
          paired_env: {
            ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false",
            ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "false"
          }
        },
        execution: {
          protocol: "sequential",
          concurrency: 1,
          offset: 0,
          limit: null,
          evaluated_count: 500
        },
        recall_config: canonicalProductRecallProvenanceConfig(),
        seed_capabilities: { facet_tags_enabled: false },
        question_manifest: null
      },
      question_id_digest: data.nextSelection.selected_id_digest,
      dataset_sha256: data.nextSelection.dataset_sha256,
      attribution: { status: "attributed", gate_eligible: true }
    },
    sidecar: {
      schema_version: 2,
      variant: "longmemeval_s",
      questions: Array.from({ length: 500 }, (_, index) => ({
        questionId: `question-${index + 1}`
      }))
    },
    snapshotManifestSha256: "f".repeat(64),
    datasetSha256: null,
    extractionAuthority
  } as unknown as RecallEvalSnapshotBundle;
}

function seedExtractionPath() {
  return {
    path: "official_api_compile" as const,
    extraction_attempts: 500,
    cache_hits: 500,
    llm_calls: 0,
    offline_fallbacks: 0,
    live_extraction_failures: 0,
    cached_extraction_failures: 0,
    facts_produced: 500,
    signals_dropped: 0,
    parse_dropped: 0,
    compile_overflow_dropped: 0,
    signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
  };
}
