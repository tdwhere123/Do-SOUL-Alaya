import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDiagnosticLoop } from "../../../runs/diagnostic-loop/run.js";
import { runProductionSnapshotPhase } from
  "../../../runs/diagnostic-loop/production-snapshot.js";
import { resolveSnapshotIdentity } from
  "../../../runs/diagnostic-loop/authority/identity.js";
import { sha256File } from "../../../runs/snapshot/integrity.js";
import { boundFileFullContentReadCount } from "../../../runs/snapshot/bound-file.js";
import {
  injectedNoProviderReceipt,
  loopRequest,
  trackingAdapters,
  writeDiagnosticSnapshotFixture
} from "./fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostic-loop planted --snapshot reuse", () => {
  it("counts a --snapshot hit and keeps the sealed digest across cheap phases", async () => {
    const previous = process.env.ALAYA_RECALL_EVAL_EMBEDDING;
    process.env.ALAYA_RECALL_EVAL_EMBEDDING = "disabled";
    try {
      await assertPlantedSnapshotReuse();
    } finally {
      if (previous === undefined) delete process.env.ALAYA_RECALL_EVAL_EMBEDDING;
      else process.env.ALAYA_RECALL_EVAL_EMBEDDING = previous;
    }
  });
});

async function assertPlantedSnapshotReuse(): Promise<void> {
  const workRoot = await tempRoot();
  const snapshotPath = await writeDiagnosticSnapshotFixture(workRoot, "planted");
  const request = loopRequest({ snapshotPath });
  const tracked = trackingAdapters();
  const before = boundFileFullContentReadCount();
  const result = await runDiagnosticLoop({
    workRoot,
    request,
    mode: "run",
    adapters: {
      ...tracked.adapters,
      snapshot: async (context) => {
        tracked.calls.push("snapshot");
        const phase = await runProductionSnapshotPhase(context);
        return { ...phase, noProviderCallReceipt: injectedNoProviderReceipt() };
      }
    },
    argv: ["--snapshot", snapshotPath]
  });
  const afterFirst = boundFileFullContentReadCount();

  expect(result.avoidedWork.snapshotsReused).toBe(1);
  expect(tracked.calls).toContain("snapshot");
  const identity = await resolveSnapshotIdentity(snapshotPath, request.variant);
  expect(identity.db_sha256).toBe(await sha256File(snapshotPath));
  expect(boundFileFullContentReadCount()).toBe(afterFirst);
  expect(afterFirst).toBeGreaterThan(before);

  const resumed = trackingAdapters();
  const resume = await runDiagnosticLoop({
    workRoot,
    request,
    mode: "run",
    adapters: resumed.adapters,
    argv: ["--snapshot", snapshotPath]
  });
  expect(resumed.calls).toEqual([]);
  expect(resume.avoidedWork.snapshotsReused).toBe(1);
  expect(boundFileFullContentReadCount()).toBe(afterFirst);
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-snapshot-reuse-"));
  roots.push(root);
  return root;
}
