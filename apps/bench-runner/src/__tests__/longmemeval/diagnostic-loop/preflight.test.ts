import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticLoopFailure } from "../../../bench/diagnostic-loop/failures.js";
import {
  createProductionDiagnosticLoopAdapters,
  runPreflightPhase
} from "../../../bench/diagnostic-loop/production-phases.js";
import { loopRequest, writeDiagnosticSnapshotFixture } from "./fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostic-loop production preflight", () => {
  it("rejects credentialled or live-extraction environments", async () => {
    await expect(runPreflightPhase({
      workRoot: "/tmp/loop",
      request: loopRequest(),
      mode: "run",
      checkpoints: new Map()
    }, { ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "1" })).rejects.toThrow(/cache-only/u);
  });

  it("requires host_worker when the request asks for worker mode", async () => {
    await expect(runPreflightPhase({
      workRoot: "/tmp/loop",
      request: loopRequest({ worker: true }),
      mode: "smoke",
      checkpoints: new Map()
    }, { ALAYA_GARDEN_PROVIDER_KIND: "official_api" })).rejects.toThrow(DiagnosticLoopFailure);
  });

  it("accepts a credentialless worker smoke environment", async () => {
    const result = await runPreflightPhase({
      workRoot: "/tmp/loop",
      request: loopRequest({ worker: true }),
      mode: "smoke",
      checkpoints: new Map()
    }, { ALAYA_GARDEN_PROVIDER_KIND: "host_worker", ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0" });
    expect(result.physicalCalls).toBe(0);
    expect(result.details?.cache_mode).toBe("cache_only");
  });

  it("fail-closes a bound query cache that is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-preflight-"));
    roots.push(root);
    const snapshotPath = await writeDiagnosticSnapshotFixture(root, "missing-query-cache");
    await expect(runPreflightPhase({
      workRoot: root,
      request: loopRequest({
        snapshotPath,
        treatmentFactorCachePath: join(root, "missing-query-factor-cache.json")
      }),
      mode: "run",
      checkpoints: new Map()
    }, { ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0" })).rejects.toThrow(/missing or unreadable/u);
  });

  it("issues a no-provider-port receipt only through the credentialless gate", async () => {
    const adapters = createProductionDiagnosticLoopAdapters({
      ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0"
    });
    const result = await adapters.preflight({
      workRoot: "/tmp/loop",
      request: loopRequest(),
      mode: "run",
      checkpoints: new Map()
    });
    expect(result.noProviderCallReceipt).toEqual({
      schema_version: 1,
      kind: "credentialless_environment",
      provider_port: "absent",
      physical_calls: 0
    });
  });
});
