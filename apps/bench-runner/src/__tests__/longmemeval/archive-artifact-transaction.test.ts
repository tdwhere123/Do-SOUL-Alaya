import { access, mkdir, mkdtemp, readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HistoryEntryCommittedError } from "@do-soul/alaya-eval";
import {
  prepareDiagnosticsArtifactStagingPath,
  withPublishedDiagnosticsArtifact
} from "../../longmemeval/measurement/artifact-transaction.js";

describe("LongMemEval full diagnostics artifact transaction", () => {
  it("removes the published artifact when archive publication fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-artifact-rollback-"));
    const stagedPath = path.join(root, "diagnostics.tmp");
    const finalPath = path.join(root, "diagnostics.json.gz");
    await writeFile(stagedPath, "evidence", "utf8");

    await expect(withPublishedDiagnosticsArtifact(
      { stagedPath, finalPath },
      async () => { throw new Error("injected archive failure"); }
    )).rejects.toThrow(/injected archive failure/u);
    await expect(access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the artifact only after archive publication succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-artifact-publish-"));
    const stagedPath = path.join(root, "diagnostics.tmp");
    const finalPath = path.join(root, "diagnostics.json.gz");
    await writeFile(stagedPath, "evidence", "utf8");

    await expect(withPublishedDiagnosticsArtifact(
      { stagedPath, finalPath },
      async () => "published"
    )).resolves.toBe("published");
    await expect(readFile(finalPath, "utf8")).resolves.toBe("evidence");
    await expect(access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains an artifact referenced by an entry committed before pointer failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-artifact-reconcile-"));
    const stagedPath = path.join(root, "diagnostics.tmp");
    const finalPath = path.join(root, "diagnostics.json.gz");
    await writeFile(stagedPath, "durable evidence", "utf8");
    const committed = new HistoryEntryCommittedError({
      slug: "2026-05-15T133000Z-c0ffee0",
      kpiPath: path.join(root, "kpi.json"),
      reportPath: path.join(root, "report.md"),
      findingsPath: path.join(root, "findings.md"),
      sidecarPaths: {}
    }, new Error("injected pointer failure"));

    await expect(withPublishedDiagnosticsArtifact(
      { stagedPath, finalPath },
      async () => { throw committed; },
      (error) => error instanceof HistoryEntryCommittedError
    )).rejects.toBe(committed);
    await expect(readFile(finalPath, "utf8")).resolves.toBe("durable evidence");
  });

  it("bounds stale staging by bytes as well as file count", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-artifact-stale-"));
    const stagingRoot = path.join(root, ".staging");
    const oversized = path.join(stagingRoot, "abandoned.tmp");
    await mkdir(stagingRoot, { recursive: true });
    await writeFile(oversized, "x");
    await truncate(oversized, 513 * 1024 * 1024);

    await prepareDiagnosticsArtifactStagingPath(root, "next");
    await expect(access(oversized)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
