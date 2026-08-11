import { access, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from
  "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HistoryEntryCommittedError } from "@do-soul/alaya-eval";
import {
  prepareDiagnosticsArtifactStagingPath,
  withPublishedDiagnosticsArtifact
} from "../../../longmemeval/measurement/artifact-transaction.js";

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
});

describe("LongMemEval committed diagnostics artifact transaction", () => {
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
});

describe("LongMemEval diagnostics artifact cleanup failures", () => {
  it("preserves the primary and all rollback failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-artifact-errors-"));
    const stagedPath = path.join(root, "diagnostics.tmp");
    const finalPath = path.join(root, "diagnostics.json.gz");
    await writeFile(stagedPath, "evidence", "utf8");
    const primary = new Error("archive primary");
    const finalCleanup = new Error("final cleanup");
    const stagedCleanup = new Error("staged cleanup");
    let removeCount = 0;

    try {
      await expect(withPublishedDiagnosticsArtifact(
        { stagedPath, finalPath },
        async () => { throw primary; },
        () => false,
        { remove: async (target, options) => {
          removeCount += 1;
          if (removeCount === 1) return rm(target, options);
          throw target === finalPath ? finalCleanup : stagedCleanup;
        } }
      )).rejects.toMatchObject({ errors: [primary, finalCleanup, stagedCleanup] });
      expect(removeCount).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("LongMemEval committed artifact cleanup failures", () => {
  it("preserves a committed error when staged cleanup also fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-artifact-committed-errors-"));
    const stagedPath = path.join(root, "diagnostics.tmp");
    const finalPath = path.join(root, "diagnostics.json.gz");
    await writeFile(stagedPath, "evidence", "utf8");
    const committed = new HistoryEntryCommittedError({
      slug: "2026-05-15T133000Z-c0ffee0",
      kpiPath: path.join(root, "kpi.json"),
      reportPath: path.join(root, "report.md"),
      findingsPath: path.join(root, "findings.md"),
      sidecarPaths: {}
    }, new Error("pointer failure"));
    const cleanup = new Error("staged cleanup");
    let removeCount = 0;

    try {
      await expect(withPublishedDiagnosticsArtifact(
        { stagedPath, finalPath },
        async () => { throw committed; },
        (error) => error instanceof HistoryEntryCommittedError,
        { remove: async (target, options) => {
          removeCount += 1;
          if (removeCount === 1) return rm(target, options);
          throw cleanup;
        } }
      )).rejects.toMatchObject({ errors: [committed, cleanup] });
      expect(removeCount).toBe(2);
      await expect(readFile(finalPath, "utf8")).resolves.toBe("evidence");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("LongMemEval diagnostics staging retention", () => {
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
