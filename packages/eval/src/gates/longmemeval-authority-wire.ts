import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import {
  LongMemEvalArtifactDescriptorSchema,
  LongMemEvalContentClosureIndexSchema,
  LongMemEvalExpansionLineageWireSchema,
  LongMemEvalExpansionSourceAnchorWireSchema,
  LongMemEvalExtractionAuthoritySchema,
  LongMemEvalExtractionSummarySchema,
  LongMemEvalFanoutAuthoritySchema,
  LongMemEvalFullExtractionCacheSchema,
  LongMemEvalShardAuthorityReferenceSchema,
  LongMemEvalSupplementalSourceProvenanceBindingWireSchema,
  type LongMemEvalArtifactDescriptor,
  type LongMemEvalExtractionAuthority,
  type LongMemEvalExtractionSummary,
  type LongMemEvalFanoutAuthority,
  type LongMemEvalShardAuthorityReference
} from "./longmemeval-authority-schemas.js";

export * from "./longmemeval-authority-schemas.js";

export function parseLongMemEvalExtractionAuthority(
  bytes: Uint8Array,
  label: string
): LongMemEvalExtractionAuthority {
  return LongMemEvalExtractionAuthoritySchema.parse(parseJsonBytes(bytes, label));
}

export function assertLongMemEvalFullExtractionClosure(value: unknown): void {
  const full = LongMemEvalFullExtractionCacheSchema.parse(value);
  assertClosureIntegrity(full);
  if (full.expansion_lineage !== undefined ||
      full.expansion_source_anchor !== undefined) {
    const { content_closure_index: _closure, ...summary } = full;
    assertLongMemEvalExpansionBinding(summary);
  }
}

export function assertLongMemEvalExtractionAuthorityIntegrity(
  value: unknown
): LongMemEvalExtractionAuthority {
  const authority = LongMemEvalExtractionAuthoritySchema.parse(value);
  assertClosureIntegrity(authority);
  return authority;
}

export function assertLongMemEvalExtractionAuthorityBinding(input: {
  readonly authority: unknown;
  readonly compact: unknown;
}): void {
  const authority = assertLongMemEvalExtractionAuthorityIntegrity(input.authority);
  const compact = LongMemEvalExtractionSummarySchema.parse(input.compact);
  const fields = authoritySummaryFields();
  const mismatches: string[] = fields.filter(
    (field) => authority[field] !== compact[field]
  );
  if (authority.source_manifest_sha256 !== compact.manifest_sha256) {
    mismatches.push("source_manifest_sha256");
  }
  if (authority.expansion_source_anchor_sha256 !==
      expansionDigest(compact.expansion_source_anchor)) {
    mismatches.push("expansion_source_anchor_sha256");
  }
  if (authority.expansion_lineage_sha256 !==
      expansionDigest(compact.expansion_lineage)) {
    mismatches.push("expansion_lineage_sha256");
  }
  if (authority.supplemental_source_binding_sha256 !==
      supplementalSourceDigest(compact.supplemental_source_receipt)) {
    mismatches.push("supplemental_source_binding_sha256");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `extraction compact summary differs from bound authority: ${mismatches.join(", ")}`
    );
  }
}

export function hydrateLongMemEvalExtractionAuthority<
  T extends { readonly extraction_cache: unknown }
>(input: {
  readonly compact: T;
  readonly authority: unknown;
}): T & { readonly extraction_cache: LongMemEvalExtractionSummary & {
  readonly content_closure_index: z.infer<typeof LongMemEvalContentClosureIndexSchema>;
} } {
  const compactCache = LongMemEvalExtractionSummarySchema.parse(
    input.compact.extraction_cache
  );
  const authority = LongMemEvalExtractionAuthoritySchema.parse(input.authority);
  assertLongMemEvalExtractionAuthorityBinding({ authority, compact: compactCache });
  return {
    ...input.compact,
    extraction_cache: {
      ...compactCache,
      content_closure_index: authority.content_closure_index
    }
  };
}

export function assertLongMemEvalExpansionBinding(
  value: unknown,
  context: {
    readonly code?: unknown;
    readonly selection?: unknown;
    readonly datasetSha256?: string;
  } = {}
): void {
  const compact = LongMemEvalExtractionSummarySchema.parse(value);
  const anchor = compact.expansion_source_anchor;
  const lineage = compact.expansion_lineage;
  if (anchor === undefined || lineage === undefined) {
    throw new Error("500Q extraction authority requires source anchor and lineage");
  }
  assertExpansionPair(anchor, lineage, compact);
  if ((context.code !== undefined &&
      canonicalJson(context.code) !== canonicalJson(anchor.code)) ||
      (context.selection !== undefined &&
      canonicalJson(context.selection) !== canonicalJson(anchor.next_selection)) ||
      (context.datasetSha256 !== undefined &&
      context.datasetSha256 !== anchor.next_selection.dataset_sha256)) {
    throw new Error("500Q expansion identity differs from run provenance");
  }
}

export function assertLongMemEvalFanoutAuthorityBinding(input: {
  readonly fanout: unknown;
  readonly authority: unknown;
  readonly compact: unknown;
  readonly extractionDescriptor: unknown;
}): LongMemEvalFanoutAuthority {
  const fanout = LongMemEvalFanoutAuthoritySchema.parse(input.fanout);
  const authority = LongMemEvalExtractionAuthoritySchema.parse(input.authority);
  const compact = LongMemEvalExtractionSummarySchema.parse(input.compact);
  const descriptor = LongMemEvalArtifactDescriptorSchema.parse(
    input.extractionDescriptor
  );
  assertLongMemEvalExtractionAuthorityBinding({ authority, compact });
  assertLongMemEvalExpansionBinding(compact, {
    code: fanout.code,
    selection: fanout.promotion.next_selection,
    datasetSha256: fanout.dataset.sha256
  });
  const anchor = compact.expansion_source_anchor;
  const lineage = compact.expansion_lineage;
  if (anchor === undefined || lineage === undefined ||
      canonicalJson(fanout.promotion) !==
        canonicalJson(promotionIdentityFromExpansion(anchor)) ||
      canonicalJson(fanout.promotion) !==
        canonicalJson(promotionIdentityFromExpansion(lineage))) {
    throw new Error("fanout promotion identity differs from expansion lineage");
  }
  if (canonicalJson(descriptor) !==
      canonicalJson(fanout.cache.extraction_authority) ||
      fanout.cache.source_manifest_sha256 !== authority.source_manifest_sha256 ||
      fanout.cache.content_closure_sha256 !== authority.content_closure_sha256 ||
      fanout.cache.expansion_source_anchor_sha256 !==
        authority.expansion_source_anchor_sha256 ||
      fanout.cache.expansion_lineage_sha256 !== authority.expansion_lineage_sha256) {
    throw new Error("fanout cache identity differs from extraction authority");
  }
  return fanout;
}

export function assertLongMemEvalFanoutReferenceBinding(input: {
  readonly reference: unknown;
  readonly fanout: unknown;
  readonly fanoutDescriptor: unknown;
  readonly extractionDescriptor: unknown;
  readonly sourceManifestSha256: string;
}): LongMemEvalShardAuthorityReference {
  const reference = LongMemEvalShardAuthorityReferenceSchema.parse(input.reference);
  const fanout = LongMemEvalFanoutAuthoritySchema.parse(input.fanout);
  const fanoutDescriptor = LongMemEvalArtifactDescriptorSchema.parse(
    input.fanoutDescriptor
  );
  const extractionDescriptor = LongMemEvalArtifactDescriptorSchema.parse(
    input.extractionDescriptor
  );
  const { run_nonce: _runNonce, ...referencedFanout } = reference.fanout;
  if (canonicalJson(reference.authority) !== canonicalJson(extractionDescriptor) ||
      canonicalJson(referencedFanout) !== canonicalJson(fanoutDescriptor) ||
      reference.fanout.run_nonce !== fanout.run_nonce ||
      reference.source_manifest_sha256 !== input.sourceManifestSha256 ||
      canonicalJson(reference.plan) !==
        canonicalJson(fanout.plans[reference.plan.shard_index])) {
    throw new Error(
      "shard reference descriptor or plan differs from parent fanout authority"
    );
  }
  return reference;
}

export function longMemEvalArtifactDescriptor(
  path: string,
  contents: Uint8Array
): LongMemEvalArtifactDescriptor {
  return LongMemEvalArtifactDescriptorSchema.parse({
    path,
    sha256: sha256(contents),
    bytes: contents.byteLength
  });
}

export function renderLongMemEvalAuthorityWire(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function hashLongMemEvalExpansionArtifact(value: unknown): string {
  return expansionDigest(value) ?? sha256(Buffer.from("undefined", "utf8"));
}

export function hashLongMemEvalSupplementalSourceBinding(value: unknown): string {
  const digest = supplementalSourceDigest(value);
  return digest ?? sha256(Buffer.from("undefined", "utf8"));
}

function assertClosureIntegrity(value: {
  readonly extraction_model: string;
  readonly request_profile: string;
  readonly requested_turns: number;
  readonly cached_turns: number;
  readonly expected_turns: number;
  readonly expected_key_set_sha256: string;
  readonly content_closure_sha256: string;
  readonly content_closure_index: z.infer<typeof LongMemEvalContentClosureIndexSchema>;
}): void {
  const entries = Object.entries(value.content_closure_index);
  const keyDigest = sha256(Buffer.from(entries.map(([key]) => key).sort().join("\n")));
  const rows = entries.sort(([left], [right]) => left.localeCompare(right))
    .map(([key, [rawSha, rawCount, parsedCount]]) => JSON.stringify([
      key, value.extraction_model, value.request_profile,
      rawSha, rawCount, parsedCount
    ]));
  const closureDigest = sha256(Buffer.from(rows.join("\n")));
  if (value.requested_turns !== value.expected_turns ||
      value.cached_turns !== value.expected_turns ||
      entries.length !== value.expected_turns ||
      keyDigest !== value.expected_key_set_sha256 ||
      closureDigest !== value.content_closure_sha256) {
    throw new Error("extraction content closure integrity mismatch");
  }
}

function assertExpansionPair(
  anchor: z.infer<typeof LongMemEvalExpansionSourceAnchorWireSchema>,
  lineage: z.infer<typeof LongMemEvalExpansionLineageWireSchema>,
  compact: LongMemEvalExtractionSummary
): void {
  const { schema_version: _aSchema, kind: _aKind, target_cache: aTarget, ...a } = anchor;
  const { schema_version: _lSchema, kind: _lKind, target_cache: lTarget, ...l } = lineage;
  const { content_closure_sha256: lineageClosure, ...lineageTarget } = lTarget;
  const compactTarget = targetCacheFromSummary(compact);
  if (canonicalJson(a) !== canonicalJson(l) ||
      canonicalJson(aTarget) !== canonicalJson(lineageTarget) ||
      canonicalJson(aTarget) !== canonicalJson(compactTarget) ||
      anchor.source_cache.supplemental_source_binding_sha256 !==
        aTarget.supplemental_source_binding_sha256 ||
      lineageClosure !== compact.content_closure_sha256) {
    throw new Error("500Q source anchor and lineage are not bound to target cache");
  }
}

function targetCacheFromSummary(compact: LongMemEvalExtractionSummary) {
  return {
    extraction_model: compact.extraction_model,
    model_family: compact.model_family,
    request_profile: compact.request_profile,
    provider_url: compact.provider_url,
    system_prompt_sha256: compact.system_prompt_sha256,
    cache_key_algo: compact.cache_key_algo,
    dataset: compact.dataset,
    dataset_revision: compact.dataset_revision,
    window_offset: compact.window_offset,
    window_limit: compact.window_limit,
    expected_turns: compact.expected_turns,
    expected_key_set_sha256: compact.expected_key_set_sha256,
    ...(compact.supplemental_source_receipt === undefined ? {} : {
      supplemental_source_binding_sha256: hashLongMemEvalSupplementalSourceBinding(
        compact.supplemental_source_receipt
      )
    })
  };
}

function promotionIdentityFromExpansion(value: z.infer<
  typeof LongMemEvalExpansionSourceAnchorWireSchema
> | z.infer<typeof LongMemEvalExpansionLineageWireSchema>) {
  return {
    contract_sha256: value.contract_sha256,
    policy_version: value.policy_version,
    code: value.code,
    source_selection: value.source_selection,
    next_selection: value.next_selection,
    matrix_sha256: value.matrix_sha256,
    product_default: value.product_default
  };
}

function authoritySummaryFields() {
  return [
    "extraction_model", "model_family", "request_profile", "system_prompt_sha256",
    "cache_key_algo", "dataset", "dataset_revision", "requested_turns",
    "cached_turns", "coverage", "fill_status", "window_offset", "window_limit",
    "expected_turns", "expected_key_set_sha256", "content_closure_sha256"
  ] as const;
}

function expansionDigest(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const sanitized = JSON.parse(JSON.stringify(
    value,
    (key, nested: unknown) => key === "provider_url" ? undefined : nested
  )) as unknown;
  return sha256(Buffer.from(canonicalJson(sanitized), "utf8"));
}

function supplementalSourceDigest(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const binding = LongMemEvalSupplementalSourceProvenanceBindingWireSchema.parse(value);
  return sha256(Buffer.from(canonicalJson(binding), "utf8"));
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new Error(`invalid LongMemEval authority at ${label}`, { cause });
  }
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}
