import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alayaPackageVersion } from "../package-info.js";

describe("public API and dependency boundary", () => {
  it("exports the adapter-facing runtime API without exporting storage internals", async () => {
    const publicApi = await import("../index.js");

    expect(publicApi.createAlayaRuntime).toEqual(expect.any(Function));
    expect(publicApi.AuditedMutationExecutionError).toEqual(expect.any(Function));
    expect(publicApi.AuditedMutationNotificationError).toEqual(expect.any(Function));
    expect(Object.prototype.hasOwnProperty.call(publicApi, "SqliteAlayaStorage")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(publicApi, "executeAuditedMutation")).toBe(false);
  });

  it("keeps callback mutation helpers and storage implementation out of the public runtime port", async () => {
    const [runtimeTypes, doctorReport] = await Promise.all([
      readFile("src/runtime/types.ts", "utf8"),
      readFile("src/doctor/report.ts", "utf8")
    ]);

    expect(runtimeTypes).toMatch(/recordAuditedRuntimeDecision/);
    expect(runtimeTypes).not.toMatch(/executeAuditedMutation|AuditedMutationCallback|AuditedMutationNotifier/);
    expect(doctorReport).not.toMatch(/storage\/sqlite|StorageDoctorSnapshot/);
  });

  it("keeps production storage imports behind the runtime implementation", async () => {
    const productionFiles = (await listSourceFiles("src"))
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.includes("/__tests__/"));
    const imports = await Promise.all(
      productionFiles.map(async (file) => ({
        file,
        content: await readFile(file, "utf8")
      }))
    );

    const storageImporters = imports
      .filter((entry) => /from "\.\.\/storage\/sqlite\.js"|from "\.\/storage\/sqlite\.js"/.test(entry.content))
      .map((entry) => entry.file);

    expect(storageImporters).toEqual(["src/runtime/runtime.ts"]);
  });

  it("does not introduce do-what runtime imports in package metadata or source", async () => {
    const files = [
      "package.json",
      "src/index.ts",
      "src/runtime/runtime.ts",
      "src/runtime/audited-mutation.ts",
      "src/storage/sqlite.ts",
      "src/cli/doctor.ts"
    ];

    const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
    expect(contents.join("\n")).not.toMatch(/@do-what\/|do-what-new\/packages/);
  });

  it("keeps the doctor package version aligned with package metadata", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    expect(alayaPackageVersion).toBe(packageJson.version);
  });
});

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return await listSourceFiles(path);
      }
      return [path];
    })
  );
  return nested.flat();
}
