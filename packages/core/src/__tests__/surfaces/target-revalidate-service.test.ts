import { describe, expect, it, vi } from "vitest";
import type { StrongRef } from "@do-soul/alaya-protocol";
import { TargetRevalidateService } from "../../surfaces/target-revalidate-service.js";
import type { TestMock } from "../shared/mock-types.js";

describe("TargetRevalidateService", () => {
  it("returns fresh when target currency has not changed", async () => {
    const harness = createHarness({
      checkCurrency: vi.fn(async () => ({ status: "fresh" as const }))
    });

    const [result] = await harness.service.revalidate([createStrongRefFixture()]);

    expect(result).toEqual({
      ref_id: "strong-ref-1",
      status: "fresh",
      revalidated_at: "2026-04-15T01:00:00.000Z"
    });
  });

  it("returns stale with stale_since when target changed after ref creation", async () => {
    const harness = createHarness({
      checkCurrency: vi.fn(async () => ({
        status: "stale" as const,
        stale_since: "2026-04-15T00:30:00.000Z"
      }))
    });

    const [result] = await harness.service.revalidate([createStrongRefFixture()]);

    expect(result).toEqual({
      ref_id: "strong-ref-1",
      status: "stale",
      stale_since: "2026-04-15T00:30:00.000Z",
      revalidated_at: "2026-04-15T01:00:00.000Z"
    });
  });

  it("returns missing when target entity no longer exists", async () => {
    const harness = createHarness({
      checkCurrency: vi.fn(async () => ({ status: "missing" as const }))
    });

    const result = await harness.service.revalidateSingle(createStrongRefFixture());

    expect(result).toEqual({
      ref_id: "strong-ref-1",
      status: "missing",
      revalidated_at: "2026-04-15T01:00:00.000Z"
    });
  });

  it("findAndRevalidate resolves refs from repo before checking currency", async () => {
    const refs = [
      createStrongRefFixture(),
      createStrongRefFixture({
        ref_id: "strong-ref-2",
        target_entity_id: "slot-1",
        target_entity_type: "slot"
      })
    ];
    const harness = createHarness({
      refs,
      checkCurrency: vi.fn(async ({ targetEntityId }: { targetEntityId: string }) =>
        targetEntityId === "claim-1"
          ? { status: "fresh" as const }
          : { status: "stale" as const, stale_since: "2026-04-15T00:45:00.000Z" }
      )
    });

    const results = await harness.service.findAndRevalidate("workspace-1", "governance_ref", ["claim-1", "slot-1"]);

    expect(harness.findByTargets).toHaveBeenCalledWith("workspace-1", "governance_ref", ["claim-1", "slot-1"]);
    expect(results).toEqual([
      {
        ref_id: "strong-ref-1",
        status: "fresh",
        revalidated_at: "2026-04-15T01:00:00.000Z"
      },
      {
        ref_id: "strong-ref-2",
        status: "stale",
        stale_since: "2026-04-15T00:45:00.000Z",
        revalidated_at: "2026-04-15T01:00:00.000Z"
      }
    ]);
  });

  it("findAndRevalidate preserves all persisted baselines for a target instead of hiding older drift", async () => {
    const refs = [
      createStrongRefFixture({
        ref_id: "strong-ref-old",
        source_entity_type: "run",
        source_entity_id: "run-1",
        target_entity_type: "claim_form",
        target_entity_id: "claim-1",
        created_at: "2026-04-14T23:00:00.000Z"
      }),
      createStrongRefFixture({
        ref_id: "strong-ref-new",
        source_entity_type: "tool_execution",
        source_entity_id: "exec-001",
        target_entity_type: "claim_form",
        target_entity_id: "claim-1",
        created_at: "2026-04-15T00:00:00.000Z"
      })
    ];
    const checkCurrency = vi.fn(
      async ({ sinceTimestamp }: { readonly sinceTimestamp: string }) =>
        sinceTimestamp === "2026-04-15T00:00:00.000Z"
          ? ({ status: "fresh" as const })
          : ({
              status: "stale" as const,
              stale_since: "2026-04-14T23:30:00.000Z"
            })
    );
    const harness = createHarness({
      refs,
      checkCurrency
    });

    const results = await harness.service.findAndRevalidate("workspace-1", "governance_ref", ["claim-1"]);

    expect(results).toEqual([
      {
        ref_id: "strong-ref-old",
        status: "stale",
        stale_since: "2026-04-14T23:30:00.000Z",
        revalidated_at: "2026-04-15T01:00:00.000Z"
      },
      {
        ref_id: "strong-ref-new",
        status: "fresh",
        revalidated_at: "2026-04-15T01:00:00.000Z"
      }
    ]);
    expect(checkCurrency).toHaveBeenCalledTimes(2);
  });
});

function createHarness(options: {
  readonly refs?: readonly StrongRef[];
  readonly checkCurrency?: TestMock;
} = {}) {
  const refs = options.refs ?? [createStrongRefFixture()];
  const findByTargets = vi.fn(async () => refs);
  const checkCurrency =
    options.checkCurrency ??
    vi.fn(async () => ({
      status: "fresh" as const
    }));

  return {
    findByTargets,
    checkCurrency,
    service: new TargetRevalidateService({
      strongRefRepo: {
        findByTargets
      },
      currencyCheckPort: {
        checkCurrency: async (targetEntityType: string, targetEntityId: string, sinceTimestamp: string) =>
          await checkCurrency({ targetEntityType, targetEntityId, sinceTimestamp })
      },
      now: () => "2026-04-15T01:00:00.000Z"
    })
  };
}

function createStrongRefFixture(overrides: Partial<StrongRef> = {}): StrongRef {
  return {
    ref_id: "strong-ref-1",
    source_entity_type: "governance_lease",
    source_entity_id: "lease-1",
    target_entity_type: "claim_form",
    target_entity_id: "claim-1",
    workspace_id: "workspace-1",
    reason: "governance_lease",
    created_at: "2026-04-15T00:00:00.000Z",
    ...overrides
  };
}
