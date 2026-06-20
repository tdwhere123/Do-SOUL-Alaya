import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveBenchCommitInfo,
  resolveBenchCommitSha7,
  resolveBenchRunnerVersion
} from "../../shared/version.js";

// invariant: the helper must return the actual bench-runner package
// version, not a stale literal. The test reads the same package.json
// the helper reads (via the source's resolution path) and asserts the
// strings match. A future release bump that forgets to update either
// side breaks this test.
// see also: apps/bench-runner/src/shared/version.ts
describe("resolveBenchRunnerVersion", () => {
  it("returns the version from apps/bench-runner/package.json", () => {
    const pkgPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../package.json"
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(resolveBenchRunnerVersion()).toBe(pkg.version);
  });

  it("returns a semver-shaped string", () => {
    const version = resolveBenchRunnerVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("resolveBenchCommitSha7", () => {
  it("prefers an explicit BENCH_COMMIT_SHA7 override", () => {
    expect(resolveBenchCommitSha7({ BENCH_COMMIT_SHA7: "abcdef123456" }))
      .toBe("abcdef1");
  });

  it("ignores malformed BENCH_COMMIT_SHA7 values", () => {
    expect(resolveBenchCommitSha7({ BENCH_COMMIT_SHA7: "not-a-sha" }))
      .toMatch(/^[0-9a-f]{7}$/iu);
  });

  it("surfaces fallback commit resolution metadata when git lookup fails", () => {
    const info = resolveBenchCommitInfo(
      { BENCH_COMMIT_SHA7: "not-a-sha" },
      () => {
        throw new Error("git unavailable");
      }
    );

    expect(info).toEqual({
      sha7: "0000000",
      source: "fallback",
      unavailable: true
    });
  });
});
