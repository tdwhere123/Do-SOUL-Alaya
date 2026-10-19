import { z } from "zod";
import { AlayaError, countSourceSemanticCorrespondenceJsonBytes,
  SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES } from "@do-soul/alaya-protocol";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";

/** Private generation context, never a workset selector or a native cross-H proof dependency. */
export type CorrespondenceGenerationContext = Readonly<{
  target_interpretation_id: string;
  additional_interpretation: SourceSemanticCorrespondenceRequest["source_interpretation_descriptors"][number];
}>;
const ContextShape = z.object({ target_interpretation_id: z.string(), additional_interpretation: z.unknown() }).strict();

/** Descriptor semantics belong exclusively to the native request builder at materialization. */
export function captureCorrespondenceGenerationContext(value: CorrespondenceGenerationContext): CorrespondenceGenerationContext {
  const captured = structuredClone(value);
  ContextShape.parse(captured);
  // A single extra descriptor cannot exceed the complete native C request budget.
  countSourceSemanticCorrespondenceJsonBytes(captured, SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES);
  freezeCapturedContext(captured);
  return captured;
}
function freezeCapturedContext(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeCapturedContext(child);
  Object.freeze(value);
}

export function contextualCorrespondenceDescriptors(
  descriptors: SourceSemanticCorrespondenceRequest["source_interpretation_descriptors"],
  context: CorrespondenceGenerationContext
) {
  if (descriptors.length !== 1 || descriptors[0]!.source_interpretation_id !== context.target_interpretation_id ||
      context.additional_interpretation?.source_interpretation_id === context.target_interpretation_id) {
    throw new AlayaError("CONFLICT", "correspondence context requires one unchanged target and one distinct additional interpretation");
  }
  return [...descriptors, context.additional_interpretation];
}
