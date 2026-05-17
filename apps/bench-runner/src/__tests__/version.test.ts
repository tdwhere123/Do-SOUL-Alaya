import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBenchRunnerVersion } from "../version.js";

// invariant: the helper must return the actual bench-runner package
// version, not a stale literal. The test reads the same package.json
// the helper reads (via the source's resolution path) and asserts the
// strings match. A future release bump that forgets to update either
// side breaks this test.
// see also: apps/bench-runner/src/version.ts
describe("resolveBenchRunnerVersion", () => {
  it("returns the version from apps/bench-runner/package.json", () => {
    const pkgPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../package.json"
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(resolveBenchRunnerVersion()).toBe(pkg.version);
  });

  it("returns a semver-shaped string", () => {
    const version = resolveBenchRunnerVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
