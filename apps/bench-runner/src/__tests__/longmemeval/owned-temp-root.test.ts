import { access, readFile, readdir, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createOwnedTempRoot,
  finalizeOwnedTempRoot
} from "../../longmemeval/lifecycle/owned-temp-root.js";

describe("owned benchmark temp roots", () => {
  it("removes an owned root after success", async () => {
    const root = await createOwnedTempRoot("alaya-owned-success-");
    await finalizeOwnedTempRoot(root, true);
    await expect(access(root.path)).rejects.toThrow();
  });

  it("retains an owned root after failure and reports its path", async () => {
    const warn = vi.fn();
    const root = await createOwnedTempRoot("alaya-owned-failure-");
    await finalizeOwnedTempRoot(root, false, warn);

    await expect(access(root.path)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(root.path));
    await finalizeOwnedTempRoot(root, true);
  });

  it("replaces oversized failed databases with bounded evidence", async () => {
    const root = await createOwnedTempRoot("alaya-owned-oversized-");
    await writeFile(join(root.path, "alaya.db"), "", "utf8");
    await truncate(join(root.path, "alaya.db"), 513 * 1024 * 1024);

    await finalizeOwnedTempRoot(root, false, vi.fn());

    await expect(readFile(join(root.path, "FAILED_RUN_EVIDENCE.txt"), "utf8"))
      .resolves.toContain("pruned");
    await expect(access(join(root.path, "alaya.db"))).rejects.toThrow();
    await finalizeOwnedTempRoot(root, true);
  });

  it("prunes only marked failures and preserves concurrent active siblings", async () => {
    const active = await Promise.all([
      createOwnedTempRoot("alaya-owned-prune-"),
      createOwnedTempRoot("alaya-owned-prune-")
    ]);
    const failures = [];
    for (let index = 0; index < 5; index += 1) {
      const failed = await createOwnedTempRoot("alaya-owned-prune-");
      failures.push(failed);
      await finalizeOwnedTempRoot(failed, false, vi.fn());
    }

    await Promise.all(active.map((root) => expect(access(root.path)).resolves.toBeUndefined()));
    const parent = join(active[0]!.path, "..");
    const siblings = await readdir(parent, { withFileTypes: true });
    let markedFailures = 0;
    for (const sibling of siblings) {
      if (!sibling.isDirectory() || !sibling.name.startsWith("alaya-owned-prune-")) continue;
      try {
        await access(join(parent, sibling.name, "FAILED_RUN_EVIDENCE.txt"));
        markedFailures += 1;
      } catch {
        // Active siblings deliberately have no failure marker.
      }
    }
    expect(markedFailures).toBe(3);

    await Promise.all([...active, ...failures].map((root) =>
      finalizeOwnedTempRoot(root, true)
    ));
  });
});
