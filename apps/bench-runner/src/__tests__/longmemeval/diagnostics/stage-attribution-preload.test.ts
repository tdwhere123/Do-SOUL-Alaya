import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeStageAttributionTables } from
  "../../../diagnostics/stage-attribution/write-tables.js";
import { baseQuestion } from "./stage-attribution-fixture.js";

const { loadRecallEvalQuestionDiagnostics } = vi.hoisted(() => ({
  loadRecallEvalQuestionDiagnostics: vi.fn()
}));

vi.mock(
  "../../../diagnostics/stage-attribution/load-recall-eval-diagnostics.js",
  () => ({ loadRecallEvalQuestionDiagnostics })
);

const roots: string[] = [];

afterEach(async () => {
  loadRecallEvalQuestionDiagnostics.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stage attribution preload", () => {
  it("does not reread gzip when both arms already have questions", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "stage-attr-preload-"));
    roots.push(outDir);
    const control = [baseQuestion({ question_id: "q-a", hit_at_5: true })];
    const treatment = [baseQuestion({ question_id: "q-a", hit_at_5: true })];

    const tables = await writeStageAttributionTables({
      outDir,
      cells: [
        { cell: "A", diagnosticsPath: "/unused/control.json.gz", questions: control },
        { cell: "B", diagnosticsPath: "/unused/treatment.json.gz", questions: treatment }
      ]
    });

    expect(loadRecallEvalQuestionDiagnostics).not.toHaveBeenCalled();
    expect(tables.A.questions).toHaveLength(1);
    expect(tables.B.questions).toHaveLength(1);
  });
});
