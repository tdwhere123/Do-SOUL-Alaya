import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readBuildInfo,
  readRuntimeVersion,
  resolveCoreDaemonPackageRoot
} from "../../runtime/daemon/support/build-info.js";
import { resolveCoreDaemonFilesDirectory } from "../../runtime/daemon/support/files-data-dir.js";
import { fileModuleUrl, pathEndsWithPosixSegments } from "../support/test-paths.js";

describe("build info", () => {
  it("falls back to package metadata when no built build-info.json is available", () => {
    expect(
      readRuntimeVersion({
        moduleUrl: fileModuleUrl("src", "runtime", "build-info.ts"),
        readFile: (candidatePath) => {
          if (pathEndsWithPosixSegments(candidatePath, "apps", "core-daemon", "package.json")) {
            return JSON.stringify({ name: "@do-soul/alaya", version: "0.3.11" });
          }
          throw new Error(`ENOENT ${candidatePath}`);
        }
      })
    ).toBe("0.3.11");
  });

  it("reads dist/build-info.json from the built runtime path", () => {
    expect(
      readBuildInfo({
        moduleUrl: fileModuleUrl("dist", "runtime", "build-info.js"),
        readFile: (candidatePath) => {
          if (pathEndsWithPosixSegments(candidatePath, "apps", "core-daemon", "package.json")) {
            return JSON.stringify({ name: "@do-soul/alaya", version: "0.3.12" });
          }
          if (pathEndsWithPosixSegments(candidatePath, "apps", "core-daemon", "dist", "build-info.json")) {
            return JSON.stringify({
              version: "0.3.12",
              git_head: "abcdef1234567890",
              built_at: "2026-06-14T00:00:00.000Z"
            });
          }
          throw new Error(`ENOENT ${candidatePath}`);
        }
      })
    ).toEqual({
      version: "0.3.12",
      git_head: "abcdef1234567890",
      built_at: "2026-06-14T00:00:00.000Z"
    });
  });

  it("rejects non-object JSON payloads at the external parse boundary", () => {
    expect(
      readBuildInfo({
        moduleUrl: fileModuleUrl("dist", "runtime", "build-info.js"),
        readFile: (candidatePath) => {
          if (pathEndsWithPosixSegments(candidatePath, "apps", "core-daemon", "package.json")) {
            return JSON.stringify({ name: "@do-soul/alaya", version: "0.3.12" });
          }
          if (pathEndsWithPosixSegments(candidatePath, "apps", "core-daemon", "dist", "build-info.json")) {
            return "[]";
          }
          throw new Error(`ENOENT ${candidatePath}`);
        }
      })
    ).toEqual({
      version: "0.0.0-dev",
      git_head: "unknown",
      built_at: "unknown"
    });
  });

  it("ignores nameless package.json and throws when no @do-soul/alaya root exists", () => {
    const namelessReadFile = (candidatePath: string) => {
      if (pathEndsWithPosixSegments(candidatePath, "apps", "core-daemon", "package.json")) {
        return JSON.stringify({ version: "0.3.11" });
      }
      if (pathEndsWithPosixSegments(candidatePath, "apps", "core-daemon", "dist", "build-info.json")) {
        return JSON.stringify({
          version: "0.3.11",
          git_head: "abcdef1234567890",
          built_at: "2026-06-14T00:00:00.000Z"
        });
      }
      throw new Error(`ENOENT ${candidatePath}`);
    };

    expect(() =>
      resolveCoreDaemonPackageRoot(fileModuleUrl("dist", "runtime", "build-info.js"), namelessReadFile)
    ).toThrow(/Unable to locate @do-soul\/alaya package\.json/);
    expect(
      readBuildInfo({
        moduleUrl: fileModuleUrl("dist", "runtime", "build-info.js"),
        readFile: namelessReadFile
      })
    ).toEqual({
      version: "0.0.0-dev",
      git_head: "unknown",
      built_at: "unknown"
    });
    expect(
      readRuntimeVersion({
        moduleUrl: fileModuleUrl("src", "runtime", "build-info.ts"),
        readFile: namelessReadFile
      })
    ).toBe("0.0.0-dev");
  });

  it("resolves nested runtime/daemon/support paths from the packaged @do-soul/alaya root and includes dist/build-info.json in package files", () => {
    const readPackaged = (candidatePath: string) => {
      if (pathEndsWithPosixSegments(candidatePath, "apps", "core-daemon", "package.json")) {
        return JSON.stringify({ name: "@do-soul/alaya", version: "0.3.11" });
      }
      if (pathEndsWithPosixSegments(candidatePath, "apps", "core-daemon", "dist", "build-info.json")) {
        return JSON.stringify({
          version: "0.3.11",
          git_head: "1234567890abcdef",
          built_at: "2026-07-01T00:00:00.000Z"
        });
      }
      throw new Error(`ENOENT ${candidatePath}`);
    };

    expect(
      readBuildInfo({
        moduleUrl: fileModuleUrl("dist", "runtime", "daemon", "support", "build-info.js"),
        readFile: readPackaged
      })
    ).toEqual({
      version: "0.3.11",
      git_head: "1234567890abcdef",
      built_at: "2026-07-01T00:00:00.000Z"
    });
    expect(
      readRuntimeVersion({
        moduleUrl: fileModuleUrl("src", "runtime", "daemon", "support", "build-info.ts"),
        readFile: readPackaged
      })
    ).toBe("0.3.11");

    const pkgRoot = resolveCoreDaemonPackageRoot();
    expect(pathEndsWithPosixSegments(pkgRoot, "apps", "core-daemon")).toBe(true);
    expect(pathEndsWithPosixSegments(resolveCoreDaemonFilesDirectory(), "apps", "core-daemon", "data", "files")).toBe(true);

    const tempPkgRoot = mkdtempSync(path.join(tmpdir(), "alaya-build-info-pkg-"));
    try {
      writeFileSync(
        path.join(tempPkgRoot, "package.json"),
        JSON.stringify({ name: "@do-soul/alaya", version: "0.3.11" }),
        "utf8"
      );
      const nestedBuiltModule = path.join(tempPkgRoot, "dist", "runtime", "daemon", "support", "files-data-dir.js");
      mkdirSync(path.dirname(nestedBuiltModule), { recursive: true });
      expect(resolveCoreDaemonFilesDirectory(pathToFileURL(nestedBuiltModule).href)).toBe(
        path.resolve(tempPkgRoot, "data", "files")
      );
    } finally {
      rmSync(tempPkgRoot, { recursive: true, force: true });
    }

    const pkgJson = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as {
      readonly files?: readonly string[];
    };
    expect(pkgJson.files).toContain("dist/build-info.json");
  });
});
