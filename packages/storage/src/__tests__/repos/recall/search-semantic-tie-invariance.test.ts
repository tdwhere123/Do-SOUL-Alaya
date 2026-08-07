import { afterEach, describe, expect, it } from "vitest";
import type { SynthesisCapsule } from "@do-soul/alaya-protocol";
import { SqliteEvidenceCapsuleRepo } from "../../../repos/capsules/evidence-capsule-repo.js";
import { SqliteSynthesisCapsuleRepo } from "../../../repos/capsules/synthesis-capsule-repo.js";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "../memory-entry/memory-entry-repo-fixture.js";
import { createEvidenceCapsule } from "../capsules/evidence-capsule-repo-fixture.js";

const LOW_ID = "11111111-1111-4111-8111-111111111111";
const HIGH_ID = "99999999-9999-4999-8999-999999999999";
const LOW_SHORT_ID = "22222222-2222-4222-8222-222222222222";
const HIGH_SHORT_ID = "88888888-8888-4888-8888-888888888888";
const ALPHA_STABLE = "Alpha stable record";
const ZEBRA_STABLE = "Zebra stable record";
const ALPHA_SHORT = "Alpha go record";
const ZEBRA_SHORT = "Zebra go record";
const SHARED_STABLE = "Shared stable record";
const SHARED_SHORT = "Shared go record";

afterEach(() => {
  for (const database of trackedDatabases) database.close();
  trackedDatabases.clear();
});

function idsForReplay(swapped: boolean): Readonly<{ alpha: string; zebra: string }> {
  return swapped
    ? { alpha: LOW_ID, zebra: HIGH_ID }
    : { alpha: HIGH_ID, zebra: LOW_ID };
}

async function memorySearchSnapshot(swapped: boolean) {
  const { repo } = await createRepo();
  const ids = idsForReplay(swapped);
  const rows = [
    createMemoryEntry({ object_id: ids.alpha, content: ALPHA_STABLE }),
    createMemoryEntry({ object_id: ids.zebra, run_id: "run-2", content: ZEBRA_STABLE }),
    createMemoryEntry({
      object_id: swapped ? LOW_SHORT_ID : HIGH_SHORT_ID,
      content: ALPHA_SHORT
    }),
    createMemoryEntry({
      object_id: swapped ? HIGH_SHORT_ID : LOW_SHORT_ID,
      run_id: "run-2",
      content: ZEBRA_SHORT
    })
  ];
  for (const row of rows) await repo.create(row);
  const contentById = new Map(rows.map((row) => [row.object_id, row.content]));
  const porter = await repo.searchByKeyword("workspace-1", "stable", 1);
  const exact = await repo.searchByKeyword("workspace-1", "go", 1);
  return {
    porter: contentById.get(porter[0]!.object_id),
    exact: contentById.get(exact[0]!.object_id)
  };
}

async function mixedCaseMemorySearchSnapshot() {
  const { repo } = await createRepo();
  const rows = [
    createMemoryEntry({ object_id: LOW_ID, content: "alpha stable record" }),
    createMemoryEntry({ object_id: HIGH_ID, run_id: "run-2", content: ZEBRA_STABLE }),
    createMemoryEntry({ object_id: LOW_SHORT_ID, content: "alpha go record" }),
    createMemoryEntry({ object_id: HIGH_SHORT_ID, run_id: "run-2", content: ZEBRA_SHORT })
  ];
  for (const row of rows) await repo.create(row);
  const contentById = new Map(rows.map((row) => [row.object_id, row.content]));
  const porter = await repo.searchByKeyword("workspace-1", "stable", 1);
  const exact = await repo.searchByKeyword("workspace-1", "go", 1);
  return {
    porter: contentById.get(porter[0]!.object_id),
    exact: contentById.get(exact[0]!.object_id)
  };
}

async function identicalMemorySearchSnapshot(swapped: boolean) {
  const { repo } = await createRepo();
  const ids = idsForReplay(swapped);
  const rows = [
    createMemoryEntry({
      object_id: ids.alpha,
      content: SHARED_STABLE,
      canonical_entities: ["alpha"]
    }),
    createMemoryEntry({
      object_id: ids.zebra,
      run_id: "run-2",
      content: SHARED_STABLE,
      canonical_entities: ["zebra"]
    }),
    createMemoryEntry({
      object_id: swapped ? LOW_SHORT_ID : HIGH_SHORT_ID,
      content: SHARED_SHORT,
      canonical_entities: ["alpha"]
    }),
    createMemoryEntry({
      object_id: swapped ? HIGH_SHORT_ID : LOW_SHORT_ID,
      run_id: "run-2",
      content: SHARED_SHORT,
      canonical_entities: ["zebra"]
    })
  ];
  for (const row of rows) await repo.create(row);
  const entityById = new Map(rows.map((row) => [
    row.object_id,
    row.canonical_entities?.join(",")
  ]));
  const porter = await repo.searchByKeyword("workspace-1", "stable", 1);
  const exact = await repo.searchByKeyword("workspace-1", "go", 1);
  return {
    porter: entityById.get(porter[0]!.object_id),
    exact: entityById.get(exact[0]!.object_id)
  };
}

async function evidenceSearchSnapshot(swapped: boolean) {
  const { database } = await createRepo();
  const repo = new SqliteEvidenceCapsuleRepo(database);
  const ids = idsForReplay(swapped);
  const capsules = [
    createEvidenceCapsule({
      object_id: ids.alpha,
      gist: ALPHA_STABLE,
      excerpt: ALPHA_STABLE,
      source_hash: "sha256:alpha"
    }),
    createEvidenceCapsule({
      object_id: ids.zebra,
      run_id: "run-2",
      gist: ZEBRA_STABLE,
      excerpt: ZEBRA_STABLE,
      source_hash: "sha256:zebra"
    })
  ];
  for (const capsule of capsules) await repo.create(capsule);
  const hit = (await repo.searchByKeyword("workspace-1", "stable", 1))[0]!;
  return new Map(capsules.map((capsule) => [capsule.object_id, capsule.excerpt])).get(hit.object_id);
}

async function synthesisSearchSnapshot(swapped: boolean) {
  const { database } = await createRepo();
  const repo = new SqliteSynthesisCapsuleRepo(database);
  const ids = idsForReplay(swapped);
  const capsules = [
    createSynthesisCapsule(ids.alpha, ALPHA_STABLE, "run-1"),
    createSynthesisCapsule(ids.zebra, ZEBRA_STABLE, "run-2")
  ];
  for (const capsule of capsules) await repo.create(capsule);
  const hit = (await repo.searchByKeyword("workspace-1", "stable", 1))[0]!;
  return new Map(capsules.map((capsule) => [capsule.object_id, capsule.summary])).get(hit.object_id);
}

function createSynthesisCapsule(
  objectId: string,
  summary: string,
  runId: string
): SynthesisCapsule {
  return {
    object_id: objectId,
    object_kind: "synthesis_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-08-06T03:00:00.000Z",
    updated_at: "2026-08-06T03:00:00.000Z",
    created_by: "test",
    topic_key: "stable-replay",
    synthesis_type: "pattern_detection",
    summary,
    evidence_refs: [],
    source_memory_refs: [],
    workspace_id: "workspace-1",
    run_id: runId,
    synthesis_status: "working"
  };
}

describe("search semantic tie invariance", () => {
  it("keeps memory FTS and short-token cutoffs independent of object IDs", async () => {
    const first = await memorySearchSnapshot(false);
    const replay = await memorySearchSnapshot(true);

    expect(first).toEqual({ porter: ALPHA_STABLE, exact: ALPHA_SHORT });
    expect(replay).toEqual(first);
  });

  it("uses the SQLite binary order for FTS and short-token ties", async () => {
    await expect(mixedCaseMemorySearchSnapshot()).resolves.toEqual({
      porter: ZEBRA_STABLE,
      exact: ZEBRA_SHORT
    });
  });

  it("keeps equal-content memory cutoffs independent of object IDs", async () => {
    const first = await identicalMemorySearchSnapshot(false);
    const replay = await identicalMemorySearchSnapshot(true);

    expect(first).toEqual({ porter: "alpha", exact: "alpha" });
    expect(replay).toEqual(first);
  });

  it("keeps evidence FTS cutoffs independent of object IDs", async () => {
    const first = await evidenceSearchSnapshot(false);
    const replay = await evidenceSearchSnapshot(true);

    expect(first).toBe(ALPHA_STABLE);
    expect(replay).toBe(first);
  });

  it("keeps synthesis FTS cutoffs independent of object IDs", async () => {
    const first = await synthesisSearchSnapshot(false);
    const replay = await synthesisSearchSnapshot(true);

    expect(first).toBe(ALPHA_STABLE);
    expect(replay).toBe(first);
  });
});
