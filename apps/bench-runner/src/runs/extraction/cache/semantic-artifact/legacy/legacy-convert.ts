import { createHash } from "node:crypto";
import {
  parseOfficialApiSignals,
  parseOfficialApiSourceLocator,
  type OfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { inspectExtractionRawEnvelope } from "../../../content-closure.js";
import type { CachedExtractionEntry } from "../../../../compile-seed/cache/cache-shard.js";
import {
  sealSemanticArtifact,
  type SemanticArtifact
} from "../contract.js";
import {
  sealVerifiedSemanticArtifactAdmission,
  type VerifiedSemanticArtifactAdmission
} from "../verified-admission.js";
import { verifyLegacyShardIdentity } from "./legacy-convert-validation.js";
import {
  parseCapturedLegacyExtractionEntry,
  type VerifiedLegacyExtractionEntry
} from "./legacy-sealed-entry.js";
import {
  resolveExactSourceGrounding,
  type ExactSourceGroundingTask
} from "../exact-source-grounding.js";
import {
  currentReplayAuthorityForLegacyPrompt,
  semanticReplayIdentityDigest,
  unwrapSemanticReplayAuthority
} from "../replay-authority.js";

export const LEGACY_CONVERSION_CAPABILITY = "official_api_signals:v1";

export interface LegacyConversionUnresolved {
  readonly reason: string;
  readonly assertion_id?: number;
}

export interface LegacyConversionReport {
  readonly cache_key: string;
  readonly raw_json_sha256: string;
  readonly converted: readonly VerifiedSemanticArtifactAdmission[];
  readonly unresolved: readonly LegacyConversionUnresolved[];
}

export function convertLegacyExtractionShard(input: {
  readonly sealedEntry: VerifiedLegacyExtractionEntry;
  readonly request: OfficialApiExtractionRequest;
  readonly sourceUnits: readonly ExactSourceGroundingTask[];
  readonly semanticContract: string;
  readonly expectedSystemPrompt: string;
}): LegacyConversionReport {
  let entry: ReturnType<typeof parseCapturedLegacyExtractionEntry>;
  try {
    entry = parseCapturedLegacyExtractionEntry(input.sealedEntry);
  } catch (cause) {
    return report(input.sealedEntry.cacheKey, input.sealedEntry.rawJsonSha256, [], [{
      reason: errorMessage(cause)
    }]);
  }
  let witness: ReturnType<typeof verifyLegacyShardIdentity>;
  let replayIdentity: ReturnType<typeof unwrapSemanticReplayAuthority>;
  try {
    witness = verifyLegacyShardIdentity({
      entry,
      request: input.request,
      expectedSystemPrompt: input.expectedSystemPrompt,
      authority: input.sealedEntry
    });
    const replayAuthority = currentReplayAuthorityForLegacyPrompt({
      expectedSystemPrompt: input.expectedSystemPrompt,
      authoritySystemPromptSha256: input.sealedEntry.systemPromptSha256
    });
    replayIdentity = unwrapSemanticReplayAuthority(replayAuthority);
  } catch (cause) {
    return unresolvedInputReport(entry, cause);
  }
  let rawJsonSha256: string;
  try {
    rawJsonSha256 = inspectExtractionRawEnvelope(entry.raw_json).rawJsonSha256;
  } catch (cause) {
    return report(entry.cache_key, digest(entry.raw_json), [], [{
      reason: `invalid raw envelope: ${errorMessage(cause)}`
    }]);
  }
  if (input.request.source_assertions.length === 0) {
    return report(entry.cache_key, rawJsonSha256, [], [{
      reason: "empty-turn shard has no assertion members to convert"
    }]);
  }
  let drafts: ReturnType<typeof parseOfficialApiSignals>;
  try {
    drafts = parseOfficialApiSignals(entry.raw_json);
  } catch (cause) {
    return report(entry.cache_key, rawJsonSha256, [], [{
      reason: `parser drop: ${errorMessage(cause)}`
    }]);
  }
  if (drafts.length === 0) {
    return report(entry.cache_key, rawJsonSha256, [], [{
      reason: "sealed legacy metadata has no independent assertion-level completion witness"
    }]);
  }
  return convertParsedDrafts({
    entry,
    request: input.request,
    sourceUnits: input.sourceUnits,
    semanticContract: input.semanticContract,
    sealedEntry: input.sealedEntry,
    rawJsonSha256,
    drafts,
    witness,
    replayIdentity
  });
}

function convertParsedDrafts(input: {
  readonly entry: CachedExtractionEntry;
  readonly request: OfficialApiExtractionRequest;
  readonly sourceUnits: readonly ExactSourceGroundingTask[];
  readonly semanticContract: string;
  readonly sealedEntry: VerifiedLegacyExtractionEntry;
  readonly rawJsonSha256: string;
  readonly drafts: ReturnType<typeof parseOfficialApiSignals>;
  readonly witness: ReturnType<typeof verifyLegacyShardIdentity>;
  readonly replayIdentity: ReturnType<typeof unwrapSemanticReplayAuthority>;
}): LegacyConversionReport {
  const unresolved: LegacyConversionUnresolved[] = [];
  const converted: SemanticArtifact[] = [];
  const unitsByAssertion = indexUnits(input.sourceUnits);
  const claimed = new Map<number, number>();
  const grounded: { readonly assertionId: number; readonly unit: ExactSourceGroundingTask }[] = [];
  for (const draft of input.drafts) {
    const locator = parseOfficialApiSourceLocator(draft.source_locator);
    if (locator === null) {
      unresolved.push({ reason: "malformed source locator" });
      continue;
    }
    const assertionId = locator.assertion_id;
    claimed.set(assertionId, (claimed.get(assertionId) ?? 0) + 1);
    const member = input.request.source_assertions.find((item) =>
      item.assertion_id === assertionId);
    const unit = unitsByAssertion.get(assertionId);
    if (member === undefined || unit === undefined) {
      unresolved.push({ assertion_id: assertionId, reason: "foreign or unbound assertion" });
      continue;
    }
    const grounding = resolveExactSourceGrounding({
      task: unit,
      sourceLocator: draft.source_locator,
      matchedText: draft.matched_text
    });
    if (grounding.status !== "grounded") {
      unresolved.push({ assertion_id: assertionId, reason: `grounding rejected: ${grounding.reason}` });
      continue;
    }
    if (member.text !== unit.text ||
        input.request.source_corpus_identity !== unit.binding.sourceCorpusIdentity ||
        input.request.source_locator_contract_version !== locator.contract_version ||
        input.semanticContract !== unit.semanticIdentity.contractId) {
      unresolved.push({ assertion_id: assertionId, reason: "foreign or unbound assertion" });
      continue;
    }
    grounded.push({ assertionId, unit });
  }
  const duplicates = new Set(
    [...claimed.entries()].filter(([, count]) => count !== 1).map(([assertionId]) => assertionId)
  );
  for (const assertionId of duplicates) {
    unresolved.push({ assertion_id: assertionId, reason: "duplicate mapping" });
  }
  const usedAssertions = new Set<number>();
  const replayIdentityDigest = semanticReplayIdentityDigest(input.replayIdentity);
  for (const { assertionId, unit } of grounded) {
    if (duplicates.has(assertionId) || usedAssertions.has(assertionId)) continue;
    usedAssertions.add(assertionId);
    converted.push(sealSemanticArtifact({
      schema_version: 1,
      kind: "assertion_semantic_artifact_v1",
      semantic_key: unit.semanticKey,
      semantic_contract: input.semanticContract,
      capability: LEGACY_CONVERSION_CAPABILITY,
      capability_set: [LEGACY_CONVERSION_CAPABILITY],
      model_family: input.sealedEntry.modelFamily,
      model_id: input.sealedEntry.model,
      admission_state: "provider_backed",
      source_bindings: [unit.binding],
      replay_identity: input.replayIdentity,
      replay_identity_digest: replayIdentityDigest,
      raw_response_digest: input.rawJsonSha256,
      provider_provenance: {
        provider_url_sha256: input.sealedEntry.providerUrlSha256,
        request_profile: input.sealedEntry.requestProfile,
        model_id: input.sealedEntry.model,
        transport_model_id: input.sealedEntry.transportModel
      },
      legacy_conversion_witness: input.witness
    }));
  }
  for (const assertion of input.request.source_assertions) {
    if (!usedAssertions.has(assertion.assertion_id)) {
      unresolved.push({ assertion_id: assertion.assertion_id, reason: "no convertible signal" });
    }
  }
  return report(
    input.entry.cache_key,
    input.rawJsonSha256,
    mergeSameKey(converted).map(captureLegacyAdmission),
    unresolved
  );
}

function captureLegacyAdmission(artifact: SemanticArtifact): VerifiedSemanticArtifactAdmission {
  if (artifact.admission_state !== "provider_backed") {
    throw new Error("legacy conversion cannot issue this semantic admission state");
  }
  return sealVerifiedSemanticArtifactAdmission(artifact);
}

function indexUnits(
  units: readonly ExactSourceGroundingTask[]
): ReadonlyMap<number, ExactSourceGroundingTask> {
  const counts = new Map<number, number>();
  for (const unit of units) {
    counts.set(unit.assertionId, (counts.get(unit.assertionId) ?? 0) + 1);
  }
  return new Map(units.flatMap((unit) =>
    counts.get(unit.assertionId) === 1 ? [[unit.assertionId, unit] as const] : []));
}

function unresolvedInputReport(
  entry: CachedExtractionEntry,
  cause: unknown
): LegacyConversionReport {
  return report(entry.cache_key, digest(entry.raw_json), [], [{ reason: errorMessage(cause) }]);
}

function mergeSameKey(converted: readonly SemanticArtifact[]): readonly SemanticArtifact[] {
  const merged = new Map<string, SemanticArtifact>();
  for (const artifact of converted) {
    const existing = merged.get(artifact.semantic_key);
    if (existing === undefined) {
      merged.set(artifact.semantic_key, artifact);
      continue;
    }
    const { artifact_digest: _digest, ...unsigned } = existing;
    merged.set(artifact.semantic_key, sealSemanticArtifact({
      ...unsigned,
      source_bindings: [...existing.source_bindings, ...artifact.source_bindings]
    }));
  }
  return [...merged.values()];
}

function report(
  cacheKey: string,
  rawJsonSha256: string,
  converted: readonly VerifiedSemanticArtifactAdmission[],
  unresolved: readonly LegacyConversionUnresolved[]
): LegacyConversionReport {
  return Object.freeze({
    cache_key: cacheKey,
    raw_json_sha256: rawJsonSha256,
    converted: Object.freeze([...converted]),
    unresolved: Object.freeze([...unresolved])
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
