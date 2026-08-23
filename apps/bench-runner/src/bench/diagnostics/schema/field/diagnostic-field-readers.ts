import { z } from "zod";
import { QueryOsfSemanticCompletenessReceiptSchema } from "@do-soul/alaya-protocol";
import { RecallAnswerShapePlanSchema } from
  "../../../../harness/recall/answer-trace-schema.js";
import { RecallQueryConditionParitySchema } from
  "../../../../harness/recall/field/field-projection-diagnostics-schema.js";
import { RecallFieldRefinementStopCertificateSchema,
  RecallFiniteFieldChannelCaptureSchema, RecallQueryEntityExtractionCaptureSchema,
  RecallQueryFactFrameExtractionCaptureSchema,
  RecallRetrievalFieldRefinementReceiptSchema } from
  "../../../../harness/recall/field-capture-schema.js";
import { OpenSemanticFactorActivationReceiptSchema,
  OpenSemanticFactorCompatibilityTraceSchema, OpenSemanticFactorCompositionReceiptSchema,
  OpenSemanticFactorFormationCaptureSchema } from
  "../../../../harness/recall/semantic-factors/open-semantic-factor-diagnostics-schema.js";
import { KindConstraintAlignmentReceiptSchema } from "../field-diagnostics-schema.js";
import { readDiagnosticQueryProbes, readStringArray } from
  "../../artifacts/diagnostics-candidate-readers.js";
import type { NarrowRecallDiagnostics } from "../diagnostics-types.js";
import {
  isStaleOpenSemanticFactorField,
  openSemanticFactorArchiveMarker,
  type OpenSemanticFactorArchive,
  type OpenSemanticFactorCutoverWireKey
} from "./open-semantic-factor-archive.js";

type DiagnosticFields = Pick<NarrowRecallDiagnostics,
  | "queryProbes" | "retrievalFieldCaptures" | "retrievalFieldRefinementReceipts"
  | "fieldRefinementStopCertificate" | "queryCondition" | "queryEntityExtraction"
  | "queryFactFrameExtraction" | "queryOpenSemanticFactorFormation"
  | "queryOpenSemanticFactorCompletenessReceipt"
  | "openSemanticFactorCompatibilityTrace" | "openSemanticFactorComposition"
  | "openSemanticFactorActivation" | "kindConstraintAlignment"
  | "openSemanticFactorArchive"
  | "answerShapePlan" | "querySoughtFacets">;

export function readDiagnosticFields(
  record: Readonly<Record<string, unknown>>
): DiagnosticFields | null {
  const readers = diagnosticFieldReaders();
  const values = Object.fromEntries(Object.entries(readers).map(([key, reader]) =>
    [key, reader(record)]
  )) as unknown as Omit<DiagnosticFields, "openSemanticFactorArchive">;
  const openSemanticFactorArchive = readOpenSemanticFactorArchive(record, values);
  if (Object.entries(readers).some(([key]) =>
    invalidPresentField(record, values, key as keyof typeof values)
  )) return null;
  return { ...values, openSemanticFactorArchive };
}

function invalidPresentField(
  record: Readonly<Record<string, unknown>>,
  values: Omit<DiagnosticFields, "openSemanticFactorArchive">,
  key: keyof Omit<DiagnosticFields, "openSemanticFactorArchive">
): boolean {
  const wireKey = diagnosticFieldWireKey(key);
  const wireValue = record[wireKey];
  if (wireValue === undefined || (key === "answerShapePlan" && wireValue === null)) {
    return false;
  }
  if (values[key] !== null) return false;
  return !isStaleCutoverField(wireKey, wireValue);
}

function readOpenSemanticFactorArchive(
  record: Readonly<Record<string, unknown>>,
  values: Omit<DiagnosticFields, "openSemanticFactorArchive">
): OpenSemanticFactorArchive | null {
  const stale = (
    ["openSemanticFactorCompatibilityTrace", "openSemanticFactorComposition",
      "openSemanticFactorActivation"] as const
  ).some((key) => {
    const wireKey = diagnosticFieldWireKey(key) as OpenSemanticFactorCutoverWireKey;
    const wireValue = record[wireKey];
    return wireValue != null && values[key] === null &&
      isStaleOpenSemanticFactorField(wireValue, wireKey);
  });
  return stale ? openSemanticFactorArchiveMarker() : null;
}

function isStaleCutoverField(wireKey: string, wireValue: unknown): boolean {
  return wireKey in {
    open_semantic_factor_compatibility_trace: true,
    open_semantic_factor_composition: true,
    open_semantic_factor_activation: true
  } && isStaleOpenSemanticFactorField(
    wireValue,
    wireKey as OpenSemanticFactorCutoverWireKey
  );
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
    queryCondition: schemaReader("query_condition", RecallQueryConditionParitySchema),
    queryEntityExtraction: schemaReader("query_entity_extraction",
      RecallQueryEntityExtractionCaptureSchema),
    queryFactFrameExtraction: schemaReader("query_fact_frame_extraction",
      RecallQueryFactFrameExtractionCaptureSchema),
    queryOpenSemanticFactorFormation: schemaReader("query_open_semantic_factor_formation",
      OpenSemanticFactorFormationCaptureSchema),
    queryOpenSemanticFactorCompletenessReceipt: schemaReader(
      "query_open_semantic_factor_completeness_receipt",
      QueryOsfSemanticCompletenessReceiptSchema
    ),
    openSemanticFactorCompatibilityTrace: schemaReader("open_semantic_factor_compatibility_trace",
      OpenSemanticFactorCompatibilityTraceSchema),
    openSemanticFactorComposition: schemaReader("open_semantic_factor_composition",
      OpenSemanticFactorCompositionReceiptSchema),
    openSemanticFactorActivation: schemaReader("open_semantic_factor_activation",
      OpenSemanticFactorActivationReceiptSchema),
    kindConstraintAlignment: schemaReader("kind_constraint_alignment",
      KindConstraintAlignmentReceiptSchema),
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
