import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../../..");
const docsRoot = path.join(repositoryRoot, "docs");

// Resolved 2026-05-03 by p5-system-review-r2 commit 964e12a; the only
// remaining live reference is the Resolved header. Historical references
// in older Phase-2 / Phase-4 reports are preserved as point-in-time
// records and remain in the allowed set.
const allowedBl014References = [
  {
    file: "docs/handbook/backlog.md",
    line: "### #BL-014 — Resolved (atomic fix-commit hygiene proven by p5-system-review-r1+r2)"
  },
  {
    file: "docs/archive/v0.1-port-record/phase-4-briefs/README.md",
    line: "`#BL-014` through p5-system-review atomic fix-commit evidence,"
  },
  {
    file: "docs/archive/v0.1-port-record/phase-4-briefs/reports/gate-4-closeout.md",
    line: "- `#BL-014` remains open: this batch corrected a docs reference, but"
  },
  {
    file: "docs/archive/v0.1-port-record/phase-2-briefs/reports/post-gate-2-review.md",
    line: "records prevention without history rewrite or R1 exemption. `#BL-014`"
  },
  {
    file: "docs/archive/v0.1-port-record/phase-2-briefs/reports/post-gate-2-review.md",
    line: "- **Fix-Loop Disposition**: Same as I1; commit `2dde29d` and `#BL-014`"
  },
  {
    file: "docs/archive/v0.1-port-record/phase-2-briefs/reports/post-gate-2-review.md",
    line: "rewrite. Added backlog issue `#BL-014` and tightened"
  },
  {
    file: "docs/archive/v0.1-port-record/phase-4-briefs/reports/round-3-review.md",
    line: "| `#BL-014` / `#BL-015` / `#BL-021` wording inconsistencies | `#BL-014` keeps Open status with an explicit note that this round touched documentation references but did not close the issue. `#BL-015` title narrowed to delivery/usage records. `#BL-021` moved under a new \"Accepted divergences (registered, not closed)\" subsection in `backlog.md`, semantically aligned with `port-protocol.md:104`'s Registered Divergences section. |"
  },
  {
    file: "docs/archive/v0.1-port-record/phase-5-briefs/reports/p5-system-review-round-3.md",
    line: "#BL-014 (atomic commit hygiene; proven by this very wave)"
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
