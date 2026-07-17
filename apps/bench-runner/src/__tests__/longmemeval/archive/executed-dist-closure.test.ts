import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The executable helper intentionally lives outside the package declaration surface.
import { computeExecutedDistClosure } from "../../../../scripts/executed-dist-closure.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("executed dist closure", () => {
  it("hashes executable workspace artifacts by stable relative path", async () => {
    const root = await mkdtemp(join(tmpdir(), "executed-dist-"));
    roots.push(root);
    await mkdir(join(root, "apps", "bench-runner", "bin"), { recursive: true });
    await mkdir(join(root, "apps", "bench-runner", "dist"), { recursive: true });
    await mkdir(join(root, "packages", "core", "dist"), { recursive: true });
    await writeFile(
      join(root, "apps", "bench-runner", "bin", "alaya-bench-runner.mjs"),
      'import "../dist/index.js";\n'
    );
    await writeFile(
      join(root, "apps", "bench-runner", "dist", "index.js"),
      'import "../../../packages/core/dist/index.js";\n'
    );
    await writeFile(join(root, "packages", "core", "dist", "index.js"), "core\n");
    await writeFile(join(root, "packages", "core", "dist", "unreachable.js"), "ignored\n");
    await writeFile(join(root, "packages", "core", "dist", "index.d.ts"), "ignored\n");

    const first = await computeExecutedDistClosure(root);
    expect(first).toMatchObject({
      algorithm: "sha256-reachable-path-file-sha256-v1",
      file_count: 3
    });
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u);
    await writeFile(join(root, "packages", "core", "dist", "unreachable.js"), "still ignored\n");
    expect((await computeExecutedDistClosure(root)).sha256).toBe(first.sha256);
    await writeFile(join(root, "packages", "core", "dist", "index.js"), "changed\n");
    expect((await computeExecutedDistClosure(root)).sha256).not.toBe(first.sha256);
  });

  it("rejects symlinks in the measured artifact trees", async () => {
    const root = await mkdtemp(join(tmpdir(), "executed-dist-link-"));
    roots.push(root);
    await mkdir(join(root, "apps", "bench-runner", "bin"), { recursive: true });
    await mkdir(join(root, "apps", "bench-runner", "dist"), { recursive: true });
    await writeFile(
      join(root, "apps", "bench-runner", "bin", "alaya-bench-runner.mjs"),
      'import "../dist/linked.js";\n'
    );
    await writeFile(join(root, "outside.js"), "outside\n");
    await symlink(join(root, "outside.js"), join(root, "apps", "bench-runner", "dist", "linked.js"));

    await expect(computeExecutedDistClosure(root)).rejects.toThrow(/symlink/u);
  });

  it("rejects a symlinked ancestor directory inside the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "executed-dist-ancestor-link-"));
    roots.push(root);
    const actualDist = join(root, "actual-dist");
    await mkdir(join(root, "apps", "bench-runner", "bin"), { recursive: true });
    await mkdir(actualDist, { recursive: true });
    await writeFile(
      join(root, "apps", "bench-runner", "bin", "alaya-bench-runner.mjs"),
      'import "../dist/index.js";\n'
    );
    await writeFile(join(actualDist, "index.js"), "export {};\n");
    await symlink(actualDist, join(root, "apps", "bench-runner", "dist"), "dir");

    await expect(computeExecutedDistClosure(root)).rejects.toThrow(/symlink/u);
  });
});
