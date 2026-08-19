import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticLoopFailure } from "../../../bench/diagnostic-loop/failures.js";
import { runDiagnosticLoop } from "../../../bench/diagnostic-loop/run.js";
import { checkpointDigest } from "../../../bench/diagnostic-loop/checkpoint.js";
import { runRecordDigest } from "../../../bench/diagnostic-loop/run-state.js";
import { digest, loopRequest, trackingAdapters } from "./fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostic-loop run", () => {
  it("refuses a concurrent invocation for the same work root", async () => {
    const workRoot = await tempRoot();
    const first = trackingAdapters();
    const second = trackingAdapters();
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const firstRun = runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "run",
      adapters: {
        ...first.adapters,
        preflight: async (context) => {
          markEntered();
          await held;
          return await first.adapters.preflight(context);
        }
      },
      argv: []
    });
    await entered;

    try {
      await expect(runDiagnosticLoop({
        workRoot,
        request: loopRequest(),
        mode: "run",
        adapters: second.adapters,
        argv: []
      })).rejects.toThrow(/already in progress/iu);
    } finally {
      releaseFirst();
      await firstRun;
    }
  });

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
      readonly identity: { readonly limit: number; readonly offset: number };
      readonly control: {
        readonly evaluation_slice: {
          readonly limit: number;
          readonly offset: number;
          readonly evaluated_count: number;
        };
      };
      readonly shared_substrate: { readonly cache_identity: string };
    };
    const extraction = JSON.parse(await readFile(
      join(workRoot, "checkpoints", "extraction.json"), "utf8"
    )) as { readonly content_identity: string };
    expect(report.shared_substrate.cache_identity).toBe(extraction.content_identity);
    expect(report.identity).toMatchObject({ limit: 1, offset: 0 });
    expect(report.control.evaluation_slice).toMatchObject({
      limit: 1,
      offset: 0,
      evaluated_count: 1
    });
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

  it("keeps the first run record immutable across resume attempts", async () => {
    const workRoot = await tempRoot();
    await runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "run",
      adapters: trackingAdapters().adapters,
      argv: ["--first"]
    });
    const first = await readFile(join(workRoot, "run.json"), "utf8");

    await runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "report-only",
      adapters: trackingAdapters().adapters,
      argv: ["--resume"]
    });

    expect(await readFile(join(workRoot, "run.json"), "utf8")).toBe(first);
  });

  it("rejects run mode tampering with the original record digest", async () => {
    const workRoot = await completedRun();
    const path = join(workRoot, "run.json");
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...record, mode: "smoke" }, null, 2)}\n`);

    await expect(resume(workRoot)).rejects.toThrow(/run record digest mismatch/iu);
  });

  it("rejects argv tampering even when the run record digest is recomputed", async () => {
    const workRoot = await completedRun();
    const path = join(workRoot, "run.json");
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const { run_record_digest: _digest, ...unsigned } = { ...record, argv: ["--forged"] };
    const changed = {
      ...unsigned,
      run_record_digest: runRecordDigest(unsigned as never)
    };
    await writeFile(path, `${JSON.stringify(changed, null, 2)}\n`);

    await expect(resume(workRoot)).rejects.toThrow(/checkpoint identity mismatch/iu);
  });

  it.each([
    ["control_recall", "completed_at", undefined],
    ["miss_ledger", "physical_calls", "0"],
    ["report", "details", []]
  ] as const)("rejects malformed %s checkpoint field %s after resealing", async (
    phase, field, replacement
  ) => {
    const workRoot = await completedRun();
    const path = join(workRoot, "checkpoints", `${phase}.json`);
    const checkpoint = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (replacement === undefined) delete checkpoint[field];
    else checkpoint[field] = replacement;
    const { checkpoint_digest: _digest, ...body } = checkpoint;
    await writeFile(path, `${JSON.stringify({
      ...body,
      checkpoint_digest: checkpointDigest(body as never)
    }, null, 2)}\n`);

    await expect(resume(workRoot)).rejects.toThrow(/invalid diagnostic-loop checkpoint/iu);
  });

  it("rejects a deleted no-provider-call receipt after checkpoint resealing", async () => {
    const workRoot = await completedRun();
    const path = join(workRoot, "checkpoints", "control_recall.json");
    const checkpoint = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const details = { ...(checkpoint.details as Record<string, unknown>) };
    delete details.no_provider_call_receipt;
    const { checkpoint_digest: _digest, ...body } = { ...checkpoint, details };
    await writeFile(path, `${JSON.stringify({
      ...body,
      checkpoint_digest: checkpointDigest(body as never)
    }, null, 2)}\n`);

    await expect(resume(workRoot)).rejects.toThrow(/invalid diagnostic-loop checkpoint/iu);
  });

  it.each([
    ["control_recall", "kpi"],
    ["miss_ledger", "missLedger"],
    ["report", "report"]
  ] as const)("report-only rejects changed %s artifact %s", async (phase, artifact) => {
    const workRoot = await completedRun();
    const checkpoint = JSON.parse(await readFile(
      join(workRoot, "checkpoints", `${phase}.json`), "utf8"
    )) as { artifact_paths: Record<string, string> };
    const path = checkpoint.artifact_paths[artifact]!;
    await writeFile(path, phase === "report" ? "{}\n" : "tampered", "utf8");

    await expect(runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "report-only",
      adapters: trackingAdapters().adapters,
      argv: []
    })).rejects.toThrow(/artifact authority/iu);
  });

  it.each(["phase", "artifact_paths", "depends_on"] as const)(
    "refuses a checkpoint whose %s was altered",
    async (field) => {
      const workRoot = await tempRoot();
      await runDiagnosticLoop({
        workRoot,
        request: loopRequest(),
        mode: "run",
        adapters: trackingAdapters().adapters,
        argv: []
      });
      const path = join(workRoot, "checkpoints", "snapshot.json");
      const checkpoint = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      checkpoint[field] = field === "phase"
        ? "control_recall"
        : field === "artifact_paths"
          ? { snapshot: "/tampered/snapshot.db" }
          : { preflight: digest("tampered") };
      await writeFile(path, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");

      await expect(runDiagnosticLoop({
        workRoot,
        request: loopRequest(),
        mode: "run",
        adapters: trackingAdapters().adapters,
        argv: []
      })).rejects.toThrow(/checkpoint/iu);
    }
  );

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

async function completedRun(): Promise<string> {
  const workRoot = await tempRoot();
  await resume(workRoot);
  return workRoot;
}

async function resume(workRoot: string) {
  return await runDiagnosticLoop({
    workRoot,
    request: loopRequest(),
    mode: "run",
    adapters: trackingAdapters().adapters,
    argv: []
  });
}

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
