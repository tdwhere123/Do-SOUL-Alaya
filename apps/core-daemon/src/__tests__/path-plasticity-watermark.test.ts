import { describe, expect, it } from "vitest";
import { createPathPlasticityWatermarkRegistry } from "../path-plasticity-runtime.js";

/**
 * Pins D2 MERGED-B2 (codex-B2) closure: per-workspace high-water mark
 * for the path-plasticity Auditor task is in-process (v0.1) and
 * advances at enqueue time so each receipt is processed at most once
 * within a single daemon process.
 */
describe("path-plasticity watermark registry", () => {
  it("first enqueue on a workspace returns nowIso - 24h and stores nowIso", () => {
    const registry = createPathPlasticityWatermarkRegistry();
    const sinceIso = registry.getAndAdvance("workspace-1", "2026-05-05T12:00:00.000Z");
    // 2026-05-05T12:00 - 24h = 2026-05-04T12:00
    expect(sinceIso).toBe("2026-05-04T12:00:00.000Z");
  });

  it("second enqueue on same workspace returns the prior watermark, not now-24h", () => {
    const registry = createPathPlasticityWatermarkRegistry();
    registry.getAndAdvance("workspace-1", "2026-05-05T12:00:00.000Z");
    const sinceIso = registry.getAndAdvance("workspace-1", "2026-05-05T12:30:00.000Z");
    // The second tick's lookback start is the FIRST tick's enqueue time —
    // not now-24h. This is what closes B2: the rolling 24h window does
    // NOT include records the prior tick already processed.
    expect(sinceIso).toBe("2026-05-05T12:00:00.000Z");
  });

  it("watermarks are isolated per workspace", () => {
    const registry = createPathPlasticityWatermarkRegistry();
    registry.getAndAdvance("workspace-1", "2026-05-05T12:00:00.000Z");
    const sinceWs2 = registry.getAndAdvance("workspace-2", "2026-05-05T12:30:00.000Z");
    // workspace-2 has never been seen; bootstraps from now-24h.
    expect(sinceWs2).toBe("2026-05-04T12:30:00.000Z");

    const sinceWs1Tick3 = registry.getAndAdvance("workspace-1", "2026-05-05T13:00:00.000Z");
    // workspace-1 still uses its own watermark, unaffected by workspace-2's.
    expect(sinceWs1Tick3).toBe("2026-05-05T12:00:00.000Z");
  });

  it("custom initialLookbackMs replaces the default 24h", () => {
    const registry = createPathPlasticityWatermarkRegistry({
      initialLookbackMs: 60 * 60 * 1000 // 1h
    });
    const sinceIso = registry.getAndAdvance("workspace-1", "2026-05-05T12:00:00.000Z");
    expect(sinceIso).toBe("2026-05-05T11:00:00.000Z");
  });
});
