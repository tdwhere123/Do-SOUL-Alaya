import { isDeepStrictEqual } from "node:util";
import { parseRecallRuntimeConfigFromEnv } from "@do-soul/alaya-core";
import type { BenchRecallWeightOverrides } from
  "../../../harness/recall/recall-weight-overrides.js";
import {
  assertRecallEvalProductPolicyEnvironment,
  buildEffectiveRecallConfigIdentity,
  readRecallEvalMaxResults,
  type EffectiveRecallOptions
} from "../../provenance/effective-recall-config.js";
import type { VerifiedRecallEvalPromotionEntryData } from "./entry-verifier.js";
import type { LongMemEvalRunProvenance } from "../../provenance/run.js";
import {
  assertProductDefaultBiEncoderRuntime,
  assertProductDefaultBiEncoderSupplement
} from "../product/product-bi-encoder-policy.js";

const PRODUCT_DEFAULT_ENV = Object.freeze({});

export function assertPromotionProductDefaultPolicy(
  data: VerifiedRecallEvalPromotionEntryData
): void {
  const payload = data.payload;
  const attribution = payload.recall_eval_attribution;
  const recallConfig = canonicalProductRecallConfig();
  if (payload.policy_shape !== "stress" || payload.simulate_report !== "none" ||
      payload.recall_weight_overrides !== undefined) {
    throw new Error("promotion product-default policy shape or weights differ");
  }
  if (attribution === undefined ||
      !isDeepStrictEqual(attribution.recall_config, recallConfig)) {
    throw new Error("promotion product-default effective recall config differs");
  }
  assertProductDefaultRunProvenancePolicy(
    data.provenance,
    "promotion product-default"
  );
  assertProductDefaultBiEncoderSupplement(
    data.diagnosticsRuntime.embedding_supplement,
    "promotion product-default embedding"
  );
}

export function assertProductDefaultRunProvenancePolicy(
  provenance: Pick<
    LongMemEvalRunProvenance,
    "runtime" | "recall_config" | "seed_capabilities"
  >,
  context: string
): void {
  const expected = canonicalProductRecallProvenanceConfig();
  if (!isDeepStrictEqual(provenance.recall_config, expected) ||
      provenance.seed_capabilities?.facet_tags_enabled !== false) {
    throw new Error(`${context} provenance policy differs`);
  }
  assertProductDefaultBiEncoderRuntime(provenance.runtime, `${context} embedding`);
}

export function canonicalProductRecallConfig() {
  return buildEffectiveRecallConfigIdentity(PRODUCT_DEFAULT_ENV, {
    maxResults: readRecallEvalMaxResults(undefined),
    conflictAwareness: true
  });
}

export function canonicalProductRecallProvenanceConfig() {
  const runtimeRecall = parseRecallRuntimeConfigFromEnv(PRODUCT_DEFAULT_ENV);
  return Object.freeze({
    conf_slice_compatibility: runtimeRecall.confSliceCompatibility,
    ...canonicalProductRecallConfig()
  });
}

export function assertProductDefaultRecallEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: EffectiveRecallOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined,
  context: string
): void {
  assertRecallEvalProductPolicyEnvironment(env);
  const actual = buildEffectiveRecallConfigIdentity(
    env,
    options,
    recallWeightOverrides
  );
  if (!isDeepStrictEqual(actual, canonicalProductRecallConfig())) {
    throw new Error(`${context} differs from the product-default recall policy`);
  }
}
