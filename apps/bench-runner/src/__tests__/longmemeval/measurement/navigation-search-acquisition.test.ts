import { afterAll, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

it("carries native search-cue settlement into additional SQLite acquisition and frozen evaluation without establishing support", { timeout: 90_000 }, async () => {
  const script = fileURLToPath(new URL("../../support/navigation-search-acquisition-proof.mjs", import.meta.url));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [script], { timeout: 80_000, env: process.env });
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({ status: "passed", loopback_calls: 1, additional_acquisitions: 3,
    conditional_support: "unknown", scratch_removed: true });
});
