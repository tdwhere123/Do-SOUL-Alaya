import { createHash } from "node:crypto";
import {
  parseOfficialApiSignals,
  parseOfficialApiSourceLocator,
  type OfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { inspectExtractionRawEnvelope } from "../../content-closure.js";
import type { CachedExtractionEntry } from "../../../compile-seed/cache/cache-shard.js";
import {
  sealSemanticArtifact,
  type SemanticArtifact,
  type SemanticArtifactSourceBinding
} from "./contract.js";

export const LEGACY_CONVERSION_CAPABILITY = "official_api_signals:v1";

export interface LegacyExhaustiveInspectionProof {
  readonly prompt_sha256: string;
  readonly raw_json_sha256: string;
  readonly parser_status: "ok";
  readonly completion_status: "complete";
  readonly catalog_assertion_ids: readonly number[];
}

export interface LegacyConversionUnresolved {
  readonly reason: string;
  readonly assertion_id?: number;
}

export interface LegacyConversionReport {
  readonly cache_key: string;
  readonly raw_json_sha256: string;
  readonly converted: readonly SemanticArtifact[];
  readonly unresolved: readonly LegacyConversionUnresolved[];
}

export function convertLegacyExtractionShard(input: {
  readonly entry: CachedExtractionEntry;
  readonly request: OfficialApiExtractionRequest;
  readonly sourceBindings: readonly SemanticArtifactSourceBinding[];
  readonly semanticContract: string;
  readonly modelFamily: string;
  readonly exhaustiveProof?: LegacyExhaustiveInspectionProof;
  readonly expectedPromptSha256: string;
}): LegacyConversionReport {
  const unresolved: LegacyConversionUnresolved[] = [];
  const converted: SemanticArtifact[] = [];
  let rawJsonSha256: string;
  try {
    rawJsonSha256 = inspectExtractionRawEnvelope(input.entry.raw_json).rawJsonSha256;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return report(input.entry.cache_key, createHash("sha256").update(input.entry.raw_json, "utf8").digest("hex"), [], [
      { reason: `invalid raw envelope: ${reason}` }
    ]);
  }

  const bindingsByAssertion = indexBindings(input.sourceBindings);
  if (input.request.source_assertions.length === 0) {
    return report(input.entry.cache_key, rawJsonSha256, [], [{
      reason: "empty-turn shard has no assertion members to convert"
    }]);
  }

  let drafts: ReturnType<typeof parseOfficialApiSignals>;
  try {
    drafts = parseOfficialApiSignals(input.entry.raw_json);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return report(input.entry.cache_key, rawJsonSha256, [], [{ reason: `parser drop: ${reason}` }]);
  }

  if (drafts.length === 0) {
    if (!provesExhaustive(input.exhaustiveProof, input.request, rawJsonSha256, input.expectedPromptSha256)) {
      return report(input.entry.cache_key, rawJsonSha256, [], [{
        reason: "batch-empty is not assertion-empty without exhaustive inspection proof"
      }]);
    }
    for (const assertion of input.request.source_assertions) {
      const binding = bindingsByAssertion.get(assertion.assertion_id);
      if (binding === undefined) {
        unresolved.push({ assertion_id: assertion.assertion_id, reason: "missing source binding" });
        continue;
      }
      converted.push(sealSemanticArtifact({
        schema_version: 1,
        kind: "assertion_semantic_artifact_v1",
        semantic_key: binding.semanticKey,
        semantic_contract: input.semanticContract,
        capability: LEGACY_CONVERSION_CAPABILITY,
        capability_set: [LEGACY_CONVERSION_CAPABILITY],
        model_family: input.modelFamily,
        model_id: input.entry.model,
        admission_state: "deterministic_empty",
        source_bindings: [binding],
        deterministic_empty_proof: {
          kind: "exhaustive_member_inspection",
          formation_contract_version: input.request.source_locator_contract_version,
          assertion_id: assertion.assertion_id
        }
      }));
    }
    return report(input.entry.cache_key, rawJsonSha256, converted, unresolved);
  }

  if (!isCompleteInspection(input.entry)) {
    return report(input.entry.cache_key, rawJsonSha256, [], [{
      reason: "incomplete inspection witness"
    }]);
  }

  const claimed = new Map<number, number>();
  const located: { assertionId: number }[] = [];
  for (const draft of drafts) {
    const locator = parseOfficialApiSourceLocator(draft.source_locator);
    if (locator === null) {
      unresolved.push({ reason: "ambiguous locator" });
      continue;
    }
    claimed.set(locator.assertion_id, (claimed.get(locator.assertion_id) ?? 0) + 1);
    located.push({ assertionId: locator.assertion_id });
  }
  const duplicates = new Set(
    [...claimed.entries()].filter(([, count]) => count !== 1).map(([assertionId]) => assertionId)
  );
  for (const assertionId of duplicates) {
    unresolved.push({ assertion_id: assertionId, reason: "duplicate mapping" });
  }
  const usedAssertions = new Set<number>();
  for (const { assertionId } of located) {
    if (duplicates.has(assertionId) || usedAssertions.has(assertionId)) continue;
    const member = input.request.source_assertions.find(
      (assertion) => assertion.assertion_id === assertionId
    );
    const binding = bindingsByAssertion.get(assertionId);
    if (member === undefined || binding === undefined) {
      unresolved.push({ assertion_id: assertionId, reason: "foreign or unbound assertion" });
      continue;
    }
    usedAssertions.add(assertionId);
    converted.push(sealSemanticArtifact({
      schema_version: 1,
      kind: "assertion_semantic_artifact_v1",
      semantic_key: binding.semanticKey,
      semantic_contract: input.semanticContract,
      capability: LEGACY_CONVERSION_CAPABILITY,
      capability_set: [LEGACY_CONVERSION_CAPABILITY],
      model_family: input.modelFamily,
      model_id: input.entry.model,
      admission_state: "provider_backed",
      source_bindings: [binding],
      raw_response_digest: rawJsonSha256,
      ...(provenanceFrom(input.entry) === undefined ? {} : {
        provider_provenance: provenanceFrom(input.entry)
      })
    }));
  }
  for (const assertion of input.request.source_assertions) {
    if (!usedAssertions.has(assertion.assertion_id)) {
      unresolved.push({ assertion_id: assertion.assertion_id, reason: "no convertible signal" });
    }
  }
  return report(input.entry.cache_key, rawJsonSha256, mergeSameKey(converted), unresolved);
}

function isCompleteInspection(entry: CachedExtractionEntry): boolean {
  const metadata = entry.response_metadata as
    | { readonly completion_witness?: string; readonly finish_reason?: string }
    | undefined;
  return metadata?.completion_witness === "done_sentinel" && metadata.finish_reason === "stop";
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

function provesExhaustive(
  proof: LegacyExhaustiveInspectionProof | undefined,
  request: OfficialApiExtractionRequest,
  rawJsonSha256: string,
  expectedPromptSha256: string
): boolean {
  if (proof === undefined) return false;
  const ids = request.source_assertions.map((assertion) => assertion.assertion_id);
  return proof.parser_status === "ok" &&
    proof.completion_status === "complete" &&
    proof.raw_json_sha256 === rawJsonSha256 &&
    proof.prompt_sha256 === expectedPromptSha256 &&
    proof.catalog_assertion_ids.length === ids.length &&
    ids.every((id, index) => proof.catalog_assertion_ids[index] === id);
}

function indexBindings(
  bindings: readonly SemanticArtifactSourceBinding[]
): Map<number, SemanticArtifactSourceBinding> {
  const counts = new Map<number, number>();
  for (const binding of bindings) {
    const assertionId = binding.locator.assertion_id;
    counts.set(assertionId, (counts.get(assertionId) ?? 0) + 1);
  }
  const indexed = new Map<number, SemanticArtifactSourceBinding>();
  for (const binding of bindings) {
    if (counts.get(binding.locator.assertion_id) === 1) {
      indexed.set(binding.locator.assertion_id, binding);
    }
  }
  return indexed;
}

function report(
  cacheKey: string,
  rawJsonSha256: string,
  converted: readonly SemanticArtifact[],
  unresolved: readonly LegacyConversionUnresolved[]
): LegacyConversionReport {
  return { cache_key: cacheKey, raw_json_sha256: rawJsonSha256, converted, unresolved };
}

function provenanceFrom(entry: CachedExtractionEntry) {
  const raw = entry.transport_provenance?.provider_url_sha256;
  if (raw === undefined) return undefined;
  const digest = raw.startsWith("sha256:") ? raw.slice("sha256:".length) : raw;
  if (!/^[a-f0-9]{64}$/u.test(digest)) return undefined;
  return {
    provider_url_sha256: digest,
    request_profile: entry.request_profile,
    model_id: entry.model
  };
}
