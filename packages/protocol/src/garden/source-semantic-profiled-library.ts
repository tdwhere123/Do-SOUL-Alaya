import { z } from "zod";
import { SourceSemanticProfiledAccessReceiptSchema, type SourceSemanticProfiledAccessReceipt } from "./source-semantic-access.js";
import { SourceSemanticProfiledExecutionSchema, type SourceSemanticProfiledExecution } from "./source-semantic-phase-wire.js";
import { SOURCE_SEMANTIC_PROFILED_LIBRARY_PROTOCOL_VERSION, SOURCE_SEMANTIC_PROFILED_LIBRARY_RESULT_VERSION,
  sourceSemanticAcquisitionMatchesProfile } from "./source-semantic-access-profile.js";
import { SourceSemanticLibraryContinuationSchema, SourceSemanticLibraryDeliverySchema,
  SourceSemanticLibraryDiscoverySchema, refineSourceSemanticLibraryDelivery } from "./source-semantic-worker.js";

export const SourceSemanticProfiledLibraryContinuationSchema = SourceSemanticLibraryContinuationSchema.unwrap().extend({
  result_version: z.literal(SOURCE_SEMANTIC_PROFILED_LIBRARY_RESULT_VERSION)
}).readonly();

/** Profiled response admission. Validation cannot mint handles, run acquisition or project a live delivery.
 * Native-only describes this request, independently of the frozen access provenance. */
export const SourceSemanticProfiledLibraryDeliverySchema = z.object({
  ...SourceSemanticLibraryDeliverySchema.shape,
  protocol_version: z.literal(SOURCE_SEMANTIC_PROFILED_LIBRARY_PROTOCOL_VERSION),
  index: SourceSemanticLibraryDeliverySchema.shape.index.unwrap().extend({
    result_version: z.literal(SOURCE_SEMANTIC_PROFILED_LIBRARY_RESULT_VERSION),
    continuation: SourceSemanticProfiledLibraryContinuationSchema.nullable()
  }).readonly(),
  discovery: SourceSemanticLibraryDiscoverySchema.unwrap().extend({ access: SourceSemanticProfiledAccessReceiptSchema }).readonly(),
  execution: SourceSemanticProfiledExecutionSchema
}).strict().superRefine(refineSourceSemanticLibraryDelivery).superRefine(refineSourceSemanticProfiledLibraryDelivery);
export function refineSourceSemanticProfiledLibraryDelivery(value: Readonly<{ execution: SourceSemanticProfiledExecution;
  discovery: Readonly<{ access: SourceSemanticProfiledAccessReceipt }> }>, ctx: z.RefinementCtx): void {
  if (value.execution === "native_reasoning_only") return;
  const body = value.execution[2][2];
  if (!sourceSemanticAcquisitionMatchesProfile(value.discovery.access.profile,
    { policy: body[0], channels: body[1], declared_allowance: body[2] })) {
    ctx.addIssue({ code: "custom", message: "execution and retained access belong to different profiles" });
  }
}
export type SourceSemanticProfiledLibraryDelivery = z.infer<typeof SourceSemanticProfiledLibraryDeliverySchema>;
