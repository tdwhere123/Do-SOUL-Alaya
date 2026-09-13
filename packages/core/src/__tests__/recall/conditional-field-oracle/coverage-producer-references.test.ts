import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COVERAGE_ROWS } from "./coverage-matrix.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../../../");
const SOURCE_ROOTS = [
  join(REPO_ROOT, "packages"),
  join(REPO_ROOT, "apps")
];
const CLAIM = /(\b[\w.-]+\.ts)\s+(\w+)/g;
const REEXPORT = /^\s*export\s+/;

describe("coverage matrix real-producer references", () => {
  it("requires each claimed producer export to have a non-test production reference", () => {
    const sources = productionSources();
    for (const row of COVERAGE_ROWS) {
      if (row.binding !== "real-producer") continue;
      const claims = [...row.producer.matchAll(CLAIM)];
      for (const match of claims) {
        const file = match[1];
        const symbol = match[2];
        if (file === undefined || symbol === undefined || file.includes(".test.")) continue;
        const defining = sources.filter((source) => source.path.endsWith(`/${file}`) || source.path.endsWith(`\\${file}`));
        if (!defining.some((source) => exportedSymbol(source.text, symbol))) continue;
        const callers = productionCallers(sources, symbol, file);
        expect(callers, `${row.id} ${symbol} in ${file}`).not.toHaveLength(0);
      }
    }
  });
});

function exportedSymbol(text: string, symbol: string): boolean {
  return new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|class|type|enum)\\s+${symbol}\\b`).test(text)
    || new RegExp(`\\bexport\\s*\\{[^}]*\\b${symbol}\\b`).test(text);
}

function productionCallers(
  sources: readonly Readonly<{ path: string; text: string }>[],
  symbol: string,
  definingFile: string
): readonly string[] {
  const mention = new RegExp(`\\b${symbol}\\b`);
  const callers: string[] = [];
  for (const source of sources) {
    if (source.path.endsWith(`/${definingFile}`) || source.path.endsWith(`\\${definingFile}`)) continue;
    const lines = source.text.split("\n");
    if (lines.some((line) => mention.test(line) && !REEXPORT.test(line))) callers.push(source.path);
  }
  return callers;
}

function productionSources(): readonly Readonly<{ path: string; text: string }>[] {
  const files: Array<Readonly<{ path: string; text: string }>> = [];
  for (const root of SOURCE_ROOTS) walk(root, files);
  return files;
}

function walk(directory: string, files: Array<Readonly<{ path: string; text: string }>>): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, files);
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
    files.push({ path, text: readFileSync(path, "utf8") });
  }
}
