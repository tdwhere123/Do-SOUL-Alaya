import { vi, type Mock } from "vitest";
import type { CompileSeedExtractionConfig } from
  "../../longmemeval/compile-seed-types.js";
import type { ExtractionFillCompletion } from
  "../../longmemeval/extraction/fill-completion.js";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";
import type {
  LoadedLongMemEvalDataset,
  VerifiedLongMemEvalDatasetAuthority
} from "../../longmemeval/fetch.js";
import type { ExtractionCacheManifestIdentity } from
  "../../longmemeval/extraction-cache-manifest.js";
import { syntheticExtractionClosure } from "./extraction-closure-fixture.js";

export interface ExpansionFillAuthorityFixtureState {
  identity: ExtractionCacheManifestIdentity | undefined;
  dataset: LoadedLongMemEvalDataset;
  config: CompileSeedExtractionConfig & { readonly modelFamily: string };
  sourceCompletion: ExtractionFillCompletion;
  targetCompletion: ExtractionFillCompletion;
  verifyIntegrity: Mock;
  substrateBinding: Mock;
  seedLedgerBinding: Mock;
}

const state = vi.hoisted<ExpansionFillAuthorityFixtureState>(() => ({
  identity: undefined,
  dataset: datasetFixture(),
  config: {
    providerUrl: "https://provider.example/v1",
    model: "gpt-5.4-mini",
    modelFamily: "gpt-5.4-mini",
    requestProfile: "provider-default-v1" as const,
    apiKey: "test-key"
  },
  sourceCompletion: {
    expectedTurns: 100, validTurns: 100, missingTurns: 0,
    invalidTurns: 0, orphanTurns: 0, coverage: 1,
    expectedKeySetSha256: "7".repeat(64),
    contentClosureSha256: "9".repeat(64)
  } as ExtractionFillCompletion,
  targetCompletion: {
    expectedTurns: 500, validTurns: 100, missingTurns: 400,
    invalidTurns: 0, orphanTurns: 0, coverage: 0.2,
    expectedKeySetSha256: "8".repeat(64),
    contentClosureSha256: null as string | null
  } as ExtractionFillCompletion,
  verifyIntegrity: vi.fn(),
  substrateBinding: vi.fn(),
  seedLedgerBinding: vi.fn()
}));

vi.mock("../../longmemeval/fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../longmemeval/fetch.js")>(),
  loadDatasetWithIdentity: vi.fn(async () => state.dataset)
}));
vi.mock("../../longmemeval/extraction-cache-manifest.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../longmemeval/extraction-cache-manifest.js")>(),
  readExtractionCacheManifestIdentity: vi.fn(() => state.identity)
}));
vi.mock("../../longmemeval/compile-seed-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../longmemeval/compile-seed-config.js")>(),
  resolveCompileSeedExtractionConfig: vi.fn(() => state.config)
}));
vi.mock("../../longmemeval/extraction/fill-completion.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../longmemeval/extraction/fill-completion.js")>(),
  inspectExtractionFillCompletion: vi.fn((input: { turnContents: readonly string[] }) =>
    input.turnContents.length === 100 ? state.sourceCompletion : state.targetCompletion)
}));
vi.mock("../../longmemeval/snapshot/integrity.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../longmemeval/snapshot/integrity.js")>(),
  verifySnapshotArtifactIntegrity: state.verifyIntegrity
}));
vi.mock("../../longmemeval/snapshot/substrate-binding.js", () => ({
  assertSnapshotDatasetSubstrateIdentity: state.substrateBinding
}));
vi.mock("../../longmemeval/snapshot/seed-ledger-binding.js", () => ({
  assertSnapshotSeedLedgerBinding: state.seedLedgerBinding
}));

import {
  prepareExpansionFillAuthority,
  type PreparedExpansionFillAuthority
} from "../../longmemeval/extraction/expansion-fill-authority.js";
import {
  buildLongMemEvalMatrixPromotionAuthorization,
  hashPromotionMatrix
} from "../../longmemeval/promotion/authorization.js";
import {
  parseLongMemEvalMatrixPromotionContract
} from "../../longmemeval/promotion/contract.js";
import {
  verifyLongMemEvalExpansionCapability,
  type LongMemEvalExpansionCapability,
  type LongMemEvalSourceSnapshotAuthority
} from "../../longmemeval/promotion/expansion-capability.js";
import { buildLongMemEvalExpansionLineage } from
  "../../longmemeval/promotion/expansion-lineage.js";
import {
  createLongMemEvalSelectionContract,
  selectionContractIdentity
} from "../../longmemeval/selection/contract.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256,
  type ExtractionCacheManifestV3
} from "../../longmemeval/extraction-cache-manifest.js";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { redactProvenanceUrl } from
  "../../longmemeval/provenance/paired-environment.js";
import type { LongMemEvalExpansionSourceAnchor } from
  "../../longmemeval/promotion/expansion-source-anchor-schema.js";
import { longMemEvalExpansionCapabilityData } from
  "../../longmemeval/promotion/expansion-capability.js";
import type { RecallEvalSnapshotBundle } from
  "../../longmemeval/snapshot/recall-eval-loader.js";
import {
  buildSnapshotExtractionAuthority,
  buildSnapshotExtractionSummary
} from "../../longmemeval/snapshot/extraction-authority.js";
import { canonicalProductRecallProvenanceConfig } from
  "../../longmemeval/promotion/product-policy-verifier.js";
import {
  expansionHardGateFixture,
  expansionPromotionContractFixture
} from "./expansion-promotion-contract-fixture.js";


function resetExpansionFillAuthorityFixture(): void {
  state.config = {
    providerUrl: "https://provider.example/v1",
    model: "gpt-5.4-mini",
    modelFamily: "gpt-5.4-mini",
    requestProfile: "provider-default-v1",
    apiKey: "test-key"
  };
  state.dataset = datasetFixture();
  state.sourceCompletion = completion(100, 100, "7", "9");
  state.targetCompletion = completion(500, 100, "8", null);
  state.identity = {
    manifestSha256: "a".repeat(64),
    manifest: sourceManifest()
  };
  state.verifyIntegrity.mockReset();
  state.substrateBinding.mockReset();
  state.seedLedgerBinding.mockReset();
}

async function prepare(
  capabilityPromise: Promise<LongMemEvalExpansionCapability>
): Promise<PreparedExpansionFillAuthority> {
  return prepareExpansionFillAuthority({
    variant: "longmemeval_s",
    expansionCapability: await capabilityPromise
  }, "/cache").then((result) => result!);
}

interface CompleteExpansionFixture {
  readonly capability: LongMemEvalExpansionCapability;
  readonly manifest: ExtractionCacheManifestV3;
}

async function completeExpansionFixture(): Promise<CompleteExpansionFixture> {
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

function recallBundle(
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

function targetManifest(
  anchor: LongMemEvalExpansionSourceAnchor,
  status: "in_progress" | "complete" = "in_progress"
): ExtractionCacheManifestV3 {
  const complete = status === "complete";
  const closure = closureFixture(500);
  const {
    content_closure_sha256: _contentClosureSha256,
    content_closure_index: _contentClosureIndex,
    ...source
  } = sourceManifest();
  return {
    ...source,
    fill_status: status,
    window_limit: 500,
    expected_turns: closure.expected_turns,
    expected_key_set_sha256: closure.expected_key_set_sha256,
    requested_turns: 500,
    cached_turns: complete ? 500 : 100,
    coverage: complete ? 1 : 0.2,
    ...(complete ? {
      content_closure_sha256: closure.content_closure_sha256,
      content_closure_index: closure.content_closure_index
    } : {}),
    expansion_source_anchor: anchor
  };
}

function sourceManifest(): ExtractionCacheManifestV3 {
  const closure = closureFixture(100);
  return {
    schema_version: 3,
    extraction_model: state.config.model,
    model_family: state.config.modelFamily,
    request_profile: state.config.requestProfile,
    provider_url: state.config.providerUrl,
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: "d".repeat(64),
    requested_turns: 100,
    cached_turns: 100,
    coverage: 1,
    fill_status: "complete",
    window_offset: 0,
    window_limit: 100,
    ...closure,
    storage: "git-tracked",
    built_at: "2026-07-16T00:00:00.000Z",
    builder: "extraction-fill"
  };
}

function datasetFixture(): LoadedLongMemEvalDataset {
  const questions = Array.from({ length: 500 }, (_, index) => question(index));
  return {
    questions,
    sha256: "d".repeat(64),
    checksumSource: "/dataset.meta.json",
    sourcePath: "/dataset.json",
    promotionAuthority: {} as VerifiedLongMemEvalDatasetAuthority
  };
}

function question(index: number): LongMemEvalQuestion {
  return {
    question_id: `question-${index + 1}`,
    question_type: "single-session-user",
    question: `question ${index + 1}`,
    answer: `answer ${index + 1}`,
    question_date: "2026-01-01",
    haystack_session_ids: [`session-${index + 1}`],
    haystack_dates: ["2026-01-01"],
    haystack_sessions: [[{ role: "user", content: `turn ${index + 1}` }]],
    answer_session_ids: [`session-${index + 1}`]
  };
}

async function mintCapability(
  sourceManifestSha = "a".repeat(64)
): Promise<LongMemEvalExpansionCapability> {
  const contract = expansionPromotionContractFixture();
  const contents = Buffer.from(JSON.stringify(contract), "utf8");
  const parsed = parseLongMemEvalMatrixPromotionContract(contents);
  const labels = ["A", "B", "C", "D"] as const;
  const cells = contract.matrix.entries.map((entry, index) => ({
    cell: labels[index]!,
    treatment: entry.treatment,
    evidence_root: entry.evidence_root,
    bundle_sha256: String(index + 1).repeat(64)
  }));
  const sourceSelection = selection(state.dataset.questions.slice(0, 100));
  const nextSelection = selection(state.dataset.questions);
  const authorization = buildLongMemEvalMatrixPromotionAuthorization({
    schema_version: 1,
    kind: "longmemeval_matrix_promotion_authorization",
    status: "authorized",
    contract_sha256: parsed.sha256,
    policy_version: contract.policy_version,
    source_selection: sourceSelection,
    next_selection: nextSelection,
    matrix: { sha256: hashPromotionMatrix(cells), cells },
    product_default: {
      cell: "B",
      treatment: cells[1]!.treatment,
      bundle_sha256: cells[1]!.bundle_sha256
    },
    hard_gates: [expansionHardGateFixture()]
  });
  return verifyLongMemEvalExpansionCapability({
    checkoutRoot: "/repo",
    contractPath: "/evidence/contract.json",
    contractRoot: "/evidence",
    contractContents: contents
  }, {
    authorize: async () => authorization,
    readSourceSnapshotAuthority: async () => sourceAuthority(sourceManifestSha),
    resolveFrozenCodeIdentity: async () => ({
      commitSha: contract.code.commit_sha,
      commitSha7: contract.code.commit_sha7,
      gateContractPath: "/evidence/contract.json",
      gateSha256: parsed.sha256,
      worktreeStateSha256: contract.code.worktree_state_sha256,
      worktreeClean: true
    }),
    computeExecutedDistIdentity: async () => contract.code.executed_dist
  });
}

function sourceAuthority(manifestSha256: string): LongMemEvalSourceSnapshotAuthority {
  const closure = closureFixture(100);
  return {
    dbPath: "snapshot/source-100.db",
    manifestSha256: "f".repeat(64),
    dbSha256: "e".repeat(64),
    sidecarSha256: "1".repeat(64),
    extractionCache: {
      manifestSha256,
      extractionModel: state.config.model,
      modelFamily: state.config.modelFamily,
      requestProfile: state.config.requestProfile,
      providerUrl: redactProvenanceUrl(state.config.providerUrl),
      systemPromptSha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
      cacheKeyAlgo: EXTRACTION_CACHE_KEY_ALGO,
      dataset: "longmemeval-s",
      datasetRevision: "d".repeat(64),
      windowOffset: 0,
      windowLimit: 100,
      expectedTurns: closure.expected_turns,
      expectedKeySetSha256: closure.expected_key_set_sha256,
      contentClosureSha256: closure.content_closure_sha256
    }
  };
}

function selection(questions: readonly LongMemEvalQuestion[]) {
  return selectionContractIdentity(createLongMemEvalSelectionContract({
    datasetSha256: "d".repeat(64),
    questions
  }));
}

function completion(
  expected: number,
  valid: number,
  key: string,
  closure: string | null
): ExtractionFillCompletion {
  const exact = closureFixture(expected);
  const canonicalKey = expected === 100 ? "7" : "8";
  const canonicalClosure = expected === 100 ? "9" : "6";
  return {
    expectedTurns: expected,
    validTurns: valid,
    missingTurns: expected - valid,
    invalidTurns: 0,
    orphanTurns: 0,
    coverage: valid / expected,
    expectedKeySetSha256: key === canonicalKey
      ? exact.expected_key_set_sha256
      : key.repeat(64),
    contentClosureSha256: closure === null
      ? null
      : closure === canonicalClosure
        ? exact.content_closure_sha256
        : closure.repeat(64),
    contentClosureIndex: valid === expected && closure !== null
      ? exact.content_closure_index
      : null
  };
}

function closureFixture(expected: number) {
  return syntheticExtractionClosure({
    count: expected,
    model: state.config.model,
    requestProfile: state.config.requestProfile,
    seed: expected === 100 ? "expansion-source" : "expansion-target"
  });
}

export {
  buildLongMemEvalExpansionLineage,
  completion,
  completeExpansionFixture,
  datasetFixture,
  mintCapability,
  prepare,
  recallBundle,
  resetExpansionFillAuthorityFixture,
  state,
  targetManifest
};
