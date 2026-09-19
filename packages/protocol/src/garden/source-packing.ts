import { z } from "zod";
import { AlayaError } from "../shared/alaya-error.js";

/** Physical source request partitioning; excluded from assertion semantic identity. */
export const ExtractionSourcePackingSchema = z.enum(["reference-eight", "singleton", "complete-source"]);
export type ExtractionSourcePacking = z.infer<typeof ExtractionSourcePackingSchema>;
export const DEFAULT_EXTRACTION_SOURCE_PACKING: ExtractionSourcePacking = "reference-eight";

export const ReferenceTransportBatchSizeSchema = z.union([
  z.literal(1), z.literal(8), z.literal(16), z.literal(24), z.literal(32)
]);
export type ReferenceTransportBatchSize = z.infer<typeof ReferenceTransportBatchSizeSchema>;

export function extractionSourcePackingSize(packing: ExtractionSourcePacking): 1 | 8 {
  const parsed = ExtractionSourcePackingSchema.parse(packing);
  if (parsed === "complete-source") {
    throw new AlayaError("VALIDATION", "complete-source requires the source semantic whole-source owner, not fixed-size partitioning");
  }
  return parsed === "singleton" ? 1 : 8;
}
