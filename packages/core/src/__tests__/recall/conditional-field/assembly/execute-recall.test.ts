import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MemoryDimension,
  type InformationIndex
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import {
  runConditionalFieldRecall,
  type ObserverReaders
} from "../../../../recall/recall-service.js";
import {
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget
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
    expect(index.entries.find((entry) => entry.object_id === MEM.c)?.association_milligrades)
      .toBe(850);
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
    const first = runRecall(slice, { page_budget: 2 });
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
          : { object_id: page.row.object_id, sourceRevision: page.row.sourceRevision },
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
    )
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
  const open = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
  const edges = [
    ["assert-r-l", MEM.r, MEM.l, "observed_log"],
    ["assert-l-c", MEM.l, MEM.c, "config_via_log"],
    ["assert-r-c", MEM.r, MEM.c, "config_direct"],
    ["assert-r-s", MEM.r, MEM.s, "uses_service"],
    ["assert-s-h", MEM.s, MEM.h, "service_history"],
    ["assert-r-u", MEM.r, MEM.u, INAPPLICABLE_KIND]
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
