import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { soulToolDefs } from "../../provider/soul-tool-specs.js";
import sidecar from "./semver-tool-surface.sidecar.json" with { type: "json" };

describe("semver-tool-surface", () => {
  it("snapshots the public MCP tool names and description hashes", () => {
    expect(surfaceSource()).toMatchSnapshot();
  });

  // A surface change with no package.json version bump must FAIL. The sidecar
  // pins {version, surfaceHash}; regenerating the snapshot alone no longer
  // smuggles a breaking surface change through CI.
  it("requires a version bump when the public tool surface changes", () => {
    const currentHash = sha256(surfaceSource());
    const currentVersion = readPackageVersion();
    if (currentHash === sidecar.surfaceHash) {
      expect(currentVersion).toBe(sidecar.version);
      return;
    }
    expect(
      currentVersion,
      `The public MCP tool surface changed (hash ${sidecar.surfaceHash} -> ${currentHash}). ` +
        `Bump packages/engine-gateway/package.json "version" and update ` +
        `semver-tool-surface.sidecar.json to { "version": "${currentVersion}", "surfaceHash": "${currentHash}" }.`
    ).not.toBe(sidecar.version);
  });
});

function surfaceSource(): string {
  return soulToolDefs
    .map((tool) => `${tool.name}|desc16=${sha256(tool.description).slice(0, 16)}`)
    .sort()
    .join("\n");
}

function readPackageVersion(): string {
  const pkgUrl = new URL("../../../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { readonly version: string };
  return pkg.version;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
