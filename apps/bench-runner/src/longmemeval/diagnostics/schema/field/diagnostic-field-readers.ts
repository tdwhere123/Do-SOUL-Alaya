import { z } from "zod";
import { RecallAnswerShapePlanSchema } from
  "../../../../harness/recall/answer-trace-schema.js";
import { RecallFieldRefinementStopCertificateSchema,
  RecallFiniteFieldChannelCaptureSchema, RecallQueryEntityExtractionCaptureSchema,
  RecallQueryFactFrameExtractionCaptureSchema,
  RecallRetrievalFieldRefinementReceiptSchema } from
  "../../../../harness/recall/field-capture-schema.js";
import { OpenSemanticFactorActivationReceiptSchema,
  OpenSemanticFactorCompatibilityTraceSchema, OpenSemanticFactorCompositionReceiptSchema,
  OpenSemanticFactorFormationCaptureSchema } from
  "../../../../harness/recall/semantic-factors/open-semantic-factor-diagnostics-schema.js";
import { readDiagnosticQueryProbes, readStringArray } from
  "../../artifacts/diagnostics-candidate-readers.js";
import type { NarrowRecallDiagnostics } from "../diagnostics-types.js";

type DiagnosticFields = Pick<NarrowRecallDiagnostics,
  | "queryProbes" | "retrievalFieldCaptures" | "retrievalFieldRefinementReceipts"
  | "fieldRefinementStopCertificate" | "queryEntityExtraction"
  | "queryFactFrameExtraction" | "queryOpenSemanticFactorFormation"
  | "openSemanticFactorCompatibilityTrace" | "openSemanticFactorComposition"
  | "openSemanticFactorActivation" | "answerShapePlan" | "querySoughtFacets">;

export function readDiagnosticFields(
  record: Readonly<Record<string, unknown>>
): DiagnosticFields | null {
  const readers = diagnosticFieldReaders();
  const values = Object.fromEntries(Object.entries(readers).map(([key, reader]) =>
    [key, reader(record)]
  )) as unknown as DiagnosticFields;
  return Object.entries(readers).some(([key]) =>
    invalidPresentField(record, values, key as keyof DiagnosticFields)
  ) ? null : values;
}

function invalidPresentField(
  record: Readonly<Record<string, unknown>>,
  values: DiagnosticFields,
  key: keyof DiagnosticFields
): boolean {
  const wireValue = record[diagnosticFieldWireKey(key)];
  if (wireValue === undefined || (key === "answerShapePlan" && wireValue === null)) {
    return false;
  }
  return values[key] === null;
}

function diagnosticFieldReaders() {
  return {
    queryProbes: (record: Readonly<Record<string, unknown>>) =>
      readDiagnosticQueryProbes(record.query_probes),
    retrievalFieldCaptures: schemaReader("retrieval_field_captures",
      z.array(RecallFiniteFieldChannelCaptureSchema).readonly()),
    retrievalFieldRefinementReceipts: schemaReader("retrieval_field_refinement_receipts",
      z.array(RecallRetrievalFieldRefinementReceiptSchema).readonly()),
    fieldRefinementStopCertificate: schemaReader("field_refinement_stop_certificate",
      RecallFieldRefinementStopCertificateSchema),
    queryEntityExtraction: schemaReader("query_entity_extraction",
      RecallQueryEntityExtractionCaptureSchema),
    queryFactFrameExtraction: schemaReader("query_fact_frame_extraction",
      RecallQueryFactFrameExtractionCaptureSchema),
    queryOpenSemanticFactorFormation: schemaReader("query_open_semantic_factor_formation",
      OpenSemanticFactorFormationCaptureSchema),
    openSemanticFactorCompatibilityTrace: schemaReader("open_semantic_factor_compatibility_trace",
      OpenSemanticFactorCompatibilityTraceSchema),
    openSemanticFactorComposition: schemaReader("open_semantic_factor_composition",
      OpenSemanticFactorCompositionReceiptSchema),
    openSemanticFactorActivation: schemaReader("open_semantic_factor_activation",
      OpenSemanticFactorActivationReceiptSchema),
    answerShapePlan: schemaReader("answer_shape_plan", RecallAnswerShapePlanSchema),
    querySoughtFacets: (record: Readonly<Record<string, unknown>>) =>
      readStringArray(record.query_sought_facets)
  } as const;
}

function schemaReader<T>(wireKey: string, schema: z.ZodType<T>) {
  return (record: Readonly<Record<string, unknown>>): T | null => {
    const value = record[wireKey];
    if (value === undefined || value === null) return null;
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
}

function diagnosticFieldWireKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
