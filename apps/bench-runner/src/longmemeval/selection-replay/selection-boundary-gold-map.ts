import { readFile } from "node:fs/promises";

export type SelectionReplayGoldQuestion = Readonly<{
  readonly answerable: boolean;
  readonly goldObjectIds: readonly string[];
}>;

type GoldMapQuestionRow = Readonly<{
  readonly question_id: unknown;
  readonly is_abstention: boolean;
  readonly premise_invalid: boolean;
  readonly gold_object_ids: unknown;
}>;

export async function loadSelectionReplayGoldMap(
  goldMapPath: string
): Promise<ReadonlyMap<string, SelectionReplayGoldQuestion>> {
  const payload = JSON.parse(await readFile(goldMapPath, "utf8")) as Readonly<{
    readonly questions: readonly GoldMapQuestionRow[];
  }>;
  if (!Array.isArray(payload.questions)) {
    throw new Error("selection replay gold map questions are missing");
  }
  const goldByQuestion = new Map<string, SelectionReplayGoldQuestion>();
  for (const question of payload.questions) {
    const questionId = requireQuestionId(question.question_id);
    if (goldByQuestion.has(questionId)) {
      throw new Error(
        `selection replay gold map has duplicate question_id ${questionId}`
      );
    }
    goldByQuestion.set(questionId, Object.freeze({
      answerable: !question.is_abstention && !question.premise_invalid,
      goldObjectIds: requireGoldObjectIds(questionId, question.gold_object_ids)
    }));
  }
  return goldByQuestion;
}

function requireQuestionId(questionId: unknown): string {
  if (typeof questionId !== "string" || questionId.length === 0) {
    throw new Error("selection replay gold map question_id must be a string");
  }
  return questionId;
}

function requireGoldObjectIds(
  questionId: string,
  goldObjectIds: unknown
): readonly string[] {
  if (!Array.isArray(goldObjectIds)) {
    throw new Error(
      `selection replay gold map gold_object_ids for ${questionId} must be strings`
    );
  }
  if (goldObjectIds.some((objectId) => typeof objectId !== "string")) {
    throw new Error(
      `selection replay gold map gold_object_ids for ${questionId} must be strings`
    );
  }
  return Object.freeze([...goldObjectIds]);
}
