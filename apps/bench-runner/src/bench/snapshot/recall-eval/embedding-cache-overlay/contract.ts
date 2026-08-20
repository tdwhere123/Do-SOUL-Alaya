import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import {
  readRegularFileNoFollow,
  sha256Buffer
} from "../../bound-file.js";

export const EMBEDDING_CACHE_OVERLAY_RECEIPT_SCHEMA_VERSION = 1 as const;
const MAX_RECEIPT_BYTES = 64 * 1024;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const CountSchema = z.number().int().nonnegative();

const VectorSpaceSchema = z.object({
  provider_kind: z.string().trim().min(1).max(128),
  model_id: z.string().trim().min(1).max(512),
  schema_version: z.number().int().positive(),
  dimensions: z.number().int().positive(),
  d2q_input: z.enum(["raw_content", "content_plus_hq"]),
  model_artifact_sha256: Sha256Schema.nullable()
}).strict().readonly();

const ReceiptSchema = z.object({
  schema_version: z.literal(EMBEDDING_CACHE_OVERLAY_RECEIPT_SCHEMA_VERSION),
  kind: z.literal("longmemeval_embedding_cache_overlay"),
  source: z.object({
    snapshot_db_sha256: Sha256Schema,
    snapshot_manifest_sha256: Sha256Schema,
    schema_version: z.number().int().positive(),
    recall_pipeline_version: z.string().trim().min(1).max(128)
  }).strict().readonly(),
  vector_space: VectorSpaceSchema,
  overlay: z.object({
    path: z.string().trim().min(1).max(4096),
    sha256: Sha256Schema,
    memory_embedding_count: CountSchema,
    evidence_embedding_count: CountSchema
  }).strict().readonly()
}).strict().readonly().superRefine((receipt, context) => {
  if (receipt.overlay.memory_embedding_count + receipt.overlay.evidence_embedding_count === 0) {
    context.addIssue({
      code: "custom",
      path: ["overlay"],
      message: "embedding cache overlay must contain at least one vector"
    });
  }
});

export interface EmbeddingCacheVectorSpace {
  readonly provider_kind: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly dimensions: number;
  readonly d2q_input: "raw_content" | "content_plus_hq";
  readonly model_artifact_sha256: string | null;
}

export interface EmbeddingCacheOverlaySourceBinding {
  readonly source_snapshot_db_sha256: string;
  readonly source_snapshot_manifest_sha256: string;
  readonly source_schema_version: number;
  readonly recall_pipeline_version: string;
  readonly vector_space: EmbeddingCacheVectorSpace;
}

export interface EmbeddingCacheVectorSpaceExpectation {
  readonly provider_kind: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly dimensions?: number;
  readonly d2q_input: "raw_content" | "content_plus_hq";
  readonly model_artifact_sha256: string | null;
}

export interface EmbeddingCacheOverlayExpectedSourceBinding {
  readonly source_snapshot_db_sha256: string;
  readonly source_snapshot_manifest_sha256: string;
  readonly source_schema_version: number;
  readonly recall_pipeline_version: string;
  readonly vector_space: EmbeddingCacheVectorSpaceExpectation;
}

export interface EmbeddingCacheOverlayBinding {
  readonly receipt_sha256: string;
  readonly overlay_sha256: string;
  readonly source_snapshot_db_sha256: string;
  readonly source_snapshot_manifest_sha256: string;
  readonly source_schema_version: number;
  readonly recall_pipeline_version: string;
  readonly memory_embedding_count: number;
  readonly evidence_embedding_count: number;
  readonly vector_space: EmbeddingCacheVectorSpace;
}

export interface LoadedEmbeddingCacheOverlay {
  readonly receiptPath: string;
  readonly overlayPath: string;
  readonly binding: EmbeddingCacheOverlayBinding;
}

export type EmbeddingCacheOverlayReceiptDocument = z.infer<typeof ReceiptSchema>;

export function readEmbeddingCacheOverlay(input: {
  readonly receiptPath: string;
  readonly expected: EmbeddingCacheOverlayExpectedSourceBinding;
}): LoadedEmbeddingCacheOverlay {
  const bytes = readRegularFileNoFollow(input.receiptPath, MAX_RECEIPT_BYTES);
  const receipt = parseReceipt(bytes);
  assertSourceBinding(receipt, input.expected);
  return Object.freeze({
    receiptPath: input.receiptPath,
    overlayPath: resolveOverlayPath(input.receiptPath, receipt.overlay.path),
    binding: buildBinding(receipt, sha256Buffer(bytes))
  });
}

export function buildEmbeddingCacheOverlayReceipt(input: {
  readonly source: EmbeddingCacheOverlaySourceBinding;
  readonly relativeOverlayPath: string;
  readonly overlaySha256: string;
  readonly memoryEmbeddingCount: number;
  readonly evidenceEmbeddingCount: number;
}): EmbeddingCacheOverlayReceiptDocument {
  return ReceiptSchema.parse({
    schema_version: EMBEDDING_CACHE_OVERLAY_RECEIPT_SCHEMA_VERSION,
    kind: "longmemeval_embedding_cache_overlay",
    source: {
      snapshot_db_sha256: input.source.source_snapshot_db_sha256,
      snapshot_manifest_sha256: input.source.source_snapshot_manifest_sha256,
      schema_version: input.source.source_schema_version,
      recall_pipeline_version: input.source.recall_pipeline_version
    },
    vector_space: input.source.vector_space,
    overlay: {
      path: input.relativeOverlayPath,
      sha256: input.overlaySha256,
      memory_embedding_count: input.memoryEmbeddingCount,
      evidence_embedding_count: input.evidenceEmbeddingCount
    }
  });
}

function parseReceipt(bytes: Uint8Array): EmbeddingCacheOverlayReceiptDocument {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("embedding cache overlay receipt must be valid UTF-8 JSON");
  }
  const parsed = ReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("embedding cache overlay receipt schema validation failed");
  }
  return parsed.data;
}

function assertSourceBinding(
  receipt: EmbeddingCacheOverlayReceiptDocument,
  expected: EmbeddingCacheOverlayExpectedSourceBinding
): void {
  if (receipt.source.snapshot_db_sha256 !== expected.source_snapshot_db_sha256) {
    throw new Error("embedding cache overlay source snapshot DB SHA-256 binding mismatch");
  }
  if (receipt.source.snapshot_manifest_sha256 !== expected.source_snapshot_manifest_sha256) {
    throw new Error("embedding cache overlay source snapshot manifest binding mismatch");
  }
  if (receipt.source.schema_version !== expected.source_schema_version) {
    throw new Error("embedding cache overlay source schema binding mismatch");
  }
  if (receipt.source.recall_pipeline_version !== expected.recall_pipeline_version) {
    throw new Error("embedding cache overlay recall pipeline binding mismatch");
  }
  if (!sameVectorSpace(receipt.vector_space, expected.vector_space)) {
    throw new Error("embedding cache overlay vector space binding mismatch");
  }
}

function sameVectorSpace(
  left: EmbeddingCacheVectorSpace,
  right: EmbeddingCacheVectorSpaceExpectation
): boolean {
  return left.provider_kind === right.provider_kind &&
    left.model_id === right.model_id &&
    left.schema_version === right.schema_version &&
    (right.dimensions === undefined || left.dimensions === right.dimensions) &&
    left.d2q_input === right.d2q_input &&
    left.model_artifact_sha256 === right.model_artifact_sha256;
}

function resolveOverlayPath(receiptPath: string, overlayPath: string): string {
  if (isAbsolute(overlayPath)) {
    throw new Error("embedding cache overlay path must be relative");
  }
  const receiptRoot = resolve(dirname(receiptPath));
  const resolvedPath = resolve(receiptRoot, overlayPath);
  assertWithin(receiptRoot, resolvedPath);
  const physicalRoot = realpathSync(receiptRoot);
  const physicalPath = realpathSync(resolvedPath);
  assertWithin(physicalRoot, physicalPath);
  return physicalPath;
}

function assertWithin(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot)) return;
  throw new Error("embedding cache overlay path must stay within the receipt directory");
}

function buildBinding(
  receipt: EmbeddingCacheOverlayReceiptDocument,
  receiptSha256: string
): EmbeddingCacheOverlayBinding {
  return Object.freeze({
    receipt_sha256: receiptSha256,
    overlay_sha256: receipt.overlay.sha256,
    source_snapshot_db_sha256: receipt.source.snapshot_db_sha256,
    source_snapshot_manifest_sha256: receipt.source.snapshot_manifest_sha256,
    source_schema_version: receipt.source.schema_version,
    recall_pipeline_version: receipt.source.recall_pipeline_version,
    memory_embedding_count: receipt.overlay.memory_embedding_count,
    evidence_embedding_count: receipt.overlay.evidence_embedding_count,
    vector_space: Object.freeze({ ...receipt.vector_space })
  });
}
