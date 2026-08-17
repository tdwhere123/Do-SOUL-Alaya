import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildStageAttributionTables } from "./build-tables.js";
import { loadRecallEvalQuestionDiagnostics } from "./load-recall-eval-diagnostics.js";
import type { StageAttributionTables } from "./types.js";

export async function buildStageAttributionFromRecallEvalGzip(input: {
  readonly cell: string;
  readonly diagnosticsPath: string;
}): Promise<StageAttributionTables> {
  const questions = await loadRecallEvalQuestionDiagnostics(input.diagnosticsPath);
  return buildStageAttributionTables({
    cell: input.cell,
    sourceDiagnostics: input.diagnosticsPath,
    questions
  });
}

export async function writeStageAttributionTables(input: {
  readonly outDir: string;
  readonly cells: readonly {
    readonly cell: "A" | "B";
    readonly diagnosticsPath: string;
  }[];
}): Promise<Readonly<Record<"A" | "B", StageAttributionTables>>> {
  await mkdir(input.outDir, { recursive: true });
  const result = {} as Record<"A" | "B", StageAttributionTables>;
  const summaryByCell: Record<string, StageAttributionTables["summary"]> = {};

  for (const cell of input.cells) {
    const tables = await buildStageAttributionFromRecallEvalGzip({
      cell: cell.cell,
      diagnosticsPath: cell.diagnosticsPath
    });
    result[cell.cell] = tables;
    summaryByCell[cell.cell] = tables.summary;
    const outPath = path.join(
      input.outDir,
      `stage-tables-${cell.cell.toLowerCase()}.json`
    );
    await writeFile(outPath, `${JSON.stringify(tables, null, 2)}\n`, "utf8");
  }

  await writeFile(
    path.join(input.outDir, "stage-tables-summary.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        kind: "gate1-stage-attribution-summary",
        cells: summaryByCell
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return result;
}
