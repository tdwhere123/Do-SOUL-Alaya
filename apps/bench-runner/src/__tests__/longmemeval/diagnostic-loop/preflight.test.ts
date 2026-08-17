import { describe, expect, it } from "vitest";
import { DiagnosticLoopFailure } from "../../../bench/diagnostic-loop/failures.js";
import { runPreflightPhase } from "../../../bench/diagnostic-loop/production-phases.js";
import { loopRequest } from "./fixture.js";

describe("diagnostic-loop production preflight", () => {
  it("rejects credentialled or live-extraction environments", () => {
    expect(() => runPreflightPhase({
      workRoot: "/tmp/loop",
      request: loopRequest(),
      mode: "run",
      checkpoints: new Map()
    }, { ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "1" })).toThrow(/cache-only/u);
  });

  it("requires host_worker when the request asks for worker mode", () => {
    expect(() => runPreflightPhase({
      workRoot: "/tmp/loop",
      request: loopRequest({ worker: true }),
      mode: "smoke",
      checkpoints: new Map()
    }, { ALAYA_GARDEN_PROVIDER_KIND: "official_api" })).toThrow(DiagnosticLoopFailure);
  });

  it("accepts a credentialless worker smoke environment", () => {
    const result = runPreflightPhase({
      workRoot: "/tmp/loop",
      request: loopRequest({ worker: true }),
      mode: "smoke",
      checkpoints: new Map()
    }, { ALAYA_GARDEN_PROVIDER_KIND: "host_worker", ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0" });
    expect(result.physicalCalls).toBe(0);
    expect(result.details?.cache_mode).toBe("cache_only");
  });
});
