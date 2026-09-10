import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MemoryDimension,
  type InformationIndex
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import {
  RecallService,
  capableRecallConsumerDeclaration,
  captureIndexPreviews,
  runConditionalFieldRecall,
  type ObserverReaders
} from "../../../../recall/recall-service.js";
import { compileConditionalFieldQuery, interpretationIdentity } from "../../../../recall/conditional-field/query/compile-query.js";
import { observeConditionalField, startObserverCursor, toSourceObserverRow } from
  "../../../../recall/conditional-field/observers/observe.js";
import { createDependencies, createTaskSurface } from "../../recall-service-test-fixtures.js";
import {
  INTERPRETATION_CLOCK,
  LAST_WEEK_INSTANT,
  SNAPSHOT_ID,
  YESTERDAY_INSTANT,
  defaultBudget,
  defaultView,
  yesterdayAnchorGuard
} from "../reference/deployment.fixture.js";
import { INAPPLICABLE_KIND, MEM, WS, openSourceSlice } from "../vertical/source-slice.js";

const databases = new Set<StorageDatabase>();
const COMPLETE_FINALIZATION_RESERVE = 512;

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field executeRecall assembly", () => {
  it("bind last-week config and unknown-cause history", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const compiled = compileConditionalFieldQuery({
      source: "ordinary",
      text: "yesterday failed deployment",
      interpretation_clock: INTERPRETATION_CLOCK,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget()
    });
    expect(compiled.view.claim_demands).toEqual([{
      variable: "h",
      proposition_kind: "common_cause",
      argument_variables: ["r", "h"],
      required_claim: "any"
    }]);
    const index = runRecall(slice, { page_budget: 800 });
    expectMemoryBaselineWithUnknownSources(index);
    expect(index.entries.find((entry) => entry.object_id === MEM.h)).toMatchObject({
      role: "associated", association_milligrades: 1000, claim: "unknown"
    });
    expect(index.entries.find((entry) => entry.object_id === MEM.c)?.association_milligrades)
      .toBe(1000);
    const supported = index.entries.find((entry) => entry.explanation_ids.length > 0);
    expect(supported).toBeDefined();
    expect(supported?.explanation_ids.length).toBeGreaterThan(0);
    expect(index.completeness.logical_index === "complete" || index.completeness.logical_index === "open").toBe(true);
    expect(index.completeness.interpretation_coverage).toBeDefined();
    expect(JSON.stringify(index)).not.toContain("ranking_authority");
    expect(JSON.stringify(index)).not.toContain("select_gamma");
  });

  it("pages without a second selector and keeps continuation identity", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const full = runRecall(slice, { page_budget: 800 });
    expectMemoryBaselineWithUnknownSources(full);
    const pages: InformationIndex[] = [];
    let continuation: InformationIndex["continuation"] = null;
    for (let step = 0; step < 16; step += 1) {
      const page = runRecall(slice, { page_budget: 1, continuation });
      pages.push(page);
      continuation = page.continuation;
      if (continuation === null) break;
    }
    expect(pages[0]?.continuation).not.toBeNull();
    expect(pages[0]?.continuation?.interpretation_id).toBe(
      interpretationIdentity({ interpretation_clock: INTERPRETATION_CLOCK })
    );
    expect(pages[0]?.completeness.transport).toBe("partial");
    expect(pages.flatMap((page) => page.entries).map(entryId)).toEqual(full.entries.map(entryId));
    expect(pages[0]?.query_id).toBe(full.query_id);
    expect(pages[0]?.snapshot_id).toBe(full.snapshot_id);
  });

  it("reports empty exhausted versus cancelled", async () => {
    const empty = await openSourceSlice((database) => databases.add(database));
    const exhausted = runRecall(empty, { page_budget: 800 });
    expect(exhausted.entries).toEqual([]);
    const cancelled = runRecall(empty, { page_budget: 800, cancelled: true });
    expect(cancelled.completeness.observed_coverage).toBe("cancelled");
    expect(cancelled.completeness.logical_index).not.toBe("complete");
  });

  it("does not mint known-empty complete for a lexical zero-hit query", async () => {
    const empty = await openSourceSlice((database) => databases.add(database));
    const lexical = runRecall(empty, { page_budget: 800, query_text: "deployment rules" });
    expect(lexical.entries).toEqual([]);
    expect(lexical.completeness.logical_index).toBe("open");
    expect(lexical.completeness.observed_coverage).toBe("unknown");
    const partial = runRecall(empty, {
      page_budget: 800,
      query_text: "failed deployment of checkout"
    });
    expect(partial.entries).toEqual([]);
    expect(partial.completeness.logical_index).toBe("open");
    expect(partial.completeness.observed_coverage).toBe("unknown");
  });

  it("filters dimension and absent domain tags instead of returning every fact", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const dimension = runRecall(slice, {
      page_budget: 800,
      query_text: "checkout",
      dimension_filter: ["episode"]
    });
    expect(dimension.entries.every((entry) => entry.object_id !== MEM.u)).toBe(true);
    const tagged = runRecall(slice, {
      page_budget: 800,
      query_text: "checkout",
      domain_tag_filter: ["absent-tag"]
    });
    expect(tagged.entries).toEqual([]);
  });

  it("keeps one-sided since partial instead of unavailable", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const index = runRecall(slice, {
      page_budget: 800,
      query_text: "checkout",
      since: YESTERDAY_INSTANT
    });
    expect(index.completeness.logical_index).not.toBe("unavailable");
  });

  it("keeps garden enqueue at zero during ordinary recall", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const before = slice.pendingGarden().length;
    runRecall(slice, { page_budget: 800 });
    expect(slice.pendingGarden()).toHaveLength(before);
    expect(slice.pendingGarden()).toHaveLength(0);
  });

  it("keeps last-week config; applying yesterday to every object drops it from seeds", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const index = runRecall(slice, { page_budget: 800 });
    expect(index.entries.find((entry) => entry.object_id === MEM.c)?.association_milligrades)
      .toBe(1000);
    const seed = observeConditionalField({
      lease: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        lease_id: "a01",
        snapshot_id: SNAPSHOT_ID,
        query_id: "failed-deployment",
        status: "active"
      },
      action: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        action: "seed",
        region_id: "seed",
        work_limit: 16
      },
      cursor: startObserverCursor({
        cursor_id: "seed",
        snapshot_id: SNAPSHOT_ID,
        query_id: "failed-deployment",
        region_id: "seed"
      }),
      query: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        query_id: "failed-deployment",
        status: "resolved",
        snapshot_id: SNAPSHOT_ID,
        program: {
          schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
          kind: "relation",
          relation_kind: "failed_deployment",
          source_variable: "anchor",
          target_variable: "r",
          guard: yesterdayAnchorGuard(),
          facet_mode: "same_path",
          threshold_milligrades: 0
        },
        view: defaultView(),
        holes: [],
        hypotheses: []
      },
      workspace_id: WS,
      readers: readersFor(slice),
      seed_query: "configuration change",
      anchor_object_ids: [MEM.r, MEM.c],
      object_observed_at: { [MEM.r]: YESTERDAY_INSTANT, [MEM.c]: LAST_WEEK_INSTANT },
      page_limit: 16
    });
    expect(seed.page.observations.some((observation) => observation.object_id === MEM.c)).toBe(false);
  });

  it("ordinary language outside failed-deployment still returns a source-backed index", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const rules = runConditionalFieldRecall({
      workspace_id: WS,
      query_text: "deployment rules",
      budget: defaultBudget({ page_budget: 800 }),
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: INTERPRETATION_CLOCK,
      as_of: INTERPRETATION_CLOCK,
      expires_at: "2099-01-01T00:00:00.000Z",
      readers: readersFor(slice)
    });
    expect(rules.completeness.logical_index).not.toBe("unavailable");
    expect(rules.entries.length).toBeGreaterThan(0);
    const commands = runConditionalFieldRecall({
      workspace_id: WS,
      query_text: "pnpm workspace commands",
      budget: defaultBudget({ page_budget: 800 }),
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: INTERPRETATION_CLOCK,
      as_of: INTERPRETATION_CLOCK,
      expires_at: "2099-01-01T00:00:00.000Z",
      readers: readersFor(slice)
    });
    expect(commands.completeness.logical_index).toBe("open");
    expect(commands.completeness.observed_coverage).toBe("unknown");
  });

  it("does not mint complete-empty after an unavailable observer", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const index = runConditionalFieldRecall({
      workspace_id: WS,
      query_text: "yesterday failed deployment",
      budget: defaultBudget({ page_budget: 800 }),
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: INTERPRETATION_CLOCK,
      as_of: INTERPRETATION_CLOCK,
      expires_at: "2099-01-01T00:00:00.000Z",
      readers: {}
    });
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(index.completeness.observed_coverage).not.toBe("exhausted_empty");
    expect(index.completeness.observed_coverage).toBe("unavailable");
  });

  it("keeps snapshot identity across executeRecall pages when now() changes", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    let ticks = 0;
    const { dependencies } = createDependencies();
    const service = new RecallService({
      ...dependencies,
      now: () => new Date(Date.parse(INTERPRETATION_CLOCK) + ticks++ * 1_000).toISOString(),
      observerReaders: readersFor(slice)
    });
    const surface = { ...createTaskSurface(), display_name: "yesterday failed deployment" };
    const pageRequest = {
      taskSurface: surface,
      workspaceId: WS,
      strategy: "chat" as const,
      queryText: "yesterday failed deployment",
      ...capableRecallConsumerDeclaration()
    };
    const full = await service.recall({ ...pageRequest, pageBudget: 800,
      budget: defaultBudget({ page_budget: 800, finalization_reserve: COMPLETE_FINALIZATION_RESERVE })
    } as Parameters<typeof service.recall>[0]);
    expectMemoryBaselineWithUnknownSources(full.index);
    const pages: InformationIndex[] = [];
    let continuation: InformationIndex["continuation"] = null;
    for (let step = 0; step < 16; step += 1) {
      const page = await service.recall({
        ...pageRequest,
        pageBudget: 1,
        continuation
      });
      pages.push(page.index);
      continuation = page.index.continuation;
      if (continuation === null) break;
    }
    expect(pages[0]?.snapshot_id).toBe(pages[1]?.snapshot_id);
    expect(pages[1]?.completeness.observed_coverage).not.toBe("invalidated");
    const stampedClock = pages[0]?.continuation?.interpretation_clock;
    expect(stampedClock).toEqual(expect.any(String));
    expect(pages[1]?.query_id).toBe(pages[0]?.query_id);
    if (pages[1]?.continuation !== null && pages[1]?.continuation !== undefined) {
      expect(pages[1].continuation.interpretation_clock).toBe(stampedClock);
    }
    expect(pages.flatMap((page) => page.entries).map(entryId)).toEqual(full.index.entries.map(entryId));
    const stripped = pages[0]?.continuation;
    expect(stripped).not.toBeNull();
    const { interpretation_clock: _dropped, ...withoutClock } = stripped!;
    const drifted = await service.recall({
      ...pageRequest,
      pageBudget: 1,
      continuation: withoutClock
    });
    expect(drifted.index.completeness.observed_coverage).toBe("invalidated");
  });

  it("worker-port recall preserves query and snapshot identity of the local producer", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const { dependencies } = createDependencies();
    const service = new RecallService({
      ...dependencies,
      observerReaders: readersFor(slice),
      conditionalFieldPort: {
        recall: async () => {
          const readers = readersFor(slice);
          const index = runRecall(slice, { page_budget: 800 });
          return {
            index,
            previews: Object.fromEntries(captureIndexPreviews(index, readers, WS))
          };
        }
      }
    });
    const local = runRecall(slice, { page_budget: 800 });
    const viaPort = await service.recall({
      taskSurface: { ...createTaskSurface(), display_name: "yesterday failed deployment" },
      workspaceId: WS,
      strategy: "chat",
      queryText: "yesterday failed deployment",
      pageBudget: 800,
      interpretationClock: INTERPRETATION_CLOCK,
      snapshotDigest: SNAPSHOT_ID,
      ...capableRecallConsumerDeclaration()
    });
    expect(viaPort.index.query_id).toBe(local.query_id);
    expect(viaPort.index.entries.map(entryId)).toEqual(local.entries.map(entryId));
    expect(viaPort.candidates[0]?.content_preview).not.toBe("[payload omitted]");
    expect(viaPort.candidates.some((candidate) =>
      candidate.content_preview.includes("checkout")
      || candidate.content_preview.includes("deployment")
    )).toBe(true);
  });

  it("does not resume a continuation across a different interpretation clock", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const first = runRecall(slice, { page_budget: 1 });
    expect(first.continuation).not.toBeNull();
    const mismatched = runConditionalFieldRecall({
      workspace_id: WS,
      query_text: "yesterday failed deployment",
      budget: defaultBudget({ page_budget: 1 }),
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: "2099-01-01T00:00:00.000Z",
      as_of: INTERPRETATION_CLOCK,
      expires_at: "2099-01-01T00:00:00.000Z",
      readers: readersFor(slice),
      continuation: first.continuation === null
        ? null
        : {
          ...first.continuation,
          interpretation_id: interpretationIdentity({ interpretation_clock: INTERPRETATION_CLOCK })
        }
    });
    expect(mismatched.completeness.logical_index).toBe("invalidated");
    expect(mismatched.entries).toEqual([]);
  });

  it("unmatched routing edges do not copy program state or rewrite query identity", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const baseline = runRecall(slice, { page_budget: 800 });
    expect(baseline.entries.find((entry) => entry.object_id === MEM.h)).toMatchObject({
      role: "associated", association_milligrades: 1000, claim: "unknown"
    });
    await plantIrrelevantRouting(slice);
    const mutated = runRecall(slice, { page_budget: 800 });
    expect(mutated.query_id).toBe(baseline.query_id);
    expect(mutated.entries.map(entryId)).toEqual(baseline.entries.map(entryId));
    expect(mutated.entries.map((entry) => entry.object_id)).not.toContain(MEM.u);
    expect(mutated.entries.find((entry) => entry.object_id === MEM.h)).toMatchObject({
      role: "associated", association_milligrades: 1000, claim: "unknown"
    });
  });

  it("tiny work_units leaves unmatched routing residual unknown", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    await plantIrrelevantRouting(slice);
    const tiny = runConditionalFieldRecall({
      workspace_id: WS,
      query_text: "yesterday failed deployment",
      budget: defaultBudget({ work_units: 24, finalization_reserve: 8, min_envelope: 2, page_budget: 800 }),
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: INTERPRETATION_CLOCK,
      as_of: INTERPRETATION_CLOCK,
      expires_at: "2099-01-01T00:00:00.000Z",
      readers: readersFor(slice)
    });
    expect(["open", "interrupted", "unknown"]).toContain(tiny.completeness.observed_coverage);
    expect(tiny.completeness.logical_index).not.toBe("complete");
  });
});

function runRecall(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  input: Readonly<{
    readonly page_budget: number;
    readonly continuation?: InformationIndex["continuation"];
    readonly cancelled?: boolean;
    readonly query_text?: string;
    readonly since?: string;
    readonly dimension_filter?: readonly string[];
    readonly domain_tag_filter?: readonly string[];
    readonly time_field?: "created_at" | "last_used_at";
  }>
): InformationIndex {
  return runConditionalFieldRecall({
    workspace_id: WS,
    query_text: input.query_text ?? "yesterday failed deployment",
    budget: defaultBudget({ page_budget: input.page_budget, finalization_reserve: COMPLETE_FINALIZATION_RESERVE }),
    snapshot_id: SNAPSHOT_ID,
    interpretation_clock: INTERPRETATION_CLOCK,
    as_of: INTERPRETATION_CLOCK,
    expires_at: "2099-01-01T00:00:00.000Z",
    readers: readersFor(slice),
    continuation: input.continuation ?? null,
    cancelled: input.cancelled === true,
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.dimension_filter === undefined ? {} : { dimension_filter: input.dimension_filter }),
    ...(input.domain_tag_filter === undefined ? {} : { domain_tag_filter: input.domain_tag_filter }),
    ...(input.time_field === undefined ? {} : { time_field: input.time_field })
  });
}

function expectMemoryBaselineWithUnknownSources(index: InformationIndex): void {
  expect(index.completeness, JSON.stringify(index.completeness)).toMatchObject({
    logical_index: "open", observed_coverage: "unknown", transport: "open", representation: "complete"
  });
  expect(index.completeness.certificate_id).toBeUndefined();
  expect(index.continuation).toBeNull();
}

function readersFor(slice: Awaited<ReturnType<typeof openSourceSlice>>): ObserverReaders {
  const kindsSql = slice.database.connection.prepare(
    `SELECT DISTINCT relation_kind AS kind FROM relation_assertions
     WHERE workspace_id = ?
       AND (? IS NULL OR lower(json_extract(anchors_json, '$.source_anchor.object_id')) = ?)`
  );
  return {
    lexical: (input) => slice.memoryReader.lexical(
      input.workspaceId,
      input.query,
      input.limit,
      input.nativeLimit,
      input.afterObjectId
    ),
    source: (input) => {
      const page = slice.memoryReader.source(input.workspaceId, input.objectId);
      return {
        row: page.row === null ? null : toSourceObserverRow(page.row),
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        unavailable: page.unavailable
      };
    },
    relation: (input) => slice.relationReader.read(
      input.workspaceId,
      input.subject,
      input.predicate,
      input.limit,
      input.nativeLimit,
      input.afterAssertionId
    ),
    relationKinds: (input) => {
      const subject = input.subject === null ? null : input.subject.toLowerCase();
      const rows = kindsSql.all(input.workspaceId, subject, subject) as { readonly kind: string }[];
      return rows.map((row) => row.kind);
    },
    snapshotPin: (workspaceId) => slice.indexProjection.observablePin(workspaceId)
  };
}

function entryId(entry: InformationIndex["entries"][number]): string {
  return [
    entry.hypothesis_id,
    entry.output_binding,
    entry.object_id,
    entry.program_state ?? "",
    entry.time_state ?? ""
  ].join("\0");
}

async function plantDeployment(slice: Awaited<ReturnType<typeof openSourceSlice>>) {
  await slice.writeMemory(MEM.r, "yesterday failed deployment of checkout", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.l, "deployment log for yesterday checkout failure", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.c, "last-week configuration change for checkout", MemoryDimension.FACT);
  await slice.writeMemory(MEM.s, "shared routing service for checkout", MemoryDimension.FACT);
  await slice.writeMemory(MEM.h, "prior same-service failure last month", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.u, "unrelated picnic menu", MemoryDimension.FACT);
  stampObservedAt(slice, MEM.r, YESTERDAY_INSTANT);
  stampObservedAt(slice, MEM.l, YESTERDAY_INSTANT);
  stampObservedAt(slice, MEM.c, LAST_WEEK_INSTANT);
  stampObservedAt(slice, MEM.s, LAST_WEEK_INSTANT);
  stampObservedAt(slice, MEM.h, LAST_WEEK_INSTANT);
  stampObservedAt(slice, MEM.u, LAST_WEEK_INSTANT);
  const open = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
  const edges = [
    ["assert-r-l", MEM.r, MEM.l, "observed_log"],
    ["assert-l-c", MEM.l, MEM.c, "config_via_log"],
    ["assert-r-c", MEM.r, MEM.c, "config_direct"],
    ["assert-r-s", MEM.r, MEM.s, "uses_service"],
    ["assert-s-h", MEM.s, MEM.h, "service_history"],
    ["assert-r-u", MEM.r, MEM.u, INAPPLICABLE_KIND],
    ["assert-fd-rl", MEM.r, MEM.l, "failed_deployment"],
    ["assert-fd-rs", MEM.r, MEM.s, "failed_deployment"],
    ["assert-ac-lc", MEM.l, MEM.c, "associated_config"],
    ["assert-ac-rc", MEM.r, MEM.c, "associated_config"],
    ["assert-ah-sh", MEM.s, MEM.h, "associated_history"],
    ["assert-ah-lh", MEM.l, MEM.h, "associated_history"],
    ["assert-fd-ls", MEM.l, MEM.s, "failed_deployment"]
  ] as const;
  for (const [index, [assertionId, sourceId, targetId, relationKind]] of edges.entries()) {
    await slice.admitRelation({
      evidenceId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 201).padStart(12, "0")}`,
      assertionId,
      sourceId,
      targetId,
      resultObjectId: targetId,
      relationKind,
      validity: open,
      gist: relationKind
    });
  }
}

async function plantIrrelevantRouting(slice: Awaited<ReturnType<typeof openSourceSlice>>): Promise<void> {
  const open = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
  const extras = [
    ["assert-c-u-route", MEM.c, MEM.u, "uses_service"],
    ["assert-r-s-dup", MEM.r, MEM.s, "uses_service"],
    ["assert-s-r-rev", MEM.s, MEM.r, "uses_service"]
  ] as const;
  for (const [index, [assertionId, sourceId, targetId, relationKind]] of extras.entries()) {
    await slice.admitRelation({
      evidenceId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 401).padStart(12, "0")}`,
      assertionId,
      sourceId,
      targetId,
      resultObjectId: targetId,
      relationKind,
      validity: open,
      gist: relationKind
    });
  }
}

function stampObservedAt(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  objectId: string,
  instant: string
): void {
  slice.database.connection.prepare(
    "UPDATE memory_entries SET event_time_start = ?, updated_at = ? WHERE object_id = ?"
  ).run(instant, instant, objectId);
}
