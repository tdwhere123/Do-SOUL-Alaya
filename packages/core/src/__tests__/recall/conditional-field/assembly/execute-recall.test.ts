import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MemoryDimension,
  type InformationIndex
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import {
  RecallService,
  runConditionalFieldRecall,
  type ObserverReaders
} from "../../../../recall/recall-service.js";
import { observeConditionalField, startObserverCursor } from
  "../../../../recall/conditional-field/observers/observe.js";
import { createDependencies, createTaskSurface } from "../../recall-service-test-fixtures.js";
import {
  INTERPRETATION_CLOCK,
  LAST_WEEK_INSTANT,
  SNAPSHOT_ID,
  YESTERDAY_INSTANT,
  defaultBudget,
  yesterdayAnchorGuard
} from "../reference/deployment.fixture.js";
import { INAPPLICABLE_KIND, MEM, WS, openSourceSlice } from "../vertical/source-slice.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field executeRecall assembly", () => {
  it("A01/A02/A13 bind last-week config and unknown-cause history", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const index = runRecall(slice, { page_budget: 800 });
    expect(index.entries.find((entry) => entry.object_id === MEM.h)?.association_milligrades)
      .toBe(550);
    expect(index.entries.some((entry) => entry.claim === "unknown")).toBe(true);
    expect(index.completeness.logical_index).toBe("complete");
    expect(JSON.stringify(index)).not.toContain("ranking_authority");
    expect(JSON.stringify(index)).not.toContain("select_gamma");
  });

  it("A14/A15 pages without a second selector and keeps continuation identity", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const first = runRecall(slice, { page_budget: 1 });
    expect(first.continuation).not.toBeNull();
    expect(first.completeness.transport).toBe("partial");
    const second = runRecall(slice, {
      page_budget: 2,
      continuation: first.continuation
    });
    const full = runRecall(slice, { page_budget: 800 });
    const concatenated = [...first.entries, ...second.entries].map(entryId);
    expect(concatenated).toEqual(full.entries.map(entryId).slice(0, concatenated.length));
    expect(first.query_id).toBe(full.query_id);
    expect(first.snapshot_id).toBe(full.snapshot_id);
  });

  it("A12 reports empty exhausted versus cancelled", async () => {
    const empty = await openSourceSlice((database) => databases.add(database));
    const exhausted = runRecall(empty, { page_budget: 800 });
    expect(exhausted.entries).toEqual([]);
    const cancelled = runRecall(empty, { page_budget: 800, cancelled: true });
    expect(cancelled.completeness.observed_coverage).toBe("cancelled");
    expect(cancelled.completeness.logical_index).not.toBe("complete");
  });

  it("A17 keeps garden enqueue at zero during ordinary recall", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const before = slice.pendingGarden().length;
    runRecall(slice, { page_budget: 800 });
    expect(slice.pendingGarden()).toHaveLength(before);
    expect(slice.pendingGarden()).toHaveLength(0);
  });

  it("A01 keeps last-week config; applying yesterday to every object drops it from seeds", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const index = runRecall(slice, { page_budget: 800 });
    expect(index.entries.find((entry) => entry.object_id === MEM.c)?.association_milligrades)
      .toBe(850);
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
        view: { schema_version: 1, requested_roles: ["requested", "associated"] },
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
    expect(commands.completeness.observed_coverage).not.toBe("unavailable");
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
    const { dependencies } = createDependencies([]);
    const service = new RecallService({
      testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      now: () => new Date(Date.parse(INTERPRETATION_CLOCK) + ticks++ * 1_000).toISOString(),
      observerReaders: readersFor(slice)
    });
    const surface = { ...createTaskSurface(), display_name: "yesterday failed deployment" };
    const first = await service.recall({
      taskSurface: surface,
      workspaceId: WS,
      strategy: "chat",
      queryText: "yesterday failed deployment",
      pageBudget: 1,
      interpretationClock: INTERPRETATION_CLOCK
    });
    const second = await service.recall({
      taskSurface: surface,
      workspaceId: WS,
      strategy: "chat",
      queryText: "yesterday failed deployment",
      pageBudget: 1,
      interpretationClock: INTERPRETATION_CLOCK,
      continuation: first.index.continuation
    });
    expect(first.index.snapshot_id).toBe(second.index.snapshot_id);
    expect(second.index.completeness.observed_coverage).not.toBe("invalidated");
    const concatenated = [...first.index.entries, ...second.index.entries].map(entryId);
    const full = runRecall(slice, { page_budget: 800 });
    expect(concatenated).toEqual(full.entries.map(entryId).slice(0, concatenated.length));
  });

  it("worker-port recall preserves query and snapshot identity of the local producer", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const { dependencies } = createDependencies([]);
    const service = new RecallService({
      testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      observerReaders: readersFor(slice),
      conditionalFieldPort: {
        recall: async (input) => runConditionalFieldRecall({ ...input, readers: readersFor(slice) })
      }
    });
    const local = runRecall(slice, { page_budget: 800 });
    const viaPort = await service.recall({
      taskSurface: { ...createTaskSurface(), display_name: "yesterday failed deployment" },
      workspaceId: WS,
      strategy: "chat",
      queryText: "yesterday failed deployment",
      pageBudget: 800,
      interpretationClock: INTERPRETATION_CLOCK
    });
    expect(viaPort.index.query_id).toBe(local.query_id);
    expect(viaPort.index.entries.map(entryId)).toEqual(local.entries.map(entryId));
    expect(viaPort.candidates[0]?.content_preview).not.toMatch(/associated unknown /);
  });
});

function runRecall(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  input: Readonly<{
    readonly page_budget: number;
    readonly continuation?: InformationIndex["continuation"];
    readonly cancelled?: boolean;
  }>
): InformationIndex {
  return runConditionalFieldRecall({
    workspace_id: WS,
    query_text: "yesterday failed deployment",
    budget: defaultBudget({ page_budget: input.page_budget }),
    snapshot_id: SNAPSHOT_ID,
    interpretation_clock: INTERPRETATION_CLOCK,
    as_of: INTERPRETATION_CLOCK,
    expires_at: "2099-01-01T00:00:00.000Z",
    readers: readersFor(slice),
    continuation: input.continuation ?? null,
    cancelled: input.cancelled === true
  });
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
        row: page.row === null
          ? null
          : {
            object_id: page.row.object_id,
            sourceRevision: page.row.sourceRevision,
            observed_at: page.row.event_time_start ?? undefined,
            content: page.row.content,
            lifecycle_state: page.row.lifecycle_state,
            retention_state: page.row.retention_state,
            scope_class: page.row.scope_class,
            evidence_refs: page.row.evidence_refs,
            valid_from: page.row.valid_from,
            valid_to: page.row.valid_to
          },
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
    snapshotPin: () => {
      const cursor = slice.indexProjection.cursor(WS);
      return {
        source_revision: String(cursor?.appliedEventRevision ?? 1),
        ...(cursor?.appliedAt === undefined ? {} : { applied_at: cursor.appliedAt })
      };
    }
  };
}

function entryId(entry: InformationIndex["entries"][number]): string {
  return `${entry.hypothesis_id}\0${entry.output_binding}\0${entry.object_id}`;
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

function stampObservedAt(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  objectId: string,
  instant: string
): void {
  slice.database.connection.prepare(
    "UPDATE memory_entries SET created_at = ?, updated_at = ? WHERE object_id = ?"
  ).run(instant, instant, objectId);
}
