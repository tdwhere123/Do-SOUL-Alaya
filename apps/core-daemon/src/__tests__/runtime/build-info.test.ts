import { describe, expect, it } from "vitest";
import { readBuildInfo, readRuntimeVersion } from "../../runtime/build-info.js";

describe("build info", () => {
  it("falls back to package metadata when no built build-info.json is available", () => {
    expect(
      readRuntimeVersion({
        moduleUrl: "file:///workspace/apps/core-daemon/src/runtime/build-info.ts",
        readFile: (path) => {
          if (path.endsWith("/apps/core-daemon/package.json")) {
            return JSON.stringify({ version: "0.3.11" });
          }
          throw new Error(`ENOENT ${path}`);
        }
      })
    ).toBe("0.3.11");
  });

  it("reads dist/build-info.json from the built runtime path", () => {
    expect(
      readBuildInfo({
        moduleUrl: "file:///workspace/apps/core-daemon/dist/runtime/build-info.js",
        readFile: (path) => {
          if (path.endsWith("/apps/core-daemon/dist/build-info.json")) {
            return JSON.stringify({
              version: "0.3.12",
              git_head: "abcdef1234567890",
              built_at: "2026-06-14T00:00:00.000Z"
            });
          }
          throw new Error(`ENOENT ${path}`);
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
        moduleUrl: "file:///workspace/apps/core-daemon/dist/runtime/build-info.js",
        readFile: (path) => {
          if (path.endsWith("/apps/core-daemon/dist/build-info.json")) {
            return "[]";
          }
          throw new Error(`ENOENT ${path}`);
        }
      })
    ).toEqual({
      version: "0.0.0-dev",
      git_head: "unknown",
      built_at: "unknown"
    });
  });
});
