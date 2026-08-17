import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import {
  computeSystemPromptSha256,
  readExtractionCacheManifestIdentity,
  type ExtractionCacheManifestIdentity
} from "../../extraction/cache/extraction-cache-manifest.js";
import { computeExtractionKeySetSha256 } from
  "../../extraction/content-closure.js";
import {
  requiredExtractionCacheKeys
} from "./cache-window-key-binding.js";
import type {
  CompileSeedExtractionConfig,
  ExtractionCachePreflightProof
} from "../compile-seed-types.js";
import type { ExtractionFillQuestionWindow } from
  "../../extraction/fill/manifest/fill-manifest-contract.js";
import type { LongMemEvalExtractionTurn } from
  "../../extraction/turn-contents.js";
import type { ExtractionCacheContentInspection } from
  "../../extraction/fill/fill-completion.js";
import { preflightExtractionCache } from "../compile-seed-preflight.js";

interface PreflightProofBinding {
  readonly cacheRoot: string;
  readonly manifestSha256: string;
  readonly providerUrl: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly systemPromptSha256: string;
  readonly requiredKeySetSha256: string;
  readonly requiredKeyCount: number;
  readonly questionWindow: ExtractionFillQuestionWindow;
}

interface ProofIdentityInput {
  readonly cacheRoot: string;
  readonly manifestIdentity: ExtractionCacheManifestIdentity;
  readonly config: CompileSeedExtractionConfig;
  readonly systemPrompt: string;
}

interface ProofScopeInput extends ProofIdentityInput {
  readonly requiredTurnContents: readonly string[];
  readonly requiredExtractionTurns?: readonly LongMemEvalExtractionTurn[];
  readonly requiredQuestionWindow: ExtractionFillQuestionWindow;
}

const bindings = new WeakMap<ExtractionCachePreflightProof, PreflightProofBinding>();

export function createExtractionCachePreflightProof(
  input: ProofScopeInput & { readonly liveExtractionPossible: boolean }
): ExtractionCachePreflightProof {
  const currentIdentity = readExtractionCacheManifestIdentity(input.cacheRoot);
  if (currentIdentity === undefined ||
      currentIdentity.manifestSha256 !== input.manifestIdentity.manifestSha256 ||
      !isDeepStrictEqual(currentIdentity.manifest, input.manifestIdentity.manifest)) {
    throw new Error("cache preflight proof manifest identity is not current");
  }
  const currentInput = { ...input, manifestIdentity: currentIdentity };
  const inspection = preflightExtractionCache({
    cacheRoot: currentInput.cacheRoot,
    config: currentInput.config,
    systemPrompt: currentInput.systemPrompt,
    allowLiveExtraction: false,
    liveExtractionPossible: currentInput.liveExtractionPossible,
    manifest: currentIdentity.manifest,
    requiredTurnContents: currentInput.requiredTurnContents,
    requiredQuestionWindow: currentInput.requiredQuestionWindow,
    ...(currentInput.requiredExtractionTurns === undefined ? {} : {
      requiredExtractionTurns: currentInput.requiredExtractionTurns
    }),
    requireManifest: true
  });
  if (inspection === undefined) {
    throw new Error("cache preflight proof requires a finalized raw closure");
  }
  const postflightIdentity = readExtractionCacheManifestIdentity(input.cacheRoot);
  if (postflightIdentity === undefined ||
      postflightIdentity.manifestSha256 !== currentIdentity.manifestSha256) {
    throw new Error("cache manifest changed during preflight proof inspection");
  }
  return captureExtractionCachePreflightProof(currentInput, inspection);
}

function captureExtractionCachePreflightProof(
  input: ProofScopeInput,
  inspection: ExtractionCacheContentInspection
): ExtractionCachePreflightProof {
  if (input.config.apiKey !== null || inspection.rawContentClosureSha256 === null) {
    throw new Error("cache preflight proof requires a cache-only raw closure");
  }
  const requiredKeys = computeRequiredKeys(input);
  const proof = Object.freeze({}) as ExtractionCachePreflightProof;
  bindings.set(proof, Object.freeze({
    cacheRoot: resolve(input.cacheRoot),
    manifestSha256: input.manifestIdentity.manifestSha256,
    providerUrl: input.config.providerUrl,
    model: input.config.model,
    requestProfile: input.config.requestProfile,
    systemPromptSha256: computeSystemPromptSha256(input.systemPrompt),
    requiredKeySetSha256: computeExtractionKeySetSha256(requiredKeys),
    requiredKeyCount: new Set(requiredKeys).size,
    questionWindow: Object.freeze({ ...input.requiredQuestionWindow })
  }));
  return proof;
}

export function assertExtractionCachePreflightProofReuse(
  proof: ExtractionCachePreflightProof,
  input: ProofScopeInput
): void {
  const binding = assertExtractionCachePreflightProofCurrent(proof, input);
  const requiredKeys = computeRequiredKeys(input);
  if (binding.requiredKeyCount !== new Set(requiredKeys).size ||
      binding.requiredKeySetSha256 !== computeExtractionKeySetSha256(requiredKeys) ||
      !isDeepStrictEqual(binding.questionWindow, input.requiredQuestionWindow)) {
    throw new Error("extraction cache preflight proof consumer scope mismatch");
  }
}

function assertExtractionCachePreflightProofCurrent(
  proof: ExtractionCachePreflightProof,
  input: ProofIdentityInput
): PreflightProofBinding {
  const binding = requireBinding(proof);
  if (binding.cacheRoot !== resolve(input.cacheRoot) ||
      binding.manifestSha256 !== input.manifestIdentity.manifestSha256 ||
      binding.providerUrl !== input.config.providerUrl ||
      binding.model !== input.config.model ||
      binding.requestProfile !== input.config.requestProfile ||
      binding.systemPromptSha256 !== computeSystemPromptSha256(input.systemPrompt) ||
      input.config.apiKey !== null) {
    throw new Error("extraction cache preflight proof identity mismatch");
  }
  return binding;
}

export function assertExtractionCachePreflightProofManifest(
  proof: ExtractionCachePreflightProof,
  manifestSha256: string
): void {
  if (requireBinding(proof).manifestSha256 !== manifestSha256) {
    throw new Error("snapshot extraction manifest changed after cache preflight");
  }
}

function requireBinding(
  proof: ExtractionCachePreflightProof
): PreflightProofBinding {
  const binding = bindings.get(proof);
  if (binding === undefined) {
    throw new Error("extraction cache preflight proof is absent or forged");
  }
  return binding;
}

function computeRequiredKeys(input: ProofScopeInput): readonly string[] {
  return requiredExtractionCacheKeys({
    model: input.config.model,
    requestProfile: input.config.requestProfile,
    systemPrompt: input.systemPrompt,
    requiredTurnContents: input.requiredTurnContents,
    ...(input.requiredExtractionTurns === undefined ? {} : {
      requiredExtractionTurns: input.requiredExtractionTurns
    })
  });
}
