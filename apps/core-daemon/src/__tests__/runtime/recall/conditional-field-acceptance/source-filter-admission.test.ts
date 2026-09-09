import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeRecallResult, RecallService, runConditionalFieldRecall } from "@do-soul/alaya-core";
import { MemoryDimension, SoulMemorySearchRequestSchema, type SoulMemorySearchRequest } from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { createRecallHandler } from "../../../../mcp-memory/recall/recall-usage-handlers.js";
import { createConditionalFieldObserverReaders } from "../../../../runtime/recall-read-worker/observer-operations.js";
import {
  compileConditionalFieldQuery,
  digestOriginalQuery
} from "../../../../../../../packages/core/src/recall/conditional-field/query/compile-query.js";
import { decodeSourceFilters } from "../../../../../../../packages/core/src/recall/conditional-field/query/ordinary-language.js";
import { defaultBudget, SNAPSHOT_ID } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";
import { openSourceSlice, WS } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";

const NOW = "2026-09-09T00:00:00.000Z";
const SINCE = "2026-09-01T00:00:00.000Z";
const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

describe("literal source filters through SQLite and MCP", () => {
  it.each(["2026-09-06T00:00Z", "2026-09-06T00:00:00Z", "2026-09-06T00:00:00.000Z"])(
    "includes equal instants at both public time boundaries %s", async (boundary) => {
      const fixture = await setup();
      const stamps = ["2026-09-06T00:00Z", "2026-09-06T00:00:00Z", "2026-09-06T00:00:00.000Z"];
      const expected: string[] = [];
      for (const [index, stamp] of stamps.entries()) expected.push(await fixture.write(index + 1, [], stamp));
      const result = await fixture.recall({ since: boundary, until: boundary, time_field: "created_at" });
      expect(result.results.map((entry) => entry.object_id)).toEqual(expected);
    }
  );

  it("distinguishes submillisecond instants and equal right-padded fractions at public boundaries", async () => {
    const fixture = await setup();
    await fixture.write(1, [], "2026-09-06T00:00:00.0000000000000000001Z");
    const boundary = "2026-09-06T00:00:00.0000000000000000002Z";
    const exact = await fixture.write(2, [], boundary);
    const padded = await fixture.write(3, [], "2026-09-06T00:00:00.0000000000000000002000Z");
    await fixture.write(4, [], "2026-09-06T00:00:00.0000000000000000003Z");
    const result = await fixture.recall({ since: boundary, until: boundary, time_field: "created_at" });
    expect(result.results.map((entry) => entry.object_id)).toEqual([exact, padded]);
  });

  it.each(["team|tag=other", 'team"%领域\n|since=1900-01-01T00:00:00.000Z'])(
    "preserves the literal tag %j alongside dimension and time filters", async (tag) => {
      const fixture = await setup();
      const expected = await fixture.write(1, [tag]);
      await fixture.write(2, ["other"]);
      await fixture.write(3, [tag], "2020-01-01T00:00:00.000Z");
      await fixture.write(4, [tag], undefined, MemoryDimension.EPISODE);
      const result = await fixture.recall({ domain_tags: [tag], dimension: MemoryDimension.FACT,
        since: SINCE, time_field: "created_at" });
      expect(result.index?.entries.map((entry) => entry.object_id)).toEqual([expected]);
      expect(result.results.map((entry) => entry.object_id)).toEqual([expected]);
      expect(fixture.lexical).toHaveBeenCalled();
      expect(fixture.source).toHaveBeenCalled();
    }
  );

  it.each([{ domain_tags: ["x".repeat(700)] },
    { domain_tags: Array.from({ length: 20 }, (_, index) => `team-${index}|tag=other`) }])(
    "preserves supported long and multiple tags without dropping since", async ({ domain_tags }) => {
      const fixture = await setup();
      const expected = await fixture.write(1, [domain_tags.at(-1)!]);
      await fixture.write(2, [domain_tags.at(-1)!], "2020-01-01T00:00:00.000Z");
      await fixture.write(3, ["other"]);
      const result = await fixture.recall({ domain_tags, since: SINCE, time_field: "created_at" });
      expect(result.results.map((entry) => entry.object_id)).toEqual([expected]);
    }
  );

  it.each([{ domain_tags: ["x".repeat(1024)] },
    { domain_tags: Array.from({ length: 100 }, (_, index) => `team-${index}|tag=other`) }])(
    "rejects an oversized public filter without truncation or source observation", async ({ domain_tags }) => {
      const fixture = await setup();
      await fixture.write(1, ["x".repeat(1005), "other"]);
      const result = await fixture.recall({ domain_tags, since: SINCE, time_field: "created_at" });
      expect(result.index?.completeness.logical_index).toBe("resource_rejected");
      expect(result.index?.continuation).toBeNull();
      expect(result.results).toEqual([]);
      expect(fixture.lexical).not.toHaveBeenCalled();
      expect(fixture.source).not.toHaveBeenCalled();
    }
  );

  it("rejects a continuation when a literal delimiter tag is replaced by separate tags", async () => {
    const fixture = await setup();
    await fixture.write(1, ["team|tag=other"]);
    await fixture.write(2, ["team|tag=other"]);
    await fixture.write(3, ["other"]);
    const first = await fixture.recall({ domain_tags: ["team|tag=other"], max_results: 1 });
    expect(first.index?.continuation).not.toBeNull();
    const changed = await fixture.recall({ domain_tags: ["team", "other"], max_results: 1,
      continuation: first.index!.continuation! });
    expect(changed.index?.query_id).not.toBe(first.index?.query_id);
    expect(changed.index?.completeness.logical_index).toBe("invalidated");
    expect(changed.results).toEqual([]);
  });
});

describe("frozen source predicates through ordinary recall", () => {
  it("does not pack frozen predicate names into memory source.filters", () => {
    const compiled = compileConditionalFieldQuery({
      source: "typed",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      program: {
        schema_version: 1,
        kind: "relation",
        relation_kind: "observed_log",
        source_variable: "s",
        target_variable: "t",
        facet_mode: "same_path",
        threshold_milligrades: 0,
        guard: {
          schema_version: 1,
          kind: "query_predicate",
          verdict: "unresolved",
          predicate_name: "source.identity.v1",
          variable: "t",
          time_scope: "none"
        }
      }
    });
    expect(compiled.status).toBe("resolved");
    expect(compiled.program.kind === "relation" ? compiled.program.guard.predicate_name : undefined)
      .toBe("source.identity.v1");
    expect(decodeSourceFilters("source.identity.v1")).toBeUndefined();
  });

  it("keeps unknown ordinary text partial and does not call a provider or enqueue Garden", async () => {
    const fixture = await setup();
    const before = fixture.pendingGarden();
    const digest = digestOriginalQuery("xyzzy unrelated request");
    const result = await fixture.recall({
      query: "xyzzy unrelated request",
      interpretation_proposal: {
        schema_version: 1,
        original_query_digest: digest,
        producer_id: "daemon.test.v1",
        conditions: [{
          schema_version: 1,
          kind: "query_predicate",
          verdict: "unresolved",
          predicate_name: "source.not_a_frozen_predicate.v1"
        }]
      }
    });
    expect(result.index?.completeness.logical_index).not.toBe("complete");
    expect(result.index?.completeness.logical_index).not.toBe("unavailable");
    expect(result.results).toEqual([]);
    expect(fixture.pendingGarden()).toBe(before);
    const encoded = await fixture.serviceRecall("xyzzy unrelated request", {
      interpretation_proposal: {
        schema_version: 1,
        original_query_digest: digest,
        producer_id: "daemon.test.v1"
      }
    });
    expect(encoded.provider_calls).toBe(0);
    expect(encoded.garden_enqueue).toBe(0);
  });

  it("does not treat created_at as source.event_time.interval.v1", async () => {
    const fixture = await setup();
    const id = await fixture.write(1, ["team"]);
    const digest = digestOriginalQuery("needle");
    const result = await fixture.recall({
      query: "needle",
      interpretation_proposal: {
        schema_version: 1,
        original_query_digest: digest,
        producer_id: "daemon.test.v1",
        conditions: [{
          schema_version: 1,
          kind: "query_predicate",
          verdict: "unresolved",
          predicate_name: "source.event_time.interval.v1",
          interval: {
            start: SINCE,
            end: NOW,
            time_domain: "event_time"
          }
        }]
      }
    });
    expect(result.results.map((entry) => entry.object_id)).not.toContain(id);
    expect(result.index?.completeness.logical_index).not.toBe("unavailable");
    const encoded = await fixture.serviceRecall("needle", {
      interpretation_proposal: {
        schema_version: 1,
        original_query_digest: digest,
        producer_id: "daemon.test.v1",
        conditions: [{
          schema_version: 1,
          kind: "query_predicate",
          verdict: "unresolved",
          predicate_name: "source.event_time.interval.v1",
          interval: { start: SINCE, end: NOW, time_domain: "event_time" }
        }]
      }
    });
    expect(encoded.provider_calls).toBe(0);
    expect(encoded.garden_enqueue).toBe(0);
  });
});

async function setup() {
  const slice = await openSourceSlice((database) => databases.add(database));
  const native = createConditionalFieldObserverReaders(slice.database);
  const lexical = vi.fn(native.lexical!);
  const source = vi.fn(native.source!);
  const recallService = new RecallService({ now: () => NOW, observerReaders: { ...native, lexical, source } });
  const handler = createRecallHandler({ now: () => NOW, warn: () => undefined,
    generateId: () => "00000000-0000-4000-8000-000000000001",
    deps: { recallService,
      memoryService: { findByIdScoped: async () => null },
      trustStateRecorder: {
        recordDelivery: async (input) => ({ ...input, audit_event_id: "event-1" }),
        recordUsage: async (input) => ({ ...input, audit_event_id: "event-2" }),
        findDeliveryById: async () => null
      } }
  });
  return {
    lexical, source,
    pendingGarden: () => slice.pendingGarden().length,
    async write(number: number, tags: readonly string[], createdAt = "2026-09-06T00:00:00.000Z",
      dimension: MemoryDimension = MemoryDimension.FACT) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, "0")}`;
      await slice.writeMemory(id, "needle source record", dimension);
      slice.database.connection.prepare("UPDATE memory_entries SET domain_tags = ?, created_at = ? WHERE object_id = ?")
        .run(JSON.stringify(tags), createdAt, id);
      return id;
    },
    recall(input: Partial<SoulMemorySearchRequest>) {
      const request = SoulMemorySearchRequestSchema.parse({ query: "needle", scope_class: null,
        dimension: null, domain_tags: null, max_results: 30, source_observed_at: NOW, ...input });
      return handler(request, { workspaceId: WS, runId: null, agentTarget: "codex", sessionId: "literal-filters" });
    },
    async serviceRecall(query: string, extra: Partial<SoulMemorySearchRequest> = {}) {
      return encodeRecallResult(runConditionalFieldRecall({
        workspace_id: WS,
        query_text: query,
        snapshot_id: SNAPSHOT_ID,
        budget: defaultBudget({ page_budget: 30 }),
        interpretation_clock: extra.source_observed_at ?? NOW,
        as_of: extra.source_observed_at ?? NOW,
        expires_at: "2099-01-01T00:00:00.000Z",
        readers: { ...native, lexical, source },
        ...(extra.interpretation_proposal === undefined
          ? {}
          : { interpretation_proposal: extra.interpretation_proposal })
      }));
    }
  };
}
