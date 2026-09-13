import { mkdtemp, rm } from "node:fs/promises";
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
