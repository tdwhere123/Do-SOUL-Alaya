import { z } from "zod";
import { RecordedSourceTimeSchema } from "../conversation/conversation-message.js";
import { SourceRecordIdentitySchema } from "../recall/field-contract/source-span.js";
import { BoundedIdSchema, IsoDatetimeStringSchema } from "../shared/schema-primitives.js";
import { SourceEvidenceTargetSchema } from "../recall/conditional-field/product-identity.js";
import { Sha256HexSchema } from "../recall/conditional-field/common.js";
import { canonicalJson } from "../recall/selection/capture/canonical-json.js";
import { FieldContractDigestSchema, hashContentDigest, type FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";

export const SOURCE_STATEMENTS_CONTRACT = "source-statements-v1" as const;
export const SOURCE_STATEMENT_LIMITS = Object.freeze({ text: 4096, relation: 256, perMessage: 64,
  targetBytes: 32768, contextBytes: 16384, requestMessages: 64, responseBytes: 524288 });
const Text = (max: number) => z.string().min(1).max(max)
  .refine(value => value.trim().length > 0 && !/[\uD800-\uDFFF]/u.test(value), "nonempty Unicode scalar text required");
export const SourceStatementSchema = z.object({
  text: Text(SOURCE_STATEMENT_LIMITS.text), relation: Text(SOURCE_STATEMENT_LIMITS.relation)
}).strip().readonly();
export type SourceStatement = z.infer<typeof SourceStatementSchema>;

/** Host facts. An unknown recorded time is not the ingestion clock. */
export const SourceStatementMessageSchema = z.object({
  message_id: BoundedIdSchema, role: z.string().min(1).max(256), recorded_at: IsoDatetimeStringSchema.nullable(),
  // An empty host message is observed input, unlike an empty generated statement.
  text: z.string().max(4 * 1024 * 1024).refine(value => !/[\uD800-\uDFFF]/u.test(value), "Unicode scalar text required"),
  recorded_time: RecordedSourceTimeSchema.optional()
}).strict().refine(value => value.recorded_time === undefined || value.recorded_at === value.recorded_time.normalized,
  "recorded source time must retain its normalization coordinate").readonly();
export type SourceStatementMessage = z.infer<typeof SourceStatementMessageSchema>;
export const SourceStatementRequestSchema = z.object({
  contract: z.literal(SOURCE_STATEMENTS_CONTRACT), session_id: BoundedIdSchema,
  chunk_index: z.number().int().nonnegative(),
  context: z.array(SourceStatementMessageSchema).max(SOURCE_STATEMENT_LIMITS.requestMessages).readonly(),
  messages: z.array(SourceStatementMessageSchema).min(1).max(SOURCE_STATEMENT_LIMITS.requestMessages).readonly()
}).strict().superRefine((request, ctx) => {
  const ids = [...request.context, ...request.messages].map(row => row.message_id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "message IDs must be unique" });
}).readonly();
export type SourceStatementRequest = z.infer<typeof SourceStatementRequestSchema>;

/** Parsing the envelope never requires a sibling statement to be valid. */
export const SourceStatementResponseEnvelopeSchema = z.object({
  messages: z.array(z.unknown()).max(1024)
}).strip();
export const SourceStatementResponseMessageSchema = z.object({
  message_id: BoundedIdSchema, statements: z.array(z.unknown()).max(1024)
}).strip();
export type SourceStatementRejection = Readonly<{ message_id: string | null; statement_index: number | null;
  reason: "invalid_statement" | "unknown_message" | "duplicate_message" | "missing_message" |
    "invalid_message" | "malformed_response" | "transport_failure" | "message_capacity" | "context_capacity" | "request_budget" |
    "cancelled" | "not_dispatched" | "empty_source" }>;
export type SourceStatementMessageResult = Readonly<{
  message: SourceStatementMessage; status: "complete" | "partial" | "failed";
  statements: readonly SourceStatement[]; rejections: readonly SourceStatementRejection[];
}>;
export type SourceStatementReceipt = Readonly<{
  contract: typeof SOURCE_STATEMENTS_CONTRACT; session_id: string; status: "complete" | "partial" | "failed";
  messages: readonly SourceStatementMessageResult[]; rejections: readonly SourceStatementRejection[];
  chunks: readonly Readonly<{ chunk_index: number; status: "complete" | "partial" | "failed";
    usage: Readonly<{ input_tokens: number; output_tokens: number }> | null }>[];
}>;

const SourceRecordFields = SourceRecordIdentitySchema.unwrap().shape;
/** Other model-visible raw roots; these dependencies do not become navigation roots. */
export const SourceStatementContextSourceSchema = z.object({
  workspace_id: SourceRecordFields.workspace_id, root_id: SourceRecordFields.identity,
  source_id: SourceRecordFields.source_id, source_version: SourceRecordFields.source_version,
  content_digest: SourceRecordFields.content_digest
}).strict().readonly();
export type SourceStatementContextSource = z.infer<typeof SourceStatementContextSourceSchema>;

/** A rewritten statement is not a literal quotation. Only the host message claims an exact span. */
export const LocatedSourceStatementSchema = z.object({
  contract: z.literal(SOURCE_STATEMENTS_CONTRACT), session_id: BoundedIdSchema,
  artifact_key: BoundedIdSchema, source_root_id: BoundedIdSchema, source_corpus_digest: Sha256HexSchema,
  source_context: z.array(SourceStatementContextSourceSchema).max(2 * SOURCE_STATEMENT_LIMITS.requestMessages).readonly().default([]),
  message: SourceStatementMessageSchema.refine(message => message.text.trim().length > 0 &&
    new TextEncoder().encode(message.text).length <= SOURCE_STATEMENT_LIMITS.targetBytes,
    "statement requires a nonempty message within target capacity"),
  source_span: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]).readonly(),
  statement: SourceStatementSchema
}).strict().superRefine((value, ctx) => {
  if (value.source_span[0] >= value.source_span[1]) ctx.addIssue({ code: "custom", message: "nonempty message span required" });
}).readonly();
export const BoundSourceStatementSchema = LocatedSourceStatementSchema.unwrap().safeExtend({
  source_target: SourceEvidenceTargetSchema
}).refine(value => value.source_target.root_kind === "source_record" && value.source_root_id === value.source_target.root_id,
  "statement must retain its captured source root").readonly();
export type LocatedSourceStatement = z.infer<typeof LocatedSourceStatementSchema>;
export type BoundSourceStatement = z.infer<typeof BoundSourceStatementSchema>;

export const SourceStatementArtifactSchema = z.object({
  artifact_id: BoundedIdSchema, artifact_digest: FieldContractDigestSchema,
  key_digest: FieldContractDigestSchema, key_text: z.string(), bound: BoundSourceStatementSchema
}).strict().readonly();
export type SourceStatementArtifact = z.infer<typeof SourceStatementArtifactSchema>;

/** Key material and its revision have one owner. Neither digest identifies raw source bytes. */
export function sourceStatementArtifact(bound: BoundSourceStatement, evidenceId: string,
  sha256: FieldContractSha256): SourceStatementArtifact {
  const captured = BoundSourceStatementSchema.parse(bound), key = sourceStatementKey(captured.statement);
  return SourceStatementArtifactSchema.parse({ artifact_id: evidenceId,
    artifact_digest: hashContentDigest(canonicalJson(captured), sha256),
    key_digest: hashContentDigest(key, sha256), key_text: key, bound: captured });
}

export function sourceStatementKey(statement: SourceStatement): string {
  const parsed = SourceStatementSchema.parse(statement);
  return `${parsed.text}\n${parsed.relation}`;
}
