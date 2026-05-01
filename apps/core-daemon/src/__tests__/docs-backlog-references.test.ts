import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../../..");
const docsRoot = path.join(repositoryRoot, "docs");

const allowedBl014References = [
  {
    file: "docs/handbook/backlog.md",
    line: "### #BL-014 — Historical Gate-2 R1 wave-close commit hygiene gap"
  },
  {
    file: "docs/handbook/backlog.md",
    line: "drift was corrected from `#BL-014` to `#BL-015`. This does not close"
  },
  {
    file: "docs/handbook/backlog.md",
    line: "`#BL-014`; closure still requires commit-history evidence from a future"
  },
  {
    file: "docs/v0.1/phase-4-briefs/README.md",
    line: "Open follow-up issues after this repair are `#BL-014` and the post-port"
  },
  {
    file: "docs/v0.1/phase-4-briefs/reports/gate-4-closeout.md",
    line: "- `#BL-014` remains open: this batch corrected a docs reference, but"
  },
  {
    file: "docs/v0.1/phase-2-briefs/reports/post-gate-2-review.md",
    line: "records prevention without history rewrite or R1 exemption. `#BL-014`"
  },
  {
    file: "docs/v0.1/phase-2-briefs/reports/post-gate-2-review.md",
    line: "- **Fix-Loop Disposition**: Same as I1; commit `2dde29d` and `#BL-014`"
  },
  {
    file: "docs/v0.1/phase-2-briefs/reports/post-gate-2-review.md",
    line: "rewrite. Added backlog issue `#BL-014` and tightened"
  },
  {
    file: "docs/v0.1/phase-4-briefs/reports/round-3-review.md",
    line: "| `#BL-014` / `#BL-015` / `#BL-021` wording inconsistencies | `#BL-014` keeps Open status with an explicit note that this round touched documentation references but did not close the issue. `#BL-015` title narrowed to delivery/usage records. `#BL-021` moved under a new \"Accepted divergences (registered, not closed)\" subsection in `backlog.md`, semantically aligned with `port-protocol.md:104`'s Registered Divergences section. |"
  }
];

describe("docs backlog references", () => {
  it("keeps #BL-014 references limited to the historical Gate-2 hygiene issue", () => {
    expect(findBacklogReferences("#BL-014")).toEqual(sortReferences(allowedBl014References));
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
      const relativePath = path.relative(repositoryRoot, filePath);
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

function sortReferences(
  references: Array<{ file: string; line: string }>
): Array<{ file: string; line: string }> {
  return [...references].sort(compareReferences);
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
