import { z } from "zod";
import {
  RecallFieldRefinementStopCertificateSchema,
  RecallFiniteFieldChannelCaptureSchema,
  RecallQueryEntityExtractionCaptureSchema,
  RecallQueryFactFrameExtractionCaptureSchema,
  RecallRetrievalFieldRefinementReceiptSchema
} from "../../../harness/recall/field-capture-schema.js";
import {
  OpenSemanticFactorActivationReceiptSchema,
  OpenSemanticFactorCompatibilityTraceSchema,
  OpenSemanticFactorCompositionReceiptSchema,
  OpenSemanticFactorFormationCaptureSchema
} from "../../../harness/recall/semantic-factors/open-semantic-factor-diagnostics-schema.js";

export const LongMemEvalFieldDiagnosticSchemaShape = {
  retrieval_field_captures:
    z.array(RecallFiniteFieldChannelCaptureSchema).readonly().nullable().optional(),
  retrieval_field_refinement_receipts:
    z.array(RecallRetrievalFieldRefinementReceiptSchema).readonly().nullable().optional(),
  field_refinement_stop_certificate:
    RecallFieldRefinementStopCertificateSchema.nullable().optional(),
  query_entity_extraction:
    RecallQueryEntityExtractionCaptureSchema.nullable().optional(),
  query_fact_frame_extraction:
    RecallQueryFactFrameExtractionCaptureSchema.nullable().optional(),
  query_open_semantic_factor_formation:
    OpenSemanticFactorFormationCaptureSchema.nullable().optional(),
  open_semantic_factor_compatibility_trace:
    OpenSemanticFactorCompatibilityTraceSchema.nullable().optional(),
  open_semantic_factor_composition:
    OpenSemanticFactorCompositionReceiptSchema.nullable().optional(),
  open_semantic_factor_activation:
    OpenSemanticFactorActivationReceiptSchema.nullable().optional()
} as const;
