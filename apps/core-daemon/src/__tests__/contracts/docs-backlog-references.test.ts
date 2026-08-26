import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toPosixPath } from "../support/test-paths.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../../../..");
const docsRoot = path.join(repositoryRoot, "docs");

describe("docs backlog references", () => {
  it("does not reintroduce #BL-014 into live docs", () => {
    expect(findBacklogReferences("#BL-014")).toEqual([]);
  });

  it("does not document Inspector embedding config GET as an embedding-status proxy", () => {
    const inspectorEmbeddingConfigRoute = /\/api\/config\/:[^/]+\/embedding-supplement/u;

    expect(
      findDocLines((line) => inspectorEmbeddingConfigRoute.test(line) && line.includes("/embedding-status"))
    ).toEqual([]);
  });

  it("does not document Inspector embedding config PATCH as a local .env writer", () => {
    expect(
      findDocLines(
        (line) =>
          line.includes("PATCH /api/config/runtime/embedding-supplement") &&
          line.includes("writes") &&
          line.includes(".env")
      )
    ).toEqual([]);
    expect(
      findDocLines((line) => line.includes("embedding-supplement PATCH path writes") && line.includes(".env"))
    ).toEqual([]);
  });
});

function findBacklogReferences(issueId: string): Array<{ file: string; line: string }> {
  return findDocLines((line) => line.includes(issueId));
}

function findDocLines(predicate: (line: string) => boolean): Array<{ file: string; line: string }> {
  return listMarkdownFiles(docsRoot)
    .flatMap((filePath) => {
      const relativePath = toPosixPath(path.relative(repositoryRoot, filePath));
      return readFileSync(filePath, "utf8")
        .split(/\r?\n/u)
        .filter(predicate)
        .map((line) => ({
          file: relativePath,
          line: line.trim()
        }));
    })
    .sort(compareReferences);
}

function compareReferences(left: { file: string; line: string }, right: { file: string; line: string }): number {
  return `${left.file}\0${left.line}`.localeCompare(`${right.file}\0${right.line}`);
}

function listMarkdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listMarkdownFiles(entryPath);
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      return [entryPath];
    }
    return [];
  });
}
