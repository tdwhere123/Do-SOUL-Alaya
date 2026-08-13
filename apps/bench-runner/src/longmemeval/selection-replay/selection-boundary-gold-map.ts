import { readFile } from "node:fs/promises";

export type SelectionReplayGoldQuestion = Readonly<{
  readonly answerable: boolean;
  readonly goldObjectIds: readonly string[];
}>;

export async function loadSelectionReplayGoldMap(
  goldMapPath: string
): Promise<ReadonlyMap<string, SelectionReplayGoldQuestion>> {
  const payload = JSON.parse(await readFile(goldMapPath, "utf8")) as Readonly<{
    readonly questions: readonly Readonly<{
      readonly question_id: string;
      readonly is_abstention: boolean;
      readonly premise_invalid: boolean;
      readonly gold_object_ids: readonly string[];
    }>[];
  }>;
  if (!Array.isArray(payload.questions)) {
    throw new Error("selection replay gold map questions are missing");
  }
  return new Map(payload.questions.map((question) => [
    question.question_id,
    Object.freeze({
      answerable: !question.is_abstention && !question.premise_invalid,
      goldObjectIds: Object.freeze([...question.gold_object_ids])
    })
  ]));
}
