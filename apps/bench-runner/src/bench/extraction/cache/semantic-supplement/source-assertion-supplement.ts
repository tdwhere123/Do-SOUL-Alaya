import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  computeOfficialApiSourceCorpusIdentity,
  parseOfficialApiExtractionRequest,
  stringifyOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  EXTRACTION_REQUEST_PROFILES,
  type ExtractionRequestProfile
} from "../../request-profile.js";
import {
  assertGroundedPrimaryGap,
  buildSourceDraftAnchorBindings,
  hasValidAnchorBindingShape,
  selectSourceDraftsByAnchorBindings,
  sourceObservationSha256s,
  type SourceDraftAnchorInput
} from "./source-draft-anchor-binding.js";
import {
  computeSourceAssertionSupplementReceiptEntrySetSha256,
  computeSourceAssertionSupplementReceiptEntrySha256,
  computeSourceAssertionSupplementSidecarProjectionSha256,
  sourceAssertionSupplementSidecarProjection
} from "./source-assertion-supplement-closure.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const CACHE_KEY_DIAGNOSTIC_PREFIX_CHARS = 12;
const PositiveCountSchema = z.number().int().positive();
const AssertionIdsSchema = z.array(PositiveCountSchema).nonempty().readonly();
const IdentityShape = {
  manifest_sha256: Sha256Schema,
  model: z.string().trim().min(1),
  model_family: z.string().trim().min(1),
  request_profile: z.enum(EXTRACTION_REQUEST_PROFILES),
  system_prompt_sha256: Sha256Schema
} as const;
const IdentitySchema = z.object(IdentityShape).strict().readonly();
const PrimaryIdentitySchema = z.object({
  ...IdentityShape,
  parser_semantics: z.string().trim().min(1),
  grounding_semantics: z.string().trim().min(1)
}).strict().readonly();
const SourceDraftBindingSchema = z.object({
  source_draft_index: z.number().int().nonnegative(),
  source_draft_sha256: Sha256Schema,
  current_anchor_assertion_id: PositiveCountSchema,
  current_anchor_assertion_sha256: Sha256Schema,
  proposed_quote_sha256: Sha256Schema,
  grounded_source_assertion_sha256: Sha256Schema
}).strict().readonly();
const EntrySchema = z.object({
  primary_cache_key: Sha256Schema,
  primary_request_sha256: Sha256Schema,
  source_corpus_identity: Sha256Schema,
  source_cache_key: Sha256Schema,
  source_raw_json_sha256: Sha256Schema,
  primary_raw_json_sha256: Sha256Schema,
  anchor_assertion_ids: AssertionIdsSchema,
  source_observation_sha256s: z.array(Sha256Schema).nonempty().readonly(),
  source_draft_bindings: z.array(SourceDraftBindingSchema).nonempty().readonly(),
  occurrence_count: PositiveCountSchema,
  selected_draft_count: PositiveCountSchema,
  selected_raw_json_sha256: Sha256Schema
}).strict().readonly();
const ReceiptSchema = z.object({
  schema_version: z.literal(3),
  kind: z.literal("longmemeval-source-assertion-semantic-supplement"),
  mapping_basis: z.literal("source-draft-to-current-anchor-v3"),
  created_at: z.string().datetime(),
  primary_identity: PrimaryIdentitySchema,
  source_identity: IdentitySchema,
  coverage_audit_sha256: Sha256Schema,
  grounding_audit_sha256: Sha256Schema,
  entry_count: PositiveCountSchema,
  assertion_count: PositiveCountSchema,
  occurrence_count: PositiveCountSchema,
  entry_set_sha256: Sha256Schema,
  entries: z.array(EntrySchema).nonempty().readonly(),
  receipt_sha256: Sha256Schema
}).strict().readonly();
export const SourceAssertionSupplementBindingSchema = z.object({
  kind: z.literal("longmemeval-source-assertion-semantic-supplement"),
  receipt_schema_version: z.literal(3),
  mapping_basis: z.literal("source-draft-to-current-anchor-v3"),
  receipt_sha256: Sha256Schema,
  entry_count: PositiveCountSchema,
  assertion_count: PositiveCountSchema,
  occurrence_count: PositiveCountSchema,
  entry_set_sha256: Sha256Schema,
  primary_manifest_sha256: Sha256Schema,
  source_manifest_sha256: Sha256Schema,
  parser_semantics: z.string().trim().min(1),
  grounding_semantics: z.string().trim().min(1)
}).strict().readonly();

export interface SourceAssertionSupplementPrimaryIdentity {
  readonly manifestSha256: string;
  readonly model: string;
  readonly modelFamily: string;
  readonly requestProfile: ExtractionRequestProfile;
  readonly systemPromptSha256: string;
  readonly parserSemantics: string;
  readonly groundingSemantics: string;
}

export interface SourceAssertionSupplementSourceIdentity {
  readonly manifestSha256: string;
  readonly model: string;
  readonly modelFamily: string;
  readonly requestProfile: ExtractionRequestProfile;
  readonly systemPromptSha256: string;
}

export type SourceAssertionSupplementReceipt = z.infer<typeof ReceiptSchema>;

export type SourceAssertionSupplementBinding = z.infer<
  typeof SourceAssertionSupplementBindingSchema
>;

export interface SourceAssertionSupplementBatchReceipt {
  readonly semanticSupplementReceiptSha256: string;
  readonly receiptEntrySha256: string;
  readonly sidecarProjectionSha256: string;
  readonly primaryCacheKey: string;
  readonly sourceCacheKey: string;
  readonly sourceRawJsonSha256: string;
  readonly primaryRawJsonSha256: string;
  readonly selectedRawJsonSha256: string;
  readonly sourceCorpusIdentity: string;
  readonly anchorAssertionIds: readonly number[];
  readonly sourceObservationSha256s: readonly string[];
  readonly occurrenceCount: number;
  readonly rawSignalCount: number;
  readonly draftCount: number;
}

interface CreateEntryInput {
  readonly primaryCacheKey: string;
  readonly request: OfficialApiExtractionRequest;
  readonly sourceCacheKey: string;
  readonly sourceRawJson: string;
  readonly primaryRawJson: string;
  readonly sourceCorpus: string;
  readonly anchorAssertionIds: readonly number[];
  readonly sourceDraftBindings?: readonly SourceDraftAnchorInput[];
  readonly occurrenceCount: number;
}

export function createSourceAssertionSupplementReceipt(input: {
  readonly createdAt: string;
  readonly primaryIdentity: SourceAssertionSupplementPrimaryIdentity;
  readonly sourceIdentity: SourceAssertionSupplementSourceIdentity;
  readonly coverageAuditSha256: string;
  readonly groundingAuditSha256: string;
  readonly entries: readonly CreateEntryInput[];
}): SourceAssertionSupplementReceipt {
  const entries = input.entries.map(buildEntry).sort((left, right) =>
    bytewiseCompare(left.primary_cache_key, right.primary_cache_key)
  );
  const unsigned = {
    schema_version: 3 as const,
    kind: "longmemeval-source-assertion-semantic-supplement" as const,
    mapping_basis: "source-draft-to-current-anchor-v3" as const,
    created_at: input.createdAt,
    primary_identity: encodePrimaryIdentity(input.primaryIdentity),
    source_identity: encodeSourceIdentity(input.sourceIdentity),
    coverage_audit_sha256: input.coverageAuditSha256,
    grounding_audit_sha256: input.groundingAuditSha256,
    entry_count: entries.length,
    assertion_count: entries.reduce(
      (total, entry) => total + entry.source_observation_sha256s.length,
      0
    ),
    occurrence_count: entries.reduce(
      (total, entry) => total + entry.occurrence_count,
      0
    ),
    entry_set_sha256: computeSourceAssertionSupplementReceiptEntrySetSha256(entries),
    entries
  };
  return parseSourceAssertionSupplementReceipt({
    ...unsigned,
    receipt_sha256: digest(JSON.stringify(unsigned))
  }, "created receipt");
}

export function parseSourceAssertionSupplementReceipt(
  value: unknown,
  label: string
): SourceAssertionSupplementReceipt {
  const parsed = ReceiptSchema.safeParse(value);
  if (!parsed.success) throw invalidReceipt(label);
  const receipt = parsed.data;
  assertReceiptDerivedFields(receipt, label);
  return receipt;
}

export function sourceAssertionSupplementBinding(
  receipt: SourceAssertionSupplementReceipt
): Readonly<SourceAssertionSupplementBinding> {
  return SourceAssertionSupplementBindingSchema.parse({
    kind: receipt.kind,
    receipt_schema_version: receipt.schema_version,
    mapping_basis: receipt.mapping_basis,
    receipt_sha256: receipt.receipt_sha256,
    entry_count: receipt.entry_count,
    assertion_count: receipt.assertion_count,
    occurrence_count: receipt.occurrence_count,
    entry_set_sha256: receipt.entry_set_sha256,
    primary_manifest_sha256: receipt.primary_identity.manifest_sha256,
    source_manifest_sha256: receipt.source_identity.manifest_sha256,
    parser_semantics: receipt.primary_identity.parser_semantics,
    grounding_semantics: receipt.primary_identity.grounding_semantics
  });
}

export interface SourceAssertionSupplementReader {
  readonly receipt: SourceAssertionSupplementReceipt;
  readBatch(input: SourceAssertionSupplementBatchInput): Readonly<{
    readonly rawJson: string;
    readonly receipt: SourceAssertionSupplementBatchReceipt | null;
  }>;
}

export interface SourceAssertionSupplementBatchInput {
  readonly request: OfficialApiExtractionRequest;
  readonly primaryCacheKey: string;
  readonly primaryRawJson: string;
  readonly sourceCorpus: string;
}

export function createSourceAssertionSupplementReader(input: {
  readonly receipt: unknown;
  readonly primaryIdentity: SourceAssertionSupplementPrimaryIdentity;
  readonly sourceManifestSha256: string;
  readonly readSourceRawJson: (cacheKey: string) => string;
}): SourceAssertionSupplementReader {
  const receipt = parseSourceAssertionSupplementReceipt(input.receipt, "supplement receipt");
  if (!isDeepStrictEqual(receipt.primary_identity, encodePrimaryIdentity(
    input.primaryIdentity
  )) || receipt.source_identity.manifest_sha256 !== input.sourceManifestSha256) {
    throw new Error("source assertion supplement identity mismatch");
  }
  const byPrimaryKey = new Map(
    receipt.entries.map((entry) => [entry.primary_cache_key, entry])
  );
  return Object.freeze({
    receipt,
    readBatch: (batch: SourceAssertionSupplementBatchInput) =>
      readBatch(receipt, byPrimaryKey, input.readSourceRawJson, batch)
  });
}

function readBatch(
  receipt: SourceAssertionSupplementReceipt,
  byPrimaryKey: ReadonlyMap<string, SourceAssertionSupplementReceipt["entries"][number]>,
  readSourceRawJson: (cacheKey: string) => string,
  input: SourceAssertionSupplementBatchInput
): Readonly<{
  readonly rawJson: string;
  readonly receipt: SourceAssertionSupplementBatchReceipt | null;
}> {
  const entry = byPrimaryKey.get(input.primaryCacheKey);
  if (entry === undefined) return Object.freeze({ rawJson: '{"signals":[]}', receipt: null });
  assertRequestBinding(entry, input.request);
  if (computeOfficialApiSourceCorpusIdentity(input.sourceCorpus) !==
      entry.source_corpus_identity) {
    throw new Error("source assertion supplement source corpus identity drifted");
  }
  if (digest(input.primaryRawJson) !== entry.primary_raw_json_sha256) {
    throw new Error("source assertion supplement primary raw bytes drifted");
  }
  assertGroundedPrimaryGap({
    bindings: entry.source_draft_bindings,
    primaryRawJson: input.primaryRawJson,
    sourceCorpus: input.sourceCorpus
  });
  const sourceRawJson = readSourceRawJson(entry.source_cache_key);
  if (digest(sourceRawJson) !== entry.source_raw_json_sha256) {
    throw new Error("source assertion supplement source raw bytes drifted");
  }
  const selected = selectBoundSourceDrafts(entry, sourceRawJson, input);
  const rawJson = JSON.stringify({ signals: selected });
  if (selected.length !== entry.selected_draft_count ||
      digest(rawJson) !== entry.selected_raw_json_sha256) {
    throw new Error("source assertion supplement selected projection drifted");
  }
  const projection = sourceAssertionSupplementSidecarProjection(entry);
  return Object.freeze({ rawJson, receipt: Object.freeze({
    semanticSupplementReceiptSha256: receipt.receipt_sha256,
    receiptEntrySha256: computeSourceAssertionSupplementReceiptEntrySha256(entry),
    sidecarProjectionSha256:
      computeSourceAssertionSupplementSidecarProjectionSha256(projection),
    ...projection
  }) });
}

function selectBoundSourceDrafts(
  entry: SourceAssertionSupplementReceipt["entries"][number],
  sourceRawJson: string,
  input: SourceAssertionSupplementBatchInput
): ReturnType<typeof selectSourceDraftsByAnchorBindings> {
  try {
    return selectSourceDraftsByAnchorBindings(
      sourceRawJson,
      entry.source_draft_bindings,
      input.request,
      input.sourceCorpus
    );
  } catch (cause) {
    const primary = entry.primary_cache_key.slice(0, CACHE_KEY_DIAGNOSTIC_PREFIX_CHARS);
    const source = entry.source_cache_key.slice(0, CACHE_KEY_DIAGNOSTIC_PREFIX_CHARS);
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `source assertion supplement batch ${primary}/${source}: ${causeMessage}`,
      { cause }
    );
  }
}

function buildEntry(input: CreateEntryInput): SourceAssertionSupplementReceipt["entries"][number] {
  const request = parseOfficialApiExtractionRequest(input.request);
  const anchorAssertionIds = [...input.anchorAssertionIds].sort((left, right) => left - right);
  assertAssertionIdsBound(request, anchorAssertionIds);
  const bindings = buildSourceDraftAnchorBindings({
    sourceRawJson: input.sourceRawJson,
    sourceCorpus: input.sourceCorpus,
    request,
    assertionIds: anchorAssertionIds,
    ...(input.sourceDraftBindings === undefined
      ? {}
      : { explicit: input.sourceDraftBindings })
  });
  assertGroundedPrimaryGap({
    bindings,
    primaryRawJson: input.primaryRawJson,
    sourceCorpus: input.sourceCorpus
  });
  const selected = selectSourceDraftsByAnchorBindings(
    input.sourceRawJson,
    bindings,
    request,
    input.sourceCorpus
  );
  if (selected.length === 0) {
    throw new Error("source assertion supplement entry selects no valid drafts");
  }
  const observationSha256s = sourceObservationSha256s(bindings);
  const selectedRawJson = JSON.stringify({ signals: selected });
  return EntrySchema.parse({
    primary_cache_key: input.primaryCacheKey,
    primary_request_sha256: digest(stringifyOfficialApiExtractionRequest(request)),
    source_corpus_identity: request.source_corpus_identity,
    source_cache_key: input.sourceCacheKey,
    source_raw_json_sha256: digest(input.sourceRawJson),
    primary_raw_json_sha256: digest(input.primaryRawJson),
    anchor_assertion_ids: anchorAssertionIds,
    source_observation_sha256s: observationSha256s,
    source_draft_bindings: bindings,
    occurrence_count: input.occurrenceCount,
    selected_draft_count: selected.length,
    selected_raw_json_sha256: digest(selectedRawJson)
  });
}

function assertRequestBinding(
  entry: SourceAssertionSupplementReceipt["entries"][number],
  request: OfficialApiExtractionRequest
): void {
  if (entry.primary_request_sha256 !== digest(stringifyOfficialApiExtractionRequest(request)) ||
      entry.source_corpus_identity !== request.source_corpus_identity) {
    throw new Error("source assertion supplement request identity drifted");
  }
  assertAssertionIdsBound(request, entry.anchor_assertion_ids);
}

function assertAssertionIdsBound(
  request: OfficialApiExtractionRequest,
  assertionIds: readonly number[]
): void {
  const allowed = new Set(request.source_assertions.map(({ assertion_id }) => assertion_id));
  if (new Set(assertionIds).size !== assertionIds.length ||
      assertionIds.some((assertionId, index) =>
        !allowed.has(assertionId) || (index > 0 && assertionIds[index - 1]! >= assertionId)
      )) {
    throw new Error("source assertion supplement assertion ids are not a sorted request subset");
  }
}

function assertReceiptDerivedFields(
  receipt: SourceAssertionSupplementReceipt,
  label: string
): void {
  const entries = receipt.entries;
  const sorted = entries.every((entry, index) =>
    index === 0 || bytewiseCompare(entries[index - 1]!.primary_cache_key,
      entry.primary_cache_key) < 0
  );
  const { receipt_sha256: _receiptSha256, ...unsigned } = receipt;
  const sameLogicalModel = receipt.primary_identity.model === receipt.source_identity.model &&
    receipt.primary_identity.model_family === receipt.source_identity.model_family &&
    receipt.primary_identity.request_profile === receipt.source_identity.request_profile;
  if (!sorted || !sameLogicalModel || receipt.entry_count !== entries.length ||
      receipt.assertion_count !== entries.reduce(
        (total, entry) => total + entry.source_observation_sha256s.length, 0
      ) || receipt.occurrence_count !== entries.reduce(
        (total, entry) => total + entry.occurrence_count, 0
      ) || entries.some((entry) => !hasValidDerivedBindings(entry)) ||
      receipt.entry_set_sha256 !==
        computeSourceAssertionSupplementReceiptEntrySetSha256(entries) ||
      receipt.receipt_sha256 !== digest(JSON.stringify(unsigned))) {
    throw invalidReceipt(label);
  }
}

function hasValidDerivedBindings(
  entry: SourceAssertionSupplementReceipt["entries"][number]
): boolean {
  return hasValidAnchorBindingShape(
    entry.source_draft_bindings,
    entry.anchor_assertion_ids,
    entry.source_observation_sha256s
  );
}

function encodePrimaryIdentity(input: SourceAssertionSupplementPrimaryIdentity) {
  return PrimaryIdentitySchema.parse({
    manifest_sha256: input.manifestSha256,
    model: input.model,
    model_family: input.modelFamily,
    request_profile: input.requestProfile,
    system_prompt_sha256: input.systemPromptSha256,
    parser_semantics: input.parserSemantics,
    grounding_semantics: input.groundingSemantics
  });
}

function encodeSourceIdentity(input: SourceAssertionSupplementSourceIdentity) {
  return IdentitySchema.parse({
    manifest_sha256: input.manifestSha256,
    model: input.model,
    model_family: input.modelFamily,
    request_profile: input.requestProfile,
    system_prompt_sha256: input.systemPromptSha256
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function invalidReceipt(label: string): Error {
  return new Error(`source assertion supplement receipt is invalid: ${label}`);
}
