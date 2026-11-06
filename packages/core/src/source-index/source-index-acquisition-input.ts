import { BoundedIdSchema, QuestionTimePreferenceSchema, SourceTemplateProposalSchema, type SourceIndexAcquisitionInput,
  type SourceIndexScopeAdmission } from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";

export function validateInput(input: SourceIndexAcquisitionInput, admitScope: SourceIndexScopeAdmission, rootCeiling = 16): void {
  BoundedIdSchema.parse(input.workspace_id);
  if (input.question_time !== undefined) QuestionTimePreferenceSchema.parse(input.question_time);
  if (input.source_template !== undefined) SourceTemplateProposalSchema.parse(input.source_template);
  if (typeof admitScope !== "function" || typeof input.navigation_text !== "string") {
    throw new CoreError("VALIDATION", "source index query requires captured text and scope admission");
  }
  const { max_attempts: attempts, max_roots: roots, max_vector_windows: windows } = input.allowance;
  // These are safety ceilings, not adopted product defaults or independent channel resource envelopes.
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 128 ||
      !Number.isSafeInteger(roots) || roots < 1 || roots > rootCeiling || roots > attempts ||
      !Number.isSafeInteger(windows) || windows < 0 || windows > 4096 ||
      !Number.isSafeInteger(input.budget.work_units) || input.budget.work_units < 0 ||
      !Number.isSafeInteger(input.budget.memory_bytes) || input.budget.memory_bytes < 0 ||
      input.vector.status !== "available" && input.vector.status !== "unavailable" ||
      input.vector.status === "unavailable" && (typeof input.vector.reason !== "string" ||
        input.vector.reason.length < 1 || input.vector.reason.length > 256)) {
    throw new CoreError("VALIDATION", "invalid bounded source index query allowance");
  }
}
