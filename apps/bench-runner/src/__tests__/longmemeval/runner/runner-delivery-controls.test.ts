import { afterEach, describe, expect, it, vi } from "vitest";
import { recallOptionsForPolicyShape } from "../../../longmemeval/runner/runner-helpers.js";
import {
  dedupeQaDeliveredCandidates,
  resolveQaDeliveryBudget,
  shouldDedupQaDelivery,
  WIDE_QA_DELIVERY_QUESTION_TYPES
} from "../../../longmemeval/runner/question/runner-question.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recallOptionsForPolicyShape", () => {
  it("defaults to a top-10 recall pool when no diagnostic widening is requested", () => {
    expect(recallOptionsForPolicyShape("chat")).toMatchObject({
      maxResults: 10,
      conflictAwareness: false
    });
  });

  it("widens pool-dump runs to at least 100 candidates", () => {
    vi.stubEnv("ALAYA_BENCH_POOL_DUMP", "/tmp/pool.jsonl");
    expect(recallOptionsForPolicyShape("chat").maxResults).toBe(100);

    vi.stubEnv("ALAYA_BENCH_RECALL_MAXK", "140");
    expect(recallOptionsForPolicyShape("chat").maxResults).toBe(140);

    vi.stubEnv("ALAYA_BENCH_RECALL_MAXK", "40");
    expect(recallOptionsForPolicyShape("chat").maxResults).toBe(100);
  });
});

describe("resolveQaDeliveryBudget", () => {
  it("keeps precise question types at the default narrow budget", () => {
    expect(resolveQaDeliveryBudget("temporal-reasoning")).toEqual({
      deliverK: 10,
      useWideDelivery: false
    });
  });

  it("widens aggregation-style question types to 20 when ALAYA_BENCH_QA_WIDE_AGG is enabled", () => {
    vi.stubEnv("ALAYA_BENCH_QA_WIDE_AGG", "1");
    expect(resolveQaDeliveryBudget("multi-session")).toEqual({
      deliverK: 20,
      useWideDelivery: true
    });
    expect(resolveQaDeliveryBudget("knowledge-update")).toEqual({
      deliverK: 20,
      useWideDelivery: true
    });
    expect(resolveQaDeliveryBudget("temporal-reasoning")).toEqual({
      deliverK: 10,
      useWideDelivery: false
    });
  });

  it("lets the global ALAYA_BENCH_QA_DELIVER_K override every type", () => {
    vi.stubEnv("ALAYA_BENCH_QA_DELIVER_K", "17");
    expect(resolveQaDeliveryBudget("temporal-reasoning")).toEqual({
      deliverK: 17,
      useWideDelivery: true
    });
  });

  it("includes locomo-aggregation in the wide-delivery set", () => {
    expect(WIDE_QA_DELIVERY_QUESTION_TYPES.has("locomo-aggregation")).toBe(true);
  });

  it("widens locomo-aggregation only when ALAYA_BENCH_QA_WIDE_AGG is set", () => {
    expect(resolveQaDeliveryBudget("locomo-aggregation")).toEqual({
      deliverK: 10,
      useWideDelivery: false
    });
    vi.stubEnv("ALAYA_BENCH_QA_WIDE_AGG", "1");
    expect(resolveQaDeliveryBudget("locomo-aggregation")).toEqual({
      deliverK: 20,
      useWideDelivery: true
    });
  });
});

describe("QA delivery dedup", () => {
  it("stays enabled by default and can be explicitly disabled", () => {
    expect(shouldDedupQaDelivery()).toBe(true);
    vi.stubEnv("ALAYA_BENCH_QA_DEDUP_DELIVERY", "0");
    expect(shouldDedupQaDelivery()).toBe(false);
    vi.stubEnv("ALAYA_BENCH_QA_DEDUP_DELIVERY", "off");
    expect(shouldDedupQaDelivery()).toBe(false);
  });

  it("drops duplicate delivered turn content while keeping distinct memories", () => {
    expect(
      dedupeQaDeliveredCandidates([
        { objectId: "m1", content: "Alice fixed the violin project." },
        { objectId: "m2", content: " Alice   fixed  the violin project. " },
        { objectId: "m3", content: "Bob started the mural project." }
      ])
    ).toEqual([
      { objectId: "m1", content: "Alice fixed the violin project." },
      { objectId: "m3", content: "Bob started the mural project." }
    ]);
  });

  it("keeps long same-prefix memories distinct and backfills from deeper unique candidates", () => {
    const sharedPrefix = "A".repeat(240);
    expect(
      dedupeQaDeliveredCandidates(
        [
          {
            objectId: "m1",
            eventDate: "2026-01-01",
            content: `${sharedPrefix} first distinct ending`
          },
          {
            objectId: "m2",
            eventDate: "2026-01-01",
            content: ` ${sharedPrefix} first distinct ending `
          },
          {
            objectId: "m3",
            eventDate: "2026-01-01",
            content: `${sharedPrefix} second distinct ending`
          },
          {
            objectId: "m4",
            eventDate: "2026-01-02",
            content: "Tail unique memory that should refill the budget."
          }
        ],
        3
      )
    ).toEqual([
      {
        objectId: "m1",
        eventDate: "2026-01-01",
        content: `${sharedPrefix} first distinct ending`
      },
      {
        objectId: "m3",
        eventDate: "2026-01-01",
        content: `${sharedPrefix} second distinct ending`
      },
      {
        objectId: "m4",
        eventDate: "2026-01-02",
        content: "Tail unique memory that should refill the budget."
      }
    ]);
  });

  it("treats identical text on different dates as distinct delivered evidence", () => {
    expect(
      dedupeQaDeliveredCandidates([
        {
          objectId: "m1",
          eventDate: "2026-01-01",
          content: "Alice visited the museum."
        },
        {
          objectId: "m2",
          eventDate: "2026-02-01",
          content: "Alice visited the museum."
        }
      ])
    ).toEqual([
      {
        objectId: "m1",
        eventDate: "2026-01-01",
        content: "Alice visited the museum."
      },
      {
        objectId: "m2",
        eventDate: "2026-02-01",
        content: "Alice visited the museum."
      }
    ]);
  });
});
