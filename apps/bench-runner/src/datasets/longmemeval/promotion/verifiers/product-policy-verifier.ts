import { isDeepStrictEqual } from "node:util";
import type { BenchRecallWeightOverrides } from
  "../../../../harness/recall/recall-weight-overrides.js";
import {
  assertRecallEvalProductPolicyEnvironment,
  buildEffectiveRecallConfigIdentity,
  readRecallEvalMaxResults,
  type EffectiveRecallOptions
} from "../../../../runs/provenance/effective-recall-config.js";
import type { LongMemEvalRunProvenance } from "../../../../runs/provenance/run.js";
import { assertProductDefaultBiEncoderRuntime } from
  "../product/product-bi-encoder-policy.js";

const PRODUCT_DEFAULT_ENV = Object.freeze({});

export function assertProductDefaultRunProvenancePolicy(
  provenance: Pick<
    LongMemEvalRunProvenance,
    "runtime" | "recall_config" | "seed_capabilities"
  >,
  context: string
): void {
  const expected = canonicalProductRecallProvenanceConfig();
  if (!isDeepStrictEqual(provenance.recall_config, expected)) {
    throw new Error(`${context} provenance policy differs`);
  }
  if (provenance.seed_capabilities?.facet_tags_enabled === true) {
    throw new Error(`${context} seed capabilities differ from product-default`);
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
  return Object.freeze({
    conf_slice_compatibility: false,
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
