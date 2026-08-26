export const CANARY_Q1 = "e47becba";
export const CANARY_Q2 = "118b2229";
export const CANARY_Q3 = "51a45a95";

export const CANARY_NEGATIVE_CONTROL_IDS = [
  CANARY_Q2,
  CANARY_Q3
] as const;

export const CANARY_QUESTION_IDS = [
  CANARY_Q1,
  CANARY_Q2,
  CANARY_Q3
] as const;

export const CANARY_QUERY_TEXTS = {
  [CANARY_Q1]: "What degree did I graduate with?",
  [CANARY_Q2]: "How long is my daily commute to work?",
  [CANARY_Q3]: "Where did I redeem a $5 coupon on coffee creamer?"
} as const;

export type CanaryQuestionId = (typeof CANARY_QUESTION_IDS)[number];

export function normalizeCanaryQuestionId(questionId: string): string {
  const prefix = questionId.slice(0, 8).toLowerCase();
  return (CANARY_QUESTION_IDS as readonly string[]).includes(prefix)
    ? prefix
    : questionId;
}

export function isNamedNegativeControl(questionId: string): boolean {
  return (CANARY_NEGATIVE_CONTROL_IDS as readonly string[]).includes(
    normalizeCanaryQuestionId(questionId)
  );
}
