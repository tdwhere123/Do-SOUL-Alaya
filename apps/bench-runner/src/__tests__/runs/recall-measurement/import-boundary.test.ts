import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";
import { expect, it } from "vitest";

it("keeps retained measurement and comparison imports independent of private research pipelines", () => {
  const sourceRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const pending = ["runs/recall-measurement/launch.ts", "runs/longmemeval-semantic/launch.ts",
    "runs/source-access-diagnostic/launch.ts", "runs/page-support-comparison/input.ts",
    "runs/recall-measurement/ordinary/ordinary-recall.ts", "diagnostics/diagnostics.ts"]
    .map(path => resolve(sourceRoot, path));
  const visited = new Set<string>();
  const forbidden = /(?:[/\\](?:semantic-chain|semantic-proposal)[/\\]|source-semantic-(?:research|joint|qualified)-)/u;
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    expect(path).not.toMatch(forbidden);
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/\b(?:researchAcquisition|researchLibrary|SourceSemanticJointSelection|QualifiedSourceSelection|ResearchSourceObservation|bindResearchFixedSourcePool)\b/u);
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      if (!imported.fileName.startsWith(".")) continue;
      const target = resolve(dirname(path), imported.fileName.replace(/\.js$/u, ".ts"));
      expect(target).not.toMatch(forbidden);
      if (target.startsWith(`${sourceRoot}${sep}`) && existsSync(target)) pending.push(target);
    }
  }
  expect(visited.has(resolve(sourceRoot, "runs/recall-measurement/replay.ts"))).toBe(true);
  expect(visited.has(resolve(sourceRoot, "runs/semantic-cache/results.ts"))).toBe(true);
  expect(visited.has(resolve(sourceRoot, "runs/page-support-comparison/original.ts"))).toBe(true);
});
