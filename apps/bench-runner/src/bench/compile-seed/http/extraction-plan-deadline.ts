const EXTRACTION_PLAN_DEADLINE = Symbol("extractionPlanDeadline");

type ExtractionPlanDeadlineError = Error & {
  readonly [EXTRACTION_PLAN_DEADLINE]: true;
};

export function createExtractionPlanDeadlineError(): ExtractionPlanDeadlineError {
  const error = new Error("extraction request plan deadline exceeded") as
    ExtractionPlanDeadlineError;
  Object.defineProperty(error, EXTRACTION_PLAN_DEADLINE, { value: true });
  return error;
}

export function isExtractionPlanDeadlineError(
  value: unknown
): value is ExtractionPlanDeadlineError {
  return value instanceof Error &&
    (value as Partial<ExtractionPlanDeadlineError>)[EXTRACTION_PLAN_DEADLINE] === true;
}
