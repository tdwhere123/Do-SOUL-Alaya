import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension, type RelationValidity } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";

const databases = new Set<StorageDatabase>();
const SEED = "aaaaaaaa-aaaa-4aaa-8aaa-000000000801";
const LOG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000802";
const CONFIG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000803";
const HISTORY = "aaaaaaaa-aaaa-4aaa-8aaa-000000000804";
const QUERY = "yesterday failed deployment";
const OPEN: RelationValidity = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const request = { workspaceId: "workspace-1", strategy: "analyze" as const,
  taskSurface: { ...createTaskSurface(), display_name: QUERY }, queryText: QUERY, pageBudget: 100 };

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

type Fixture = Awaited<ReturnType<typeof createSourceBoundRecallFixture>>;

async function sources() {
  const fixture = await createSourceBoundRecallFixture((database) => databases.add(database));
  await fixture.writeSource({ objectId: SEED, content: "yesterday failed deployment of checkout",
    dimension: MemoryDimension.EPISODE });
  await fixture.writeSource({ objectId: LOG, content: "isolated diagnostic log details",
    dimension: MemoryDimension.EPISODE });
  await fixture.writeSource({ objectId: CONFIG, content: "last week routing configuration",
    dimension: MemoryDimension.FACT });
  await fixture.writeSource({ objectId: HISTORY, content: "prior same-service incident",
    dimension: MemoryDimension.EPISODE });
  fixture.database.connection.prepare("UPDATE memory_entries SET event_time_start = ? WHERE object_id = ?")
    .run("2026-09-05T12:00:00.000Z", SEED);
  return fixture;
}

async function relation(fixture: Fixture, number: number, sourceId: string, targetId: string,
  relationKind: string, validity: RelationValidity = OPEN) {
  const evidenceId = `bbbbbbbb-bbbb-4bbb-8bbb-${String(number).padStart(12, "0")}`;
  await fixture.admitRelation({ evidenceId, assertionId: `relation-${number}`,
    sourceId, targetId, resultObjectId: targetId, relationKind, validity, gist: relationKind });
  return evidenceId;
}

describe("source-backed conditional association and evidence", () => {
  it("keeps an actual lexical association unknown without a supporting relation witness", async () => {
    const fixture = await sources();
    const result = await fixture.service.recall(request);
    const seed = result.index.entries.find((entry) => entry.object_id === SEED);
    expect(seed).toBeDefined();
    expect(seed?.association_milligrades).toBeGreaterThan(0);
    expect(seed?.claim).toBe("unknown");
    expect(seed?.explanation_ids.length).toBeGreaterThan(0);
    expect(result.index.entries.some((entry) => entry.object_id === CONFIG)).toBe(false);
    const leaves = (result.index.explanations ?? []).flatMap((row) => row.leaf_ids ?? []);
    expect(leaves.some((id) => id.startsWith("relation-"))).toBe(false);
  });

  it("composes admitted source relations by max-min and exposes their own evidence", async () => {
    const fixture = await sources();
    await relation(fixture, 811, SEED, LOG, "observed_log");
    const viaLog = await relation(fixture, 812, LOG, CONFIG, "config_via_log");
    await relation(fixture, 813, SEED, CONFIG, "config_direct");
    const result = await fixture.service.recall(request);
    const config = result.index.entries.find((entry) => entry.object_id === CONFIG);
    expect(config).toBeDefined();
    expect(config?.association_milligrades).toBe(1000);
    expect(config?.claim).toBe("supported");
    expect(config?.explanation_ids.length).toBeGreaterThan(0);
    expect(result.index.explanations?.some((derivation) => derivation.leaf_ids.includes("relation-812")))
      .toBe(true);
    const admitted = fixture.relationReader.read("workspace-1", LOG, "config_via_log", 16);
    expect(admitted.observations[0]?.evidenceReceipts?.map((receipt) => receipt.evidenceId)).toContain(viaLog);
    const seed = result.index.entries.find((entry) => entry.object_id === SEED);
    expect(seed?.claim).toBe("unknown");
    expect(seed?.explanation_ids.some((id) => config?.explanation_ids.includes(id))).toBe(false);
    expect(result.candidates.map((entry) => entry.object_id)).toEqual(
      result.index.entries.map((entry) => entry.object_id)
    );
  });

  it("does not admit expired relation targets while the real lexical source remains visible", async () => {
    const fixture = await sources();
    await relation(fixture, 821, SEED, LOG, "observed_log", {
      kind: "bounded", valid_from: "2026-01-01T00:00:00.000Z", valid_to: "2026-02-01T00:00:00.000Z"
    });
    const result = await fixture.service.recall(request);
    expect(result.index.entries.map((entry) => entry.object_id)).toContain(SEED);
    expect(result.index.entries.map((entry) => entry.object_id)).not.toContain(LOG);
    expect(await fixture.memoryEntryRepo.findById(LOG)).not.toBeNull();
  });

  it("does not turn a stored supersedes edge into query support or a hidden suppression ranker", async () => {
    const fixture = await sources();
    const before = await fixture.service.recall(request);
    await relation(fixture, 831, SEED, HISTORY, "supersedes");
    const after = await fixture.service.recall(request);
    expect(after.index.entries.map((entry) => entry.object_id)).toEqual(
      before.index.entries.map((entry) => entry.object_id)
    );
    expect(after.index.entries.find((entry) => entry.object_id === SEED)?.association_milligrades)
      .toBe(before.index.entries.find((entry) => entry.object_id === SEED)?.association_milligrades);
    expect(after.index.entries.find((entry) => entry.object_id === SEED)?.claim).toBe("unknown");
    expect(after.index.entries.map((entry) => entry.object_id)).not.toContain(HISTORY);
  });
});
