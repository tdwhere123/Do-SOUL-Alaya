import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openContainedArtifact } from "../../../cli/merge/contained-artifact-path.js";

describe("contained artifact descriptors", () => {
  it("keeps reading the validated inode after its path is swapped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "contained-artifact-"));
    const artifactPath = path.join(root, "artifact.json");
    const outsidePath = path.join(root, "outside.json");
    await writeFile(artifactPath, "original", "utf8");
    await writeFile(outsidePath, "outside", "utf8");
    const artifact = await openContainedArtifact(root, "artifact.json");
    expect(artifact).not.toBeNull();
    try {
      await rm(artifactPath);
      await symlink(outsidePath, artifactPath);
      await expect(artifact!.readUtf8(1024)).resolves.toBe("original");
      await expect(readFile(artifactPath, "utf8")).resolves.toBe("outside");
    } finally {
      await artifact?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
