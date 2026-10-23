import { afterAll, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
it("consumes authored external issuance through compiled CLI and native loopback HTTP without credentials", { timeout: 90_000 }, async () => {
  const proof = fileURLToPath(new URL("../../support/frozen-answer-proof.mjs", import.meta.url));
  const result = await promisify(execFile)(process.execPath, [proof], { env: process.env, timeout: 80_000 });
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ status: "passed", natural_calls: 0, credential_reads: 0, index_builds: 0, isolation_violations: [] });
  expect(report.checks).toHaveLength(10);
});
it("keeps captured schema aliases immutable through native asynchronous request encoding", { timeout: 90_000 }, async () => {
  const proof = fileURLToPath(new URL("../../support/frozen-answer-request-capture.mjs", import.meta.url));
  const result = await promisify(execFile)(process.execPath, [proof], { env: process.env, timeout: 80_000 });
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "passed", exact_authorized_bodies: true,
    successful_shards: 2, loopback_requests: 4, natural_calls: 0, credential_reads: 0, isolation_violations: [] });
});
