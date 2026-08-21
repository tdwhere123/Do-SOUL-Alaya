export const GATE7_CANARY_Q1 = "e47becba";
export const GATE7_CANARY_Q2 = "118b2229";
export const GATE7_CANARY_Q3 = "51a45a95";

export const GATE7_NAMED_NEGATIVE_CONTROL_IDS = [
  GATE7_CANARY_Q2,
  GATE7_CANARY_Q3
] as const;

export const GATE7_CANARY_QUESTION_IDS = [
  GATE7_CANARY_Q1,
  GATE7_CANARY_Q2,
  GATE7_CANARY_Q3
] as const;

export const GATE7_CANARY_QUERY_TEXTS = {
  [GATE7_CANARY_Q1]: "What degree did I graduate with?",
  [GATE7_CANARY_Q2]: "How long is my daily commute to work?",
  [GATE7_CANARY_Q3]: "Where did I redeem a $5 coupon on coffee creamer?"
} as const;

export type Gate7CanaryQuestionId = (typeof GATE7_CANARY_QUESTION_IDS)[number];

export function normalizeGate7CanaryQuestionId(questionId: string): string {
  const prefix = questionId.slice(0, 8).toLowerCase();
  return (GATE7_CANARY_QUESTION_IDS as readonly string[]).includes(prefix)
    ? prefix
    : questionId;
}

export function isNamedNegativeControl(questionId: string): boolean {
  return (GATE7_NAMED_NEGATIVE_CONTROL_IDS as readonly string[]).includes(
    normalizeGate7CanaryQuestionId(questionId)
  );
}
