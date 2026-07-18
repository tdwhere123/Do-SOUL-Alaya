import { isDeepStrictEqual } from "node:util";
import { isCacheOnlySeedExtractionPath } from "@do-soul/alaya-eval";
import { hashLongMemEvalSupplementalSourceBinding } from
  "@do-soul/alaya-eval/internal";
import type { BenchRecallWeightOverrides } from
  "../../../../harness/recall/recall-weight-overrides.js";
import { ALAYA_RECALL_WEIGHT_OVERRIDES_ENV } from
  "../../../../harness/recall/recall-weight-overrides.js";
import type { RecallEvalOptions } from "../../../lifecycle/recall-eval/recall-eval-contract.js";
import { readRecallEvalMaxResults } from
  "../../../provenance/effective-recall-config.js";
import type { RecallEvalSnapshotBundle } from "../../../snapshot/recall-eval/recall-eval-loader.js";
import { verifySnapshotArtifactIntegrity } from "../../../snapshot/integrity.js";
import { assertSnapshotDatasetSubstrateIdentity } from
  "../../../snapshot/substrate-binding.js";
import { assertSnapshotSeedLedgerBinding } from
  "../../../snapshot/seed-ledger/seed-ledger-binding.js";
import type { SnapshotExtractionProvenanceV3 } from "../../../snapshot/materialize.js";
import { assertCacheOnlyEnvironment } from "./expansion-snapshot-authority.js";
import { assertSnapshotExtractionAuthorityBinding } from
  "../../../snapshot/extraction-authority.js";
import { bindSnapshotRunProvenanceAuthority } from
  "../../../snapshot/run-provenance.js";
import { isLongMemEvalRunProvenanceGateEligible } from
  "../../../provenance/run.js";
import {
  longMemEvalExpansionCapabilityData,
  type LongMemEvalExpansionCapability
} from "../expansion-capability.js";
import { assertLongMemEvalExpansionLineageMatchesCapability } from
  "../lineage/expansion-lineage.js";
import { assertLongMemEvalExpansionSourceAnchor } from
  "../lineage/expansion-source-anchor.js";
import { loadCanonicalLongMemEvalExpansionSelection } from
  "../expansion-selection.js";
import { assertProductFormationEnvironment } from
  "../../product/product-formation-policy.js";
import { assertProductDefaultBiEncoderEnvironment } from
  "../../product/product-bi-encoder-policy.js";
import { assertPromotionSnapshotProducerPolicy } from
  "../../verifiers/snapshot-producer-policy-verifier.js";
import { assertProductDefaultRecallEnvironment } from
  "../../verifiers/product-policy-verifier.js";

type RunExtractionCacheV3 = Extract<NonNullable<NonNullable<
  RecallEvalSnapshotBundle["manifest"]["run_provenance"]
>["extraction_cache"]>, { readonly schema_version: 3 }>;

export async function assertExpansionRecallAuthority(input: {
  readonly options: RecallEvalOptions;
  readonly bundle: RecallEvalSnapshotBundle;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  const full500 = input.options.variant === "longmemeval_s" &&
    input.bundle.sidecar.questions.length === 500;
  if (!full500) {
    assertCapabilityAbsent(input.options.expansionCapability);
    return;
  }
  const capability = requireCapability(input.options.expansionCapability);
  assertRecallInvocation(input, capability);
  const selection = await loadCanonicalLongMemEvalExpansionSelection({
    capability,
    variant: "longmemeval_s",
    dataDir: input.options.dataDir,
    pinnedMetaRoot: input.options.pinnedMetaRoot
  });
  await verifyExpansionSnapshotAuthority(input, capability, selection);
}

async function verifyExpansionSnapshotAuthority(
  input: Parameters<typeof assertExpansionRecallAuthority>[0],
  capability: LongMemEvalExpansionCapability,
  selection: Awaited<ReturnType<
    typeof loadCanonicalLongMemEvalExpansionSelection
  >>
): Promise<void> {
  const extraction = assertSnapshotExpansionManifest(
    input.bundle,
    capability
  );
  const extractionAuthority = input.bundle.extractionAuthority;
  if (extractionAuthority === null) {
    throw new Error("500Q recall requires bound extraction authority");
  }
  assertSnapshotExtractionAuthorityBinding(extractionAuthority, extraction);
  const compactRunProvenance = input.bundle.manifest.run_provenance;
  if (compactRunProvenance === undefined ||
      !isLongMemEvalRunProvenanceGateEligible(
        bindSnapshotRunProvenanceAuthority(
          compactRunProvenance,
          extractionAuthority
        )
      )) {
    throw new Error("500Q recall requires complete snapshot run authority");
  }
  await verifySnapshotArtifactIntegrity(
    input.bundle.snapshotDbPath,
    input.bundle.manifest.artifact_integrity!
  );
  assertSnapshotDatasetSubstrateIdentity({
    dbPath: input.bundle.snapshotDbPath,
    sidecar: input.bundle.sidecar,
    questions: selection.nextQuestions
  });
  assertSnapshotSeedLedgerBinding({
    dbPath: input.bundle.snapshotDbPath,
    sidecar: input.bundle.sidecar,
    questions: selection.nextQuestions,
    extraction,
    extractionAuthority,
    seedExtractionPath: input.bundle.manifest.seed_extraction_path,
    closureAuthority: {
      kind: "exact",
      questionWindow: { offset: 0, limit: selection.nextQuestions.length }
    }
  });
}

function assertRecallInvocation(
  input: Parameters<typeof assertExpansionRecallAuthority>[0],
  capability: LongMemEvalExpansionCapability
): void {
  const { options, env } = input;
  const product = longMemEvalExpansionCapabilityData(capability).productDefault;
  if (options.legacySnapshot === true ||
      options.weightOverridesJson !== undefined ||
      input.recallWeightOverrides !== undefined ||
      env[ALAYA_RECALL_WEIGHT_OVERRIDES_ENV] !== undefined ||
      (options.policyShape ?? "stress") !== "stress" ||
      (options.simulateReport ?? "none") !== "none" ||
      product.cell !== "B" || !product.treatment.embedding_supplement ||
      product.treatment.answer_rerank) {
    throw new Error("500Q recall invocation differs from the promoted product-B contract");
  }
  assertFullRecallWindow(options);
  assertRecallEnvironment(env, input.recallWeightOverrides);
}

function assertFullRecallWindow(options: RecallEvalOptions): void {
  if (options.offset !== undefined || options.limit !== undefined) {
    throw new Error("500Q recall-eval requires an unsliced full snapshot");
  }
}

function assertRecallEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined
): void {
  assertCacheOnlyEnvironment(env);
  assertProductFormationEnvironment(env, "500Q product-B recall formation");
  assertProductDefaultBiEncoderEnvironment(env, "500Q product-B recall");
  assertProductDefaultRecallEnvironment(
    env,
    {
      maxResults: readRecallEvalMaxResults(env.ALAYA_RECALL_EVAL_MAX_RESULTS),
      conflictAwareness: true
    },
    recallWeightOverrides,
    "500Q product-B recall"
  );
  const embedding = env.ALAYA_RECALL_EVAL_EMBEDDING?.trim().toLowerCase();
  const cross = env.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK?.trim().toLowerCase();
  const facets = env.ALAYA_RECALL_FACET_TAGS?.trim().toLowerCase();
  if (embedding !== "env" || (cross !== undefined &&
      !["0", "false", "off", "no"].includes(cross)) ||
      ["1", "true", "on", "yes"].includes(facets ?? "") ||
      readRecallEvalMaxResults(env.ALAYA_RECALL_EVAL_MAX_RESULTS) !== 10) {
    throw new Error("500Q recall environment differs from product-B defaults");
  }
}

function assertSnapshotExpansionManifest(
  bundle: RecallEvalSnapshotBundle,
  capability: LongMemEvalExpansionCapability
): SnapshotExtractionProvenanceV3 {
  const manifest = bundle.manifest;
  const data = longMemEvalExpansionCapabilityData(capability);
  const extraction = manifest.extraction_provenance;
  const runProvenance = manifest.run_provenance;
  const runCache = runProvenance?.extraction_cache;
  if (manifest.variant !== "longmemeval_s" || manifest.question_count !== 500 ||
      manifest.dataset_sha256 !== data.nextSelection.dataset_sha256 ||
      manifest.attribution?.gate_eligible !== true ||
      manifest.artifact_integrity === undefined ||
      !isDeepStrictEqual(manifest.run_provenance?.selection, data.nextSelection) ||
      !matchingCode(manifest.run_provenance?.code, data.code) ||
      !isCacheOnlySeedExtractionPath(manifest.seed_extraction_path) ||
      runProvenance === undefined || extraction?.schema_version !== 3 ||
      runCache?.schema_version !== 3) {
    throw new Error("500Q snapshot manifest differs from live expansion authority");
  }
  assertPromotionSnapshotProducerPolicy(runProvenance);
  assertSnapshotExtractionAuthority(extraction, runCache, capability);
  return extraction;
}

function matchingCode(
  actual: NonNullable<
    RecallEvalSnapshotBundle["manifest"]["run_provenance"]
  >["code"] | undefined,
  expected: ReturnType<typeof longMemEvalExpansionCapabilityData>["code"]
): boolean {
  return actual?.commit_sha === expected.commit_sha &&
    actual.commit_sha7 === expected.commit_sha7 &&
    actual.worktree_state_sha256 === expected.worktree_state_sha256 &&
    isDeepStrictEqual(actual.executed_dist, expected.executed_dist);
}

function assertSnapshotExtractionAuthority(
  extraction: SnapshotExtractionProvenanceV3,
  runCache: RunExtractionCacheV3,
  capability: LongMemEvalExpansionCapability
): void {
  const completion = snapshotCompletion(extraction);
  const config = {
    providerUrl: extraction.provider_url,
    model: extraction.extraction_model,
    modelFamily: extraction.model_family,
    requestProfile: extraction.request_profile,
    apiKey: null
  };
  assertLongMemEvalExpansionSourceAnchor(
    extraction.expansion_source_anchor,
    capability,
    config,
    completion
  );
  const lineage = assertLongMemEvalExpansionLineageMatchesCapability(
    extraction.expansion_lineage,
    capability
  );
  if (!isDeepStrictEqual(lineage.target_cache, snapshotTarget(extraction)) ||
      !matchingRunCache(extraction, runCache)) {
    throw new Error("500Q snapshot extraction lineage differs from target cache authority");
  }
}

function snapshotCompletion(extraction: SnapshotExtractionProvenanceV3) {
  if (extraction.fill_status !== "complete" || extraction.window_offset !== 0 ||
      extraction.window_limit !== 500 || extraction.expected_turns === undefined ||
      extraction.expected_key_set_sha256 === undefined ||
      extraction.content_closure_sha256 === undefined ||
      extraction.requested_turns !== extraction.expected_turns ||
      extraction.cached_turns !== extraction.expected_turns || extraction.coverage !== 1) {
    throw new Error("500Q snapshot extraction closure is incomplete");
  }
  return {
    expectedTurns: extraction.expected_turns,
    validTurns: extraction.expected_turns,
    missingTurns: 0,
    invalidTurns: 0,
    orphanTurns: 0,
    coverage: 1,
    expectedKeySetSha256: extraction.expected_key_set_sha256,
    partialContentClosureSha256: extraction.content_closure_sha256,
    contentClosureSha256: extraction.content_closure_sha256
  };
}

function snapshotTarget(extraction: SnapshotExtractionProvenanceV3) {
  return {
    extraction_model: extraction.extraction_model,
    model_family: extraction.model_family,
    request_profile: extraction.request_profile,
    provider_url: extraction.provider_url,
    system_prompt_sha256: extraction.system_prompt_sha256,
    cache_key_algo: extraction.cache_key_algo,
    dataset: extraction.dataset,
    dataset_revision: extraction.dataset_revision,
    window_offset: 0,
    window_limit: 500,
    expected_turns: extraction.expected_turns,
    expected_key_set_sha256: extraction.expected_key_set_sha256,
    content_closure_sha256: extraction.content_closure_sha256,
    ...(extraction.supplemental_source_receipt === undefined ? {} : {
      supplemental_source_binding_sha256: hashLongMemEvalSupplementalSourceBinding(
        extraction.supplemental_source_receipt
      )
    })
  };
}

function matchingRunCache(
  extraction: SnapshotExtractionProvenanceV3,
  runCache: RunExtractionCacheV3
): boolean {
  const fields = [
    "manifest_sha256", "extraction_model", "model_family", "request_profile",
    "provider_url", "system_prompt_sha256", "cache_key_algo", "dataset",
    "dataset_revision", "requested_turns", "cached_turns", "coverage",
    "fill_status", "window_offset", "window_limit", "expected_turns",
    "expected_key_set_sha256", "content_closure_sha256",
    "supplemental_source_receipt", "expansion_source_anchor", "expansion_lineage"
  ] as const;
  return fields.every((field) => isDeepStrictEqual(extraction[field], runCache[field]));
}

function requireCapability(
  capability: LongMemEvalExpansionCapability | undefined
): LongMemEvalExpansionCapability {
  if (capability !== undefined) return capability;
  throw new Error("canonical 500Q recall requires live promotion capability");
}

function assertCapabilityAbsent(
  capability: LongMemEvalExpansionCapability | undefined
): void {
  if (capability === undefined) return;
  throw new Error("expansion capability may only authorize canonical full 500Q recall");
}
