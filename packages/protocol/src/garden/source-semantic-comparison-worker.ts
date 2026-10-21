import { z } from "zod";
import { AlayaError } from "../shared/alaya-error.js";
import { SourceSemanticWorkerResultSchema, SourceSemanticWorkerRequestSchema, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, refineSourceSemanticQueryRequest, refineSourceSemanticLibraryDelivery } from "./source-semantic-worker.js";
import { SourceSemanticProfiledLibraryDeliverySchema, SourceSemanticProfiledLibraryContinuationSchema, refineSourceSemanticProfiledLibraryDelivery } from "./source-semantic-profiled-library.js";
import { SourceSemanticProfiledAccessReceiptSchema } from "./source-semantic-access.js";
import { SourceSemanticProfiledExecutionSchema } from "./source-semantic-phase-wire.js";
import { SOURCE_SEMANTIC_PROFILED_ACCESS_CONTRACT, SOURCE_SEMANTIC_PROFILED_LIBRARY_PROTOCOL_VERSION }
  from "./source-semantic-access-profile.js";
import { MemorySearchResultSchema } from "../surfaces/mcp-memory-search-types.js";

import { AuthorizedScopesAdmissionSchema } from "../governance/active-constraints-policy.js";

const QueryRequest = z.object({ ...SourceSemanticWorkerRequestSchema.options[2].unwrap().shape,
  access_policy: z.never().optional(), source_handle: z.never().optional(), source_preview_extents: z.never().optional()
}).strict().superRefine(refineSourceSemanticQueryRequest);
const RecallRequest = z.object({ ...SourceSemanticWorkerRequestSchema.options[4].unwrap().shape,
  access_policy: z.never().optional(), continuation: SourceSemanticProfiledLibraryContinuationSchema.optional()
}).strict().superRefine((value, ctx) => refineSourceSemanticQueryRequest(value, ctx, true));
export const SourceSemanticComparisonWorkerRequestSchema = z.discriminatedUnion("kind", [QueryRequest, RecallRequest]);
export type SourceSemanticComparisonWorkerRequest = z.infer<typeof SourceSemanticComparisonWorkerRequestSchema>;
export type SourceSemanticReadableWorkerRequest = z.infer<typeof SourceSemanticWorkerRequestSchema> | SourceSemanticComparisonWorkerRequest;
export const SourceSemanticComparisonRequestSchema = z.discriminatedUnion("operation", [
  z.object(QueryRequest.shape).omit({ kind: true }).extend({ operation: z.literal("prepare_query"), authorized_scopes: AuthorizedScopesAdmissionSchema.optional() })
    .strict().superRefine(refineSourceSemanticQueryRequest),
  z.object(RecallRequest.shape).omit({ kind: true }).extend({ operation: z.literal("recall"), authorized_scopes: AuthorizedScopesAdmissionSchema.optional() })
    .strict().superRefine((value, ctx) => refineSourceSemanticQueryRequest(value, ctx, true))
]);

// Private comparison consumer only. Promotion or termination removes this ingress,
// never broadens the public worker/MCP request or default result family.
const Query = SourceSemanticWorkerResultSchema.options[2].unwrap().extend({
  access: SourceSemanticProfiledAccessReceiptSchema.optional(), execution: SourceSemanticProfiledExecutionSchema.optional()
});
const Recall = z.object({ ...SourceSemanticProfiledLibraryDeliverySchema.shape,
  kind: z.literal("recall"),
  previews: SourceSemanticWorkerResultSchema.options[4].unwrap().shape.previews,
  coverage: SourceSemanticWorkerResultSchema.options[4].unwrap().shape.coverage,
  work: SourceSemanticWorkerResultSchema.options[4].unwrap().shape.work
}).strict();
const refineRecall = (value: z.infer<typeof Recall>, ctx: z.RefinementCtx) => {
  refineSourceSemanticLibraryDelivery(value, ctx); refineSourceSemanticProfiledLibraryDelivery(value, ctx);
};
export const SourceSemanticComparisonWorkerResultSchema = z.discriminatedUnion("kind", [Query, Recall.superRefine(refineRecall)]);
export type SourceSemanticComparisonWorkerResult = z.infer<typeof SourceSemanticComparisonWorkerResultSchema>;
export type SourceSemanticReadableWorkerResult = z.infer<typeof SourceSemanticWorkerResultSchema> | SourceSemanticComparisonWorkerResult;

function usesComparisonResultSchema(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return "protocol_version" in value && value.protocol_version === SOURCE_SEMANTIC_PROFILED_LIBRARY_PROTOCOL_VERSION ||
    "access" in value && value.access !== null && typeof value.access === "object" &&
      "contract" in value.access && value.access.contract === SOURCE_SEMANTIC_PROFILED_ACCESS_CONTRACT ||
    "execution" in value && Array.isArray(value.execution) && Array.isArray(value.execution[2]) && value.execution[2][0] === 2;
}

// Dispatch by declared family before nested admission. A failed public parse must
// not allocate a second copy of a candidate's metered phase and coverage subtrees.
export const SourceSemanticReadableWorkerResultSchema = z.union([
  z.unknown().refine(value => !usesComparisonResultSchema(value)).pipe(SourceSemanticWorkerResultSchema),
  z.unknown().refine(usesComparisonResultSchema).pipe(SourceSemanticComparisonWorkerResultSchema)
]);
export const SourceSemanticComparisonResponseSchema = z.discriminatedUnion("operation", [
  Query.omit({ kind: true }).extend({ operation: z.literal("prepare_query") }),
  Recall.omit({ kind: true, previews: true }).extend({ operation: z.literal("recall"), results: z.array(MemorySearchResultSchema).max(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET).readonly() })
    .superRefine(refineSourceSemanticLibraryDelivery).superRefine(refineSourceSemanticProfiledLibraryDelivery)
]);
export type SourceSemanticComparisonResponse = z.infer<typeof SourceSemanticComparisonResponseSchema>;

/** Result schemas already own structural admission. Bind that admitted value to its caller
 * family without reparsing/copying the worker's metered immutable phase subtrees. */
export function admitSourceSemanticWorkerResultFamily(value: SourceSemanticReadableWorkerResult, comparison: false): z.infer<typeof SourceSemanticWorkerResultSchema>;
export function admitSourceSemanticWorkerResultFamily(value: SourceSemanticReadableWorkerResult, comparison: true): SourceSemanticComparisonWorkerResult;
export function admitSourceSemanticWorkerResultFamily(value: SourceSemanticReadableWorkerResult, comparison: boolean): SourceSemanticReadableWorkerResult;
export function admitSourceSemanticWorkerResultFamily(value: SourceSemanticReadableWorkerResult, comparison: boolean): SourceSemanticReadableWorkerResult {
  const contract = comparison ? "source-semantic-access-v3" : "source-semantic-access-v2";
  if (comparison && value.kind !== "prepare_query" && value.kind !== "recall" ||
      value.kind === "recall" && value.protocol_version !== (comparison ? 9 : 8) ||
      value.kind === "prepare_query" && value.access !== undefined && value.access.contract !== contract ||
      value.execution !== undefined && value.execution !== "native_reasoning_only" && value.execution[2][0] !== (comparison ? 2 : 1)) {
    throw new AlayaError("VALIDATION", "source worker result belongs to another contract family");
  }
  return value;
}
