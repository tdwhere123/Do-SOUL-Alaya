import { createHash } from "node:crypto";

export interface LongMemEvalQuestionRuntimeIdentity {
  readonly workspaceId: string;
  readonly runId: string;
}

export function buildLongMemEvalQuestionRuntimeIdentity(
  questionId: string
): LongMemEvalQuestionRuntimeIdentity {
  const digest = createHash("sha256").update(questionId, "utf8").digest("hex");
  return Object.freeze({
    workspaceId: `lme-${digest}`,
    runId: `run-${digest}`
  });
}
