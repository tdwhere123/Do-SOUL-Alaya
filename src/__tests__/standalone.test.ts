import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("standalone prototype boundary", () => {
  it("does not inherit do-what aliases or import do-what packages", () => {
    const tsconfig = JSON.parse(readFileSync(join(prototypeRoot, "tsconfig.json"), "utf8")) as {
      extends?: unknown;
      compilerOptions?: { paths?: unknown };
    };
    const packageJson = JSON.parse(readFileSync(join(prototypeRoot, "package.json"), "utf8")) as {
      engines?: { node?: string };
      devDependencies?: Record<string, string>;
    };

    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.compilerOptions?.paths).toBeUndefined();
    expect(packageJson.engines?.node).toContain(">=24");
    expect(packageJson.devDependencies).toMatchObject({
      typescript: expect.any(String),
      vitest: expect.any(String)
    });

    for (const filePath of listSourceFiles(join(prototypeRoot, "src"))) {
      const source = readFileSync(filePath, "utf8");
      expect(source, relative(prototypeRoot, filePath)).not.toMatch(/from\s+["']@do-what\/|import\(["']@do-what\//);
    }
  });
});

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}
