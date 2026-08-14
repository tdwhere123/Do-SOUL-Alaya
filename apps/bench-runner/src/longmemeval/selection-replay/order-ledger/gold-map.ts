import { createHash } from "node:crypto";
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

export type SelectionReplayGoldMap = Readonly<{
  readonly byQuestion: ReadonlyMap<string, SelectionReplayGoldQuestion>;
  readonly sha256: string;
}>;

export async function loadSelectionReplayGoldMap(
  goldMapPath: string
): Promise<SelectionReplayGoldMap> {
  const raw = await readFile(goldMapPath);
  const payload = JSON.parse(raw.toString("utf8")) as unknown;
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== "questions") ||
      !Array.isArray(payload.questions)) {
    throw new Error("selection replay gold map questions are missing");
  }
  const goldByQuestion = new Map<string, SelectionReplayGoldQuestion>();
  for (const rawQuestion of payload.questions) {
    const question = requireQuestionRow(rawQuestion);
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
  return Object.freeze({
    byQuestion: goldByQuestion,
    sha256: createHash("sha256").update(raw).digest("hex")
  });
}

function requireQuestionRow(value: unknown): GoldMapQuestionRow {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !==
      "gold_object_ids,is_abstention,premise_invalid,question_id" ||
      typeof value.is_abstention !== "boolean" ||
      typeof value.premise_invalid !== "boolean") {
    throw new Error("selection replay gold map question row is invalid");
  }
  return value as GoldMapQuestionRow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireQuestionId(questionId: unknown): string {
  if (typeof questionId !== "string" || questionId.trim().length === 0 ||
      questionId !== questionId.trim()) {
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
  if (goldObjectIds.some((objectId) => typeof objectId !== "string" ||
      objectId.trim().length === 0 || objectId !== objectId.trim())) {
    throw new Error(
      `selection replay gold map gold_object_ids for ${questionId} must be strings`
    );
  }
  if (new Set(goldObjectIds).size !== goldObjectIds.length) {
    throw new Error(
      `selection replay gold map gold_object_ids for ${questionId} must be unique`
    );
  }
  return Object.freeze([...goldObjectIds] as string[]);
}
