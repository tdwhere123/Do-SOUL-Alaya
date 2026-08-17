import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSelectionReplayGoldMap } from
  "../../../longmemeval/selection-replay/order-ledger/gold-map.js";
import {
  firstCapturedToLiveMembershipOwner,
  formulaOperatorIdFromTraces
} from "../../../longmemeval/selection-replay/order-ledger/recompute.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

describe("captured-to-live membership owner", () => {
  it("attributes captured-versus-live membership changes to Gamma", () => {
    const captured = [
      stage("coarse", ["a", "b"]),
      stage("fusion", ["a", "b"]),
      stage("deep_head", ["a", "b"]),
      stage("select_gamma", ["a", "b"]),
      stage("final_budget", ["a", "b"])
    ];
    const live = [
      stage("coarse", ["a", "b"]),
      stage("fusion", ["a", "b"]),
      stage("deep_head", ["a", "b"]),
      stage("select_gamma", ["b"]),
      stage("final_budget", ["b"])
    ];

    expect(firstCapturedToLiveMembershipOwner(captured, live, "a"))
      .toBe("select_gamma");
  });

  it("fails closed when captured-to-live coarse membership diverges", () => {
    expect(() => firstCapturedToLiveMembershipOwner(
      [stage("coarse", ["a", "b"])],
      [stage("coarse", ["a"])],
      "b"
    )).toThrow(/captured-to-live coarse membership diverged/u);
  });
});

describe("recompute_live formula operator receipts", () => {
  it("reads the operator from traces and fails on mixed or missing ids", () => {
    expect(formulaOperatorIdFromTraces([
      { formula_operator_id: "op_a" },
      { formula_operator_id: "op_a" }
    ])).toBe("op_a");
    expect(() => formulaOperatorIdFromTraces([
      { formula_operator_id: "op_a" },
      { formula_operator_id: "other_operator" }
    ])).toThrow(/mixed formula_operator_id/u);
    expect(() => formulaOperatorIdFromTraces([{ }])).toThrow(
      /missing formula_operator_id/u
    );
    expect(() => formulaOperatorIdFromTraces([])).toThrow(
      /missing formula_operator_id/u
    );
  });
});

describe("selection replay gold map", () => {
  it("throws on duplicate question_id and non-string gold_object_ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "selection-replay-gold-map-"));
    roots.push(root);
    const duplicatePath = join(root, "duplicate-gold.json");
    await writeFile(duplicatePath, `${JSON.stringify({
      questions: [
        goldRow("q1", ["gold-a"]),
        goldRow("q1", ["gold-b"])
      ]
    })}\n`);
    await expect(loadSelectionReplayGoldMap(duplicatePath)).rejects.toThrow(
      /duplicate question_id q1/u
    );

    const nonStringPath = join(root, "non-string-gold.json");
    await writeFile(nonStringPath, `${JSON.stringify({
      questions: [goldRow("q2", [1])]
    })}\n`);
    await expect(loadSelectionReplayGoldMap(nonStringPath)).rejects.toThrow(
      /gold_object_ids for q2 must be strings/u
    );
  });

  it("rejects missing booleans and duplicate gold object ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "selection-replay-gold-map-"));
    roots.push(root);
    const missingBooleanPath = join(root, "missing-boolean.json");
    await writeFile(missingBooleanPath, `${JSON.stringify({
      questions: [{
        question_id: "q1",
        is_abstention: false,
        gold_object_ids: ["gold-a"]
      }]
    })}\n`);
    await expect(loadSelectionReplayGoldMap(missingBooleanPath)).rejects.toThrow(
      /question row is invalid/u
    );

    const duplicateIdPath = join(root, "duplicate-id.json");
    await writeFile(duplicateIdPath, `${JSON.stringify({
      questions: [goldRow("q2", ["gold-a", "gold-a"])]
    })}\n`);
    await expect(loadSelectionReplayGoldMap(duplicateIdPath)).rejects.toThrow(
      /gold_object_ids for q2 must be unique/u
    );
  });
});

function stage(owner: string, memberKeys: readonly string[]) {
  return { owner, memberKeys };
}

function goldRow(questionId: string, goldObjectIds: readonly unknown[]) {
  return {
    question_id: questionId,
    is_abstention: false,
    premise_invalid: false,
    gold_object_ids: goldObjectIds
  };
}
