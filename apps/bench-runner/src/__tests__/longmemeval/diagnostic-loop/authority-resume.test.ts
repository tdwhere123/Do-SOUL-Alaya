// @ts-nocheck
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { computeSourceTurnCacheKey } from
  "../../../runs/compile-seed/compile-seed-cache.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { computeSystemPromptSha256 } from
  "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { diagnosticAuthorityDigest, resolveSnapshotIdentity } from
  "../../../runs/diagnostic-loop/authority/identity.js";
import { runDiagnosticLoop } from "../../../runs/diagnostic-loop/run.js";
import { checkpointDigest } from "../../../runs/diagnostic-loop/checkpoint.js";
import type { DiagnosticLoopCheckpoint } from
  "../../../runs/diagnostic-loop/types.js";
import { writeCompletedExtractionCacheFixture } from
  "../extraction/completed-extraction-cache-fixture.js";
import {
  digest,
  injectedNoProviderReceipt,
  loopRequest,
  trackingAdapters,
  writeDiagnosticSnapshotFixture,
  writeQueryFactorCacheFixture
} from "./fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("diagnostic-loop resolved authority", () => {
  it("resumes snapshot A on A but rejects B before recall", async () => {
    const root = await tempRoot();
    const workRoot = join(root, "work");
    const snapshotA = await writeDiagnosticSnapshotFixture(root, "a");
    const snapshotB = await writeDiagnosticSnapshotFixture(root, "b");
    const first = adaptersForSnapshot(snapshotA);
    await runDiagnosticLoop(runInput(workRoot, snapshotA, first));

    const same = adaptersForSnapshot(snapshotA);
    await runDiagnosticLoop(runInput(workRoot, snapshotA, same));
    expect(same.calls).toEqual([]);

    const changed = adaptersForSnapshot(snapshotB);
    await expect(runDiagnosticLoop(runInput(workRoot, snapshotB, changed)))
      .rejects.toThrow(/different identity/u);
    expect(changed.calls).not.toContain("control_recall");
  });

  it("rejects an in-place snapshot mutation before recall", async () => {
    const root = await tempRoot();
    const workRoot = join(root, "work");
    const snapshot = await writeDiagnosticSnapshotFixture(root, "snapshot");
    await runDiagnosticLoop(runInput(workRoot, snapshot, adaptersForSnapshot(snapshot)));
    await writeFile(snapshot, "tampered", "utf8");

    const resumed = adaptersForSnapshot(snapshot);
    await expect(runDiagnosticLoop(runInput(workRoot, snapshot, resumed)))
      .rejects.toThrow(/snapshot DB SHA-256 mismatch/u);
    expect(resumed.calls).not.toContain("control_recall");
  });

  it("rejects deleted snapshot authority details even with a recomputed digest", async () => {
    const root = await tempRoot();
    const workRoot = join(root, "work");
    const snapshot = await writeDiagnosticSnapshotFixture(root, "snapshot");
    await runDiagnosticLoop(runInput(workRoot, snapshot, adaptersForSnapshot(snapshot)));
    await rewriteCheckpoint(workRoot, "snapshot", (checkpoint) => ({
      ...checkpoint,
      details: {
        no_provider_call_receipt: checkpoint.details.no_provider_call_receipt
      }
    }));

    await expect(runDiagnosticLoop(
      runInput(workRoot, snapshot, adaptersForSnapshot(snapshot))
    )).rejects.toThrow(/snapshot checkpoint authority/iu);
  });

  it("rejects altered snapshot authority details with a recomputed digest", async () => {
    const root = await tempRoot();
    const workRoot = join(root, "work");
    const snapshot = await writeDiagnosticSnapshotFixture(root, "snapshot");
    await runDiagnosticLoop(runInput(workRoot, snapshot, adaptersForSnapshot(snapshot)));
    await rewriteCheckpoint(workRoot, "snapshot", (checkpoint) => ({
      ...checkpoint,
      details: { ...checkpoint.details, question_count: 999 }
    }));

    await expect(runDiagnosticLoop(
      runInput(workRoot, snapshot, adaptersForSnapshot(snapshot))
    )).rejects.toThrow(/snapshot checkpoint authority/iu);
  });

  it.each(["extraction_cache_identity", "extraction_cache_authority"] as const)(
    "rejects deleted extraction %s even with a recomputed digest",
    async (field) => {
      const root = await tempRoot();
      const workRoot = join(root, "work");
      await runDiagnosticLoop({
        workRoot,
        request: loopRequest(),
        mode: "run",
        adapters: trackingAdapters().adapters,
        argv: []
      });
      await rewriteCheckpoint(workRoot, "extraction", (checkpoint) => {
        const details = { ...checkpoint.details };
        delete details[field];
        return { ...checkpoint, details };
      });

      await expect(runDiagnosticLoop({
        workRoot,
        request: loopRequest(),
        mode: "run",
        adapters: trackingAdapters().adapters,
        argv: []
      })).rejects.toThrow(/extraction checkpoint authority/iu);
    }
  );

  it("rejects altered extraction authority details with a recomputed digest", async () => {
    const root = await tempRoot();
    const workRoot = join(root, "work");
    await runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "run",
      adapters: trackingAdapters().adapters,
      argv: []
    });
    await rewriteCheckpoint(workRoot, "extraction", (checkpoint) => ({
      ...checkpoint,
      details: {
        ...checkpoint.details,
        extraction_cache_authority: {
          ...(checkpoint.details.extraction_cache_authority as Record<string, unknown>),
          manifest_sha256: "0".repeat(64)
        }
      }
    }));

    await expect(runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "run",
      adapters: trackingAdapters().adapters,
      argv: []
    })).rejects.toThrow(/extraction checkpoint authority/iu);
  });

  it("rejects a query-factor cache replaced after control", async () => {
    const root = await tempRoot();
    const workRoot = join(root, "work");
    const snapshot = await writeDiagnosticSnapshotFixture(root, "query-replace");
    const cachePath = join(root, "query-cache.json");
    await writeQueryFactorCacheFixture(cachePath, "Question q-1?");
    const first = trackingAdapters();
    await expect(runDiagnosticLoop({
      workRoot,
      request: loopRequest({ snapshotPath: snapshot, treatmentFactorCachePath: cachePath }),
      mode: "run",
      adapters: {
        ...first.adapters,
        treatment_recall: async () => { throw new Error("stop after control"); }
      },
      argv: []
    })).rejects.toThrow(/stop after control/u);
    await rm(cachePath);
    await writeQueryFactorCacheFixture(cachePath, "Question B?");

    const resumed = trackingAdapters();
    await expect(runDiagnosticLoop({
      workRoot,
      request: loopRequest({ snapshotPath: snapshot, treatmentFactorCachePath: cachePath }),
      mode: "run",
      adapters: resumed.adapters,
      argv: []
    })).rejects.toThrow(
      /different identity|source set|missing a required query source|cannot bind/iu
    );
    expect(resumed.calls).not.toContain("treatment_recall");
  });

  it("detects query-factor replacement between control and treatment", async () => {
    const root = await tempRoot();
    const snapshot = await writeDiagnosticSnapshotFixture(root, "query-mid-replace");
    const cachePath = join(root, "query-cache.json");
    await writeQueryFactorCacheFixture(cachePath, "Question q-1?");
    const tracked = trackingAdapters();
    const control = tracked.adapters.control_recall;

    await expect(runDiagnosticLoop({
      workRoot: join(root, "work"),
      request: loopRequest({ snapshotPath: snapshot, treatmentFactorCachePath: cachePath }),
      mode: "run",
      adapters: {
        ...tracked.adapters,
        control_recall: async (context) => {
          const result = await control(context);
          const sealed = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
          await rm(cachePath);
          await writeFile(cachePath, JSON.stringify(sealed));
          return result;
        }
      },
      argv: []
    })).rejects.toThrow(/authority changed between phases/iu);
    expect(tracked.calls).not.toContain("treatment_recall");
  });

  it("detects extraction authority replacement before snapshot", async () => {
    const root = await tempRoot();
    const cacheRoot = join(root, "cache");
    writeCompletedExtractionCacheFixture(cacheFixture(cacheRoot));
    const tracked = trackingAdapters();
    const extraction = tracked.adapters.extraction;

    await expect(runDiagnosticLoop({
      workRoot: join(root, "work"),
      request: completedCacheRequest(cacheRoot),
      mode: "run",
      adapters: {
        ...tracked.adapters,
        extraction: async (context) => {
          const result = await extraction(context);
          const path = join(cacheRoot, "manifest.json");
          const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
          await writeFile(path, `${JSON.stringify({
            ...manifest, builder: "replaced-between-phases"
          }, null, 2)}\n`);
          return result;
        }
      },
      argv: []
    })).rejects.toThrow(/authority changed between phases/iu);
    expect(tracked.calls).not.toContain("snapshot");
  });

  it.each(["root", "manifest", "shard"] as const)(
    "rejects extraction cache %s replacement before resume",
    async (mutation) => {
      const root = await tempRoot();
      const workRoot = join(root, "work");
      const cacheA = join(root, "cache-a");
      const cacheB = join(root, "cache-b");
      const request = completedCacheRequest(cacheA);
      writeCompletedExtractionCacheFixture(cacheFixture(cacheA));
      const first = trackingAdapters();
      await expect(runDiagnosticLoop({
        workRoot,
        request,
        mode: "run",
        adapters: {
          ...first.adapters,
          snapshot: async () => { throw new Error("stop after extraction"); }
        },
        argv: []
      })).rejects.toThrow(/stop after extraction/u);
      let resumedRequest = request;
      if (mutation === "root") {
        writeCompletedExtractionCacheFixture(cacheFixture(cacheB));
        resumedRequest = { ...request, extractionCacheRoot: cacheB };
      } else if (mutation === "manifest") {
        const path = join(cacheA, "manifest.json");
        const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        manifest.builder = "replacement";
        await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      } else {
        const path = cacheFilePath(cacheA, request.requestedKeys[0]!);
        const shard = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        shard.raw_json = '{"signals":[{"tampered":true}]}';
        await writeFile(path, `${JSON.stringify(shard)}\n`, "utf8");
      }

      await expect(runDiagnosticLoop({
        workRoot,
        request: resumedRequest,
        mode: "run",
        adapters: trackingAdapters().adapters,
        argv: []
      })).rejects.toThrow(/identity|shard drifted/iu);
    }
  );

  it("rejects a snapshot bound to a different extraction authority", async () => {
    const root = await tempRoot();
    const cacheRoot = join(root, "cache");
    writeCompletedExtractionCacheFixture(cacheFixture(cacheRoot));
    const tracked = trackingAdapters();

    await expect(runDiagnosticLoop({
      workRoot: join(root, "work"),
      request: completedCacheRequest(cacheRoot),
      mode: "run",
      adapters: tracked.adapters,
      argv: []
    })).rejects.toThrow(/snapshot and extraction cache authority mismatch/iu);
    expect(tracked.calls).not.toContain("control_recall");
  });

  it.each(["artifact_paths", "content_identity"] as const)(
    "rejects re-sealed report miss-ledger %s drift with an unchanged gate",
    async (field) => {
      const root = await tempRoot();
      const workRoot = join(root, "work");
      await runDiagnosticLoop({
        workRoot, request: loopRequest(), mode: "run",
        adapters: trackingAdapters().adapters, argv: []
      });
      await tamperReportMissLedger(workRoot, field);
      await expect(runDiagnosticLoop({
        workRoot, request: loopRequest(), mode: "report-only",
        adapters: trackingAdapters().adapters, argv: []
      })).rejects.toThrow(/unlock\/promotion authority mismatch/iu);
    }
  );
});

async function tamperReportMissLedger(
  workRoot: string,
  field: "artifact_paths" | "content_identity"
): Promise<void> {
  const reportPath = join(workRoot, "report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
  const ledger = { ...(report.miss_ledger as Record<string, unknown>) };
  ledger[field] = field === "artifact_paths"
    ? { missLedger: join(workRoot, "forged.json") }
    : digest("forged-miss-ledger-content");
  const changed = { ...report, miss_ledger: ledger };
  await writeFile(reportPath, `${JSON.stringify(changed, null, 2)}\n`);
  const checkpointPath = join(workRoot, "checkpoints", "report.json");
  const checkpoint = JSON.parse(
    await readFile(checkpointPath, "utf8")
  ) as Record<string, unknown>;
  const { checkpoint_digest: _digest, ...body } = {
    ...checkpoint, content_identity: diagnosticAuthorityDigest(changed)
  };
  await writeFile(checkpointPath, `${JSON.stringify({
    ...body, checkpoint_digest: checkpointDigest(body as never)
  }, null, 2)}\n`);
}

function adaptersForSnapshot(snapshotPath: string) {
  const tracked = trackingAdapters();
  return {
    calls: tracked.calls,
    adapters: {
      ...tracked.adapters,
      snapshot: async (context: Parameters<typeof tracked.adapters.snapshot>[0]) => {
        tracked.calls.push("snapshot");
        const identity = await resolveSnapshotIdentity(snapshotPath, context.request.variant);
        return {
          contentIdentity: identity.identity_digest,
          physicalCalls: 0,
          artifactPaths: { snapshot: snapshotPath },
          details: { ...identity },
          noProviderCallReceipt: injectedNoProviderReceipt()
        };
      }
    }
  };
}

function runInput(
  workRoot: string,
  snapshotPath: string,
  tracked: ReturnType<typeof adaptersForSnapshot>
) {
  return {
    workRoot,
    request: loopRequest({ snapshotPath }),
    mode: "run" as const,
    adapters: tracked.adapters,
    argv: []
  };
}

function completedCacheRequest(cacheRoot: string) {
  const model = "test-extraction-model";
  const requestProfile = "provider-default-v1" as const;
  const key = computeSourceTurnCacheKey(
    model, requestProfile, OFFICIAL_API_SYSTEM_PROMPT, { turnContent: "turn" }
  );
  return loopRequest({
    extractionCacheRoot: cacheRoot,
    requestedKeys: [key],
    model,
    requestProfile,
    datasetRevision: digest("dataset"),
    promptDigest: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT)
  });
}

function cacheFixture(cacheRoot: string) {
  return {
    cacheRoot,
    turnContents: ["turn"],
    datasetRevision: digest("dataset"),
    windowOffset: 0,
    windowLimit: 1,
    model: "test-extraction-model"
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-authority-"));
  roots.push(root);
  return root;
}

async function rewriteCheckpoint(
  workRoot: string,
  phase: "extraction" | "snapshot",
  mutate: (checkpoint: DiagnosticLoopCheckpoint) => DiagnosticLoopCheckpoint
): Promise<void> {
  const path = join(workRoot, "checkpoints", `${phase}.json`);
  const parsed = JSON.parse(await readFile(path, "utf8")) as DiagnosticLoopCheckpoint;
  const changed = mutate(parsed);
  const { checkpoint_digest: _digest, ...body } = changed;
  const sealed = { ...body, checkpoint_digest: checkpointDigest(body) };
  await writeFile(path, `${JSON.stringify(sealed, null, 2)}\n`, "utf8");
}
