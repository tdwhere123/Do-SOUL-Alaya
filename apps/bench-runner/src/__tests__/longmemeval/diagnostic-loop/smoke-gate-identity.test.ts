import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSmokeGate, writeSmokeGate } from
  "../../../runs/diagnostic-loop/smoke-gate.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostic-loop smoke gate identity", () => {
  it.each(["passed", "failed"] as const)("round trips %s and distinguishes an absent gate", async status => {
    const workRoot = await mkdtemp(join(tmpdir(), "smoke-gate-"));
    roots.push(workRoot);
    const identityDigest = "a".repeat(64);
    expect(readSmokeGate(workRoot, identityDigest)).toBe("absent");
    writeSmokeGate({ workRoot, status, identityDigest,
      ...(status === "failed" ? { failedPhase: "extraction" as const } : {}) });
    expect(readSmokeGate(workRoot, identityDigest)).toBe(status);
  });

  it.each([
    { schema_version: 2 }, { schema_version: undefined },
    { status: "absent" }, { status: "PASS" }, { status: undefined },
    { failed_phase: "unknown" }, { extra: "unvalidated" }
  ])("rejects malformed gate fields %j rather than reporting passed or absent", async patch => {
    const workRoot = await mkdtemp(join(tmpdir(), "smoke-gate-"));
    roots.push(workRoot);
    const identityDigest = "a".repeat(64);
    await writeFile(join(workRoot, "smoke-gate.json"), JSON.stringify({
      schema_version: 1, kind: "diagnostic_loop_smoke_gate", status: "passed",
      identity_digest: identityDigest, ...patch
    }));
    expect(() => readSmokeGate(workRoot, identityDigest)).toThrow(/invalid smoke gate/u);
  });

  it("rejects a passed gate recorded under a different identity", async () => {
    const workRoot = await mkdtemp(join(tmpdir(), "smoke-gate-"));
    roots.push(workRoot);
    const identityA = "a".repeat(64);
    const identityB = "b".repeat(64);
    writeSmokeGate({ workRoot, status: "passed", identityDigest: identityA });
    expect(readSmokeGate(workRoot, identityA)).toBe("passed");
    expect(() => readSmokeGate(workRoot, identityB)).toThrow(/identity_digest does not match/u);
  });
});
