import { z } from "zod";
import { BoundedIdSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { FieldContractDigestSchema, type FieldContractSha256 } from "./field-contract/canonical-identity.js";
import { canonicalJson } from "./selection/capture/canonical-json.js";
import type { SourceIndexBudget, SourceIndexGeneration, SourceIndexGuardedWriteResult, SourceIndexReadResult,
  SourceIndexResources, SourceIndexTarget, SourceIndexWriteResult } from "./source-index.js";

/** Absence of explicit selection retains the historical raw/default SourceIndex reader. */
export const SourceIndexLexicalRepresentationSchema = z.enum(["raw-unicode61.v1", "segmented-unicode61.v1"]);
export type SourceIndexLexicalRepresentation = z.infer<typeof SourceIndexLexicalRepresentationSchema>;
export const SourceIndexLexicalSelectionSchema = z.object({ workspace_id: BoundedIdSchema,
  selection_revision: NonNegativeIntSchema, representation: SourceIndexLexicalRepresentationSchema }).strict().readonly();
export type SourceIndexLexicalSelection = z.infer<typeof SourceIndexLexicalSelectionSchema>;
export const SourceIndexLexicalBindingSchema = SourceIndexLexicalSelectionSchema.unwrap().extend({
  generation_id: FieldContractDigestSchema, source_epoch: NonNegativeIntSchema
}).strict().readonly();
export type SourceIndexLexicalBinding = z.infer<typeof SourceIndexLexicalBindingSchema>;
export type SourceIndexLexicalGeneration = Omit<SourceIndexGeneration, "selection" | "preparation_revision"> & {
  readonly selection: SourceIndexLexicalSelection;
};
export type SourceIndexLexicalState = Readonly<{ selection: SourceIndexLexicalSelection;
  active_generation_id: string | null }> | null;
export type SourceIndexLexicalCaptureResult = Readonly<{ generation: SourceIndexLexicalGeneration;
  added: number; resources: SourceIndexResources }>;
/** Work additionally charges one analysis unit per UTF-16 input code unit actually analyzed.
 * This is neither measured CPU nor model work. Native bytes retain their existing read meaning. */
export type SourceIndexLexicalPreparationResult = Readonly<{ status: "ready" | "partial" | "unavailable" | "stale" | "superseded" | "unbound";
  reason: string | null; resources: SourceIndexResources; analysis_units: number }>;

export type SourceIndexLexicalPassBudget = SourceIndexBudget & Readonly<{
  capture_page: number; max_capture_pages: number; max_roots: number; max_body_bytes: number;
}>;
export type SourceIndexLexicalPassResult = SourceIndexLexicalPreparationResult & Readonly<{
  selection: SourceIndexLexicalSelection; generation: SourceIndexLexicalGeneration | null;
  accounting: "complete" | "lower_bound"; model_inputs: 0;
}>;

/** Independent lexical selection and generation, under the existing SourceIndex owner and source epoch. */
export interface SourceIndexLexicalRepository {
  selectLexical(workspaceId: string, representation: SourceIndexLexicalRepresentation): SourceIndexLexicalSelection;
  lexicalState(workspaceId: string): SourceIndexLexicalState;
  beginLexical(selection: SourceIndexLexicalSelection): SourceIndexLexicalGeneration;
  lexicalGeneration(workspaceId: string, generationId: string): SourceIndexLexicalGeneration | null;
  captureLexicalPage(workspaceId: string, generationId: string, limit: number, budget: SourceIndexBudget): SourceIndexLexicalCaptureResult;
  pendingLexicalTarget(workspaceId: string, generationId: string, budget: SourceIndexBudget): Readonly<{
    source: SourceIndexTarget | null; resources: SourceIndexResources; complete: boolean }>;
  readLexicalDocument(workspaceId: string, generationId: string, rootKey: string, maxBytes: number,
    budget: SourceIndexBudget): SourceIndexReadResult;
  /** Storage analyzes exact bytes itself under the declared representation; callers cannot supply projections. */
  writeLexicalDocument(workspaceId: string, generationId: string, source: SourceIndexTarget, body: string,
    budget: SourceIndexBudget): SourceIndexGuardedWriteResult & Readonly<{ analysis_units: number }>;
  activateLexical(workspaceId: string, generationId: string): SourceIndexWriteResult;
}
export function sourceIndexLexicalGenerationId(selection: SourceIndexLexicalSelection, sourceEpoch: number,
  sha256: FieldContractSha256): string {
  return `sha256:${sha256(canonicalJson(["source-index-lexical-generation.v1",
    SourceIndexLexicalSelectionSchema.parse(selection), sourceEpoch]))}`;
}
