import { NarrativeBudgetConfigSchema, ObligationTrustNarrativeEventType } from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { NarrativeBudgetService } from "../narrative-budget-service.js";

const FIXED_NOW = "2026-04-15T11:00:00.000Z";

describe("NarrativeBudgetService", () => {
  it("returns within-limits status without publishing when count and bytes are below limits", async () => {
    const publish = vi.fn(async (entry) => ({
      ...entry,
      event_id: "unused",
      created_at: FIXED_NOW
    }));
    const service = new NarrativeBudgetService({
      repo: {
        countDigestsByRun: vi.fn(async () => 2),
        totalDigestBytesByRun: vi.fn(async () => 512)
      },
      eventPublisher: { publish },
      now: () => FIXED_NOW
    });
    const config = NarrativeBudgetConfigSchema.parse({
      max_total_digest_bytes: 1024,
      max_digests_per_run: 4,
      consolidation_threshold_pct: 80
    });

    const result = await service.checkBudget("workspace-1", "run-1", config);

    expect(result).toEqual({
      withinLimits: true,
      currentBytes: 512,
      currentCount: 2
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("emits narrative.budget_exceeded when digest bytes cross the consolidation threshold", async () => {
    const publish = vi.fn(async (entry) => ({
      ...entry,
      event_id: "event-budget-bytes",
      created_at: FIXED_NOW
    }));
    const service = new NarrativeBudgetService({
      repo: {
        countDigestsByRun: vi.fn(async () => 2),
        totalDigestBytesByRun: vi.fn(async () => 800)
      },
      eventPublisher: { publish },
      now: () => FIXED_NOW
    });
    const config = NarrativeBudgetConfigSchema.parse({
      max_total_digest_bytes: 1000,
      max_digests_per_run: 4,
      consolidation_threshold_pct: 75
    });

    const result = await service.checkBudget("workspace-1", "run-1", config);

    expect(result.withinLimits).toBe(false);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ObligationTrustNarrativeEventType.NARRATIVE_BUDGET_EXCEEDED,
        entity_type: "run",
        entity_id: "run-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        payload_json: {
          workspace_id: "workspace-1",
          run_id: "run-1",
          current_bytes: 800,
          max_bytes: 750,
          current_count: 2,
          max_count: 3
        }
      })
    );
  });

  it("emits narrative.budget_exceeded when digest count crosses the consolidation threshold", async () => {
    const publish = vi.fn(async (entry) => ({
      ...entry,
      event_id: "event-budget-count",
      created_at: FIXED_NOW
    }));
    const service = new NarrativeBudgetService({
      repo: {
        countDigestsByRun: vi.fn(async () => 9),
        totalDigestBytesByRun: vi.fn(async () => 500)
      },
      eventPublisher: { publish },
      now: () => FIXED_NOW
    });
    const config = NarrativeBudgetConfigSchema.parse({
      max_total_digest_bytes: 1000,
      max_digests_per_run: 10,
      consolidation_threshold_pct: 75
    });

    const result = await service.checkBudget("workspace-1", "run-1", config);

    expect(result.withinLimits).toBe(false);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ObligationTrustNarrativeEventType.NARRATIVE_BUDGET_EXCEEDED,
        payload_json: expect.objectContaining({
          current_count: 9,
          max_count: 8
        })
      })
    );
  });

  it("treats a 0 percent threshold as the hard limit instead of immediate exhaustion", async () => {
    const publish = vi.fn(async (entry) => ({
      ...entry,
      event_id: "event-budget-hard-limit",
      created_at: FIXED_NOW
    }));
    const service = new NarrativeBudgetService({
      repo: {
        countDigestsByRun: vi.fn(async () => 2),
        totalDigestBytesByRun: vi.fn(async () => 800)
      },
      eventPublisher: { publish },
      now: () => FIXED_NOW
    });
    const config = NarrativeBudgetConfigSchema.parse({
      max_total_digest_bytes: 1000,
      max_digests_per_run: 4,
      consolidation_threshold_pct: 0
    });

    const result = await service.checkBudget("workspace-1", "run-1", config);

    expect(result).toEqual({
      withinLimits: true,
      currentBytes: 800,
      currentCount: 2
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("emits narrative.consolidation_triggered with digest_count_before", async () => {
    const events: Array<Record<string, unknown>> = [];
    const publish = vi.fn(async (entry) => ({
      ...(events.push(entry), entry),
      ...entry,
      event_id: "event-consolidation",
      created_at: FIXED_NOW
    }));
    const service = new NarrativeBudgetService({
      repo: {
        countDigestsByRun: vi.fn(async () => 5),
        totalDigestBytesByRun: vi.fn(async () => 1300)
      },
      eventLogReader: {
        queryByRun: vi.fn(async () => events as never)
      },
      eventPublisher: { publish },
      now: () => FIXED_NOW
    });

    await service.triggerConsolidation("workspace-1", "run-1");

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ObligationTrustNarrativeEventType.NARRATIVE_CONSOLIDATION_TRIGGERED,
        entity_type: "run",
        entity_id: "run-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        payload_json: {
          workspace_id: "workspace-1",
          run_id: "run-1",
          trigger_reason: "budget_exceeded",
          digest_count_before: 5
        }
      })
    );
  });

  it("deduplicates repeated consolidation triggers when durable history already recorded the same digest count", async () => {
    const publishedEvents: Array<Record<string, unknown>> = [];
    const publish = vi.fn(async (entry) => ({
      ...(publishedEvents.push(entry), entry),
      ...entry,
      event_id: "event-consolidation",
      created_at: FIXED_NOW
    }));
    const service = new NarrativeBudgetService({
      repo: {
        countDigestsByRun: vi.fn(async () => 5),
        totalDigestBytesByRun: vi.fn(async () => 1300)
      },
      eventLogReader: {
        queryByRun: vi.fn(async () => publishedEvents as never)
      },
      eventPublisher: { publish },
      now: () => FIXED_NOW
    });

    await service.triggerConsolidation("workspace-1", "run-1");
    await service.triggerConsolidation("workspace-1", "run-1");

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("allows a later consolidation trigger when digest count changes after the prior advisory event", async () => {
    const publishedEvents: Array<Record<string, unknown>> = [];
    let digestCountBefore = 5;
    const publish = vi.fn(async (entry) => ({
      ...(publishedEvents.push(entry), entry),
      ...entry,
      event_id: `event-consolidation-${publishedEvents.length}`,
      created_at: FIXED_NOW
    }));
    const service = new NarrativeBudgetService({
      repo: {
        countDigestsByRun: vi.fn(async () => digestCountBefore),
        totalDigestBytesByRun: vi.fn(async () => 1300)
      },
      eventLogReader: {
        queryByRun: vi.fn(async () => publishedEvents as never)
      },
      eventPublisher: { publish },
      now: () => FIXED_NOW
    });

    await service.triggerConsolidation("workspace-1", "run-1");
    digestCountBefore = 6;
    await service.triggerConsolidation("workspace-1", "run-1");

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event_type: ObligationTrustNarrativeEventType.NARRATIVE_CONSOLIDATION_TRIGGERED,
        payload_json: expect.objectContaining({
          digest_count_before: 6
        })
      })
    );
  });
});
