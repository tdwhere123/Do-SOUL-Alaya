import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticLoopFailure } from "../../../longmemeval/diagnostic-loop/failures.js";
import { runDiagnosticLoop } from "../../../longmemeval/diagnostic-loop/run.js";
import { digest, loopRequest, trackingAdapters } from "./fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostic-loop run", () => {
  it("runs every phase once and writes a comparison report", async () => {
    const workRoot = await tempRoot();
    const tracked = trackingAdapters();
    const result = await runDiagnosticLoop({
      workRoot,
      request: loopRequest({ limit: 1 }),
      mode: "run",
      adapters: tracked.adapters,
      argv: ["--limit", "1"]
    });

    expect(tracked.calls).toEqual([
      "preflight", "authority_cache", "extraction", "snapshot",
      "control_recall", "treatment_recall", "miss_ledger"
    ]);
    expect(result.completedPhases).toContain("report");
    expect(result.skippedPhases).toEqual([]);
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as {
      readonly shared_substrate: { readonly cache_identity: string };
    };
    expect(report.shared_substrate.cache_identity).toBe(digest(`extraction:${digest("dataset")}`));
  });

  it("resumes without repeating a completed phase", async () => {
    const workRoot = await tempRoot();
    const first = trackingAdapters();
    await runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "run",
      adapters: first.adapters,
      argv: []
    });
    const second = trackingAdapters();
    const result = await runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "run",
      adapters: second.adapters,
      argv: []
    });

    expect(second.calls).toEqual([]);
    expect(result.skippedPhases).toContain("extraction");
    expect(result.skippedPhases).toContain("control_recall");
    expect(result.avoidedWork.phasesSkipped).toBeGreaterThan(0);
    expect(result.avoidedWork.snapshotsReused).toBe(1);
    expect(result.avoidedWork.providerCallsAvoided).toBe(1);
  });

  it("re-runs from the named phase and later only", async () => {
    const workRoot = await tempRoot();
    await runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "run",
      adapters: trackingAdapters().adapters,
      argv: []
    });
    const tracked = trackingAdapters();
    const result = await runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "run",
      fromPhase: "control_recall",
      adapters: tracked.adapters,
      argv: ["--from-phase", "control_recall"]
    });

    expect(tracked.calls).toEqual(["control_recall", "treatment_recall", "miss_ledger"]);
    expect(result.skippedPhases).toEqual([
      "preflight", "authority_cache", "extraction", "snapshot"
    ]);
  });

  it("report-only never invokes extraction or recall adapters", async () => {
    const workRoot = await tempRoot();
    await runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "run",
      adapters: trackingAdapters().adapters,
      argv: []
    });
    const tracked = trackingAdapters();
    await runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "report-only",
      fromPhase: "report",
      adapters: tracked.adapters,
      argv: []
    });

    expect(tracked.calls).toEqual([]);
  });

  it("rejects a work root bound to a different identity", async () => {
    const workRoot = await tempRoot();
    await runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "run",
      adapters: trackingAdapters().adapters,
      argv: []
    });

    await expect(runDiagnosticLoop({
      workRoot,
      request: loopRequest({ datasetRevision: digest("other-dataset") }),
      mode: "run",
      adapters: trackingAdapters().adapters,
      argv: []
    })).rejects.toThrow(/different identity/u);
  });
});

describe("diagnostic-loop smoke gate", () => {
  it("records a failed smoke and blocks later expensive phases", async () => {
    const workRoot = await tempRoot();
    const failing = trackingAdapters();
    const adapters = {
      ...failing.adapters,
      extraction: async () => {
        throw new DiagnosticLoopFailure({
          phase: "extraction",
          classification: "authority",
          message: "missing cache keys",
          resumeCommand: ""
        });
      }
    };

    await expect(runDiagnosticLoop({
      workRoot,
      request: loopRequest({ limit: 1, worker: true }),
      mode: "smoke",
      adapters,
      argv: []
    })).rejects.toBeInstanceOf(DiagnosticLoopFailure);

    const blocked = trackingAdapters();
    await expect(runDiagnosticLoop({
      workRoot,
      request: loopRequest({ limit: 1, worker: true }),
      mode: "run",
      adapters: blocked.adapters,
      argv: []
    })).rejects.toThrow(/failed smoke gate/u);
    expect(blocked.calls).not.toContain("extraction");
    expect(blocked.calls).not.toContain("snapshot");
    expect(blocked.calls).not.toContain("control_recall");
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-loop-"));
  roots.push(root);
  return root;
}
