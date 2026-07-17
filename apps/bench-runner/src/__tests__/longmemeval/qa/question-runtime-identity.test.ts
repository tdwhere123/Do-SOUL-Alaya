import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLongMemEvalQuestionRuntimeIdentity } from "../../../longmemeval/selection/question-runtime-identity.js";

const longMemEvalSDatasetPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../data/longmemeval/longmemeval_s.json"
);

describe("LongMemEval question runtime identity", () => {
  it("keeps base and abstention question workspaces distinct", () => {
    const base = buildLongMemEvalQuestionRuntimeIdentity("eeda8a6d");
    const abstention = buildLongMemEvalQuestionRuntimeIdentity("eeda8a6d_abs");

    const baseDigest = createHash("sha256").update("eeda8a6d").digest("hex");
    expect(base).toEqual({ workspaceId: `lme-${baseDigest}`, runId: `run-${baseDigest}` });
    expect(abstention.workspaceId).toMatch(/^lme-[a-f0-9]{64}$/u);
    expect(abstention.runId).toMatch(/^run-[a-f0-9]{64}$/u);
    expect(base.workspaceId).not.toBe(abstention.workspaceId);
    expect(base.runId).not.toBe(abstention.runId);
  });

  it.skipIf(!existsSync(longMemEvalSDatasetPath))(
    "is unique for every LongMemEval-S question id",
    async () => {
      const raw = await readFile(longMemEvalSDatasetPath, "utf8");
      const questions = JSON.parse(raw) as readonly { readonly question_id: string }[];
      const identities = questions.map((question) =>
        buildLongMemEvalQuestionRuntimeIdentity(question.question_id)
      );
      expect(questions).toHaveLength(500);
      expect(new Set(identities.map((identity) => identity.workspaceId)).size).toBe(500);
      expect(new Set(identities.map((identity) => identity.runId)).size).toBe(500);
    }
  );
});
