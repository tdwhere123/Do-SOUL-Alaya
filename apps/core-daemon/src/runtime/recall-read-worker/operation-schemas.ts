import { z } from "zod";
import { PreparedQuerySchema } from "./prepared-source-query.js";
import {
  AuthorizedScopesAdmissionSchema,
  SourceSemanticWorkerRequestSchema, SourceSemanticWorkerResultSchema,
  SoulActiveConstraintSchema,
  type BoundedActiveConstraintsRequest
} from "@do-soul/alaya-protocol";
import {
  BoundedActiveConstraintsResultSchema,
  ConditionalFieldRecallPortResultSchema,
  ConditionalFieldRecallWorkerPayloadSchema,
  type RecallReadWorkerOperation
} from "./protocol.js";

const EmptyObjectSchema = z.object({}).strict();
const AcknowledgeSchema = z.object({
  preparation_id: z.string(),
  issued_entry_ids: z.array(z.string()).readonly(),
  previews: z.record(z.string(), z.string()),
  settlement: z.instanceof(SharedArrayBuffer)
    .refine(buffer => buffer.byteLength === Int32Array.BYTES_PER_ELEMENT).optional()
}).strict();
const DiscardSchema = z.object({
  preparation_id: z.string()
}).strict();

export const BoundedRequestSchema = z.object({
  workspaceId: z.string(),
  asOf: z.string(),
  snapshotId: z.string().optional(),
  authorizedScopes: AuthorizedScopesAdmissionSchema.optional(),
  cap: z.number().nullable().optional(),
  nativeLimit: z.number(),
  byteLimit: z.number()
}).strict();

type BoundedRequestPayload = z.infer<typeof BoundedRequestSchema>;
type BoundedPayloadFitsRequest = BoundedRequestPayload extends BoundedActiveConstraintsRequest ? true : false;
const boundedPayloadFitsRequest: BoundedPayloadFitsRequest = true;
void boundedPayloadFitsRequest;

/** Public callers cannot supply a vector, selected profile or generation. */
export const SourceSemanticsPublicPayloadSchema = z.object({
  workspace_id: z.string().min(1), as_of: z.string().datetime(), lifetime_now: z.string().datetime().optional(),
  authorized_scopes: AuthorizedScopesAdmissionSchema, principal: z.string().min(1).max(256).optional(),
  expires_at: z.string().datetime().optional(), request: SourceSemanticWorkerRequestSchema
}).strict();
export type SourceSemanticsPublicPayload = z.infer<typeof SourceSemanticsPublicPayloadSchema>;

const PAYLOAD_SCHEMAS = {
  ready: EmptyObjectSchema,
  close: EmptyObjectSchema,
  "snapshot.beginDeferred": EmptyObjectSchema,
  "snapshot.commit": EmptyObjectSchema,
  "snapshot.rollback": EmptyObjectSchema,
  "conditionalField.recall": ConditionalFieldRecallWorkerPayloadSchema,
  "conditionalField.sourceSemantics": SourceSemanticsPublicPayloadSchema.extend({
    prepared_query: PreparedQuerySchema.optional()
  }).strict(),
  "conditionalField.acknowledge": AcknowledgeSchema,
  "conditionalField.discard": DiscardSchema,
  "constraints.findActive": z.object({
    workspaceId: z.string(),
    cap: z.number().nullable().optional(),
    asOf: z.string().optional()
  }).strict(),
  "constraints.readBounded": BoundedRequestSchema
} satisfies Record<RecallReadWorkerOperation, z.ZodTypeAny>;

export type WorkerOperationPayloadMap = {
  [K in RecallReadWorkerOperation]: z.infer<(typeof PAYLOAD_SCHEMAS)[K]>;
};

export type WorkerOperationPayload<O extends RecallReadWorkerOperation> =
  WorkerOperationPayloadMap[O];

/** Parsed operation/payload pair derived from PAYLOAD_SCHEMAS. Independent unions are not this type. */
export type ParsedWorkerOperation<O extends RecallReadWorkerOperation = RecallReadWorkerOperation> = {
  [K in O]: {
    readonly operation: K;
    readonly payload: WorkerOperationPayloadMap[K];
  };
}[O];

const RESULT_SCHEMAS = {
  ready: z.null(),
  close: z.null(),
  "snapshot.beginDeferred": z.null(),
  "snapshot.commit": z.null(),
  "snapshot.rollback": z.null(),
  "conditionalField.recall": ConditionalFieldRecallPortResultSchema,
  "conditionalField.sourceSemantics": SourceSemanticWorkerResultSchema,
  // Receipt fields are owned by core; this boundary only requires the version tag.
  "conditionalField.acknowledge": z.union([
    z.null(),
    z.object({ schema_version: z.number() }).passthrough()
  ]),
  "conditionalField.discard": z.null(),
  "constraints.findActive": z.object({
    constraints: z.array(SoulActiveConstraintSchema).readonly(),
    total_count: z.number()
  }).strict(),
  "constraints.readBounded": BoundedActiveConstraintsResultSchema
} satisfies Record<RecallReadWorkerOperation, z.ZodTypeAny>;

export function parseWorkerOperationPayload<O extends RecallReadWorkerOperation>(
  operation: O,
  payload: unknown
): WorkerOperationPayload<O> {
  return PAYLOAD_SCHEMAS[operation].parse(payload ?? {}) as WorkerOperationPayload<O>;
}

export function parseWorkerOperation<O extends RecallReadWorkerOperation>(
  operation: O,
  payload: unknown
): ParsedWorkerOperation<O> {
  // Zod infers each schema separately; this is the single post-parse association.
  return {
    operation,
    payload: parseWorkerOperationPayload(operation, payload)
  } as ParsedWorkerOperation<O>;
}

export function parseWorkerOperationResult(
  operation: RecallReadWorkerOperation,
  result: unknown
): unknown {
  return RESULT_SCHEMAS[operation].parse(result);
}

export function parseConditionalFieldRecallPayload(payload: unknown) {
  return ConditionalFieldRecallWorkerPayloadSchema.parse(payload ?? {});
}

export type WorkerBoundedRequest = BoundedRequestPayload;
