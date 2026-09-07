import { afterEach, describe, expect, it } from "vitest";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { SemanticEnrichmentWorker } from "../../../conversation/semantic-enrichment-worker.js";
import { artifactFixture, response } from "./artifact-lifecycle-fixture.js";
import { MEM, WS } from "./ids.js";

const databases = new Set<StorageDatabase>();
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

const fixture = () => artifactFixture((database) => databases.add(database));

function tombstone(database: StorageDatabase, objectId: string): void {
  database.connection.prepare(
    "UPDATE memory_entries SET retention_state='tombstoned' WHERE object_id=?"
  ).run(objectId);
}

function semanticFts(database: StorageDatabase, objectId?: string): readonly { object_id: string }[] {
  return objectId === undefined
    ? database.connection.prepare("SELECT object_id FROM garden_semantic_fts").all() as { object_id: string }[]
    : database.connection.prepare("SELECT object_id FROM garden_semantic_fts WHERE object_id=?")
      .all(objectId) as { object_id: string }[];
}

function attemptRows(database: StorageDatabase, taskId: string): readonly { state: string; bytes: number | null }[] {
  return database.connection.prepare(
    "SELECT state, length(raw_json) AS bytes FROM garden_semantic_attempts WHERE task_id=?"
  ).all(taskId) as { state: string; bytes: number | null }[];
}

describe("retained lifecycle and completion admission", () => {
  it("does not extract or republish after retention tombstone of an enqueued source", async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, "Alice owns Orion");
    expect(f.repo.source(WS, MEM.orion)).not.toBeNull();
    tombstone(f.slice.database, MEM.orion);
    expect(f.repo.source(WS, MEM.orion)).toBeNull();
    expect(() => f.enqueue(MEM.orion)).toThrow(/source missing, revoked, or outside trusted scope/);
    let extracts = 0;
    const worker = f.worker(SemanticEnrichmentWorker.composeProviderTransport({
      extract: async ({ userPrompt }) => {
        extracts += 1;
        return { rawJson: response(userPrompt) };
      }
    }));
    expect(await worker.run(WS, task)).toBe("superseded_source");
    expect(extracts).toBe(0);
    expect(semanticFts(f.slice.database)).toEqual([]);
    expect(f.repo.searchReady(WS, "Orion", 10)).toEqual([]);
    expect(f.repo.task(WS, task)?.status).toBe("failed");
  });

  it("does not persist a completion or FTS row when the source is tombstoned during external work", async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, "Alice owns Orion");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let extracts = 0;
    const worker = f.worker({
      execute: async (request) => {
        extracts += 1;
        await gate;
        return response(request);
      },
      reconcile: async () => ({ kind: "unknown" as const })
    });
    const running = worker.run(WS, task);
    await new Promise((resolve) => setImmediate(resolve));
    tombstone(f.slice.database, MEM.orion);
    release();
    expect(await running).toBe("superseded_source");
    expect(extracts).toBe(1);
    expect(attemptRows(f.slice.database, task).some((row) => row.state === "received")).toBe(false);
    expect(semanticFts(f.slice.database)).toEqual([]);
    expect(f.repo.searchReady(WS, "Orion", 10)).toEqual([]);
  });

  it("does not reconcile or extract again when the source is tombstoned before restart", async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, "Alice owns Orion");
    let extracts = 0;
    let raw = "";
    const worker = f.worker(SemanticEnrichmentWorker.composeProviderTransport({
      extract: async ({ userPrompt }) => {
        extracts += 1;
        raw = response(userPrompt);
        throw new Error("lost extract");
      },
      reconcile: async () => ({ kind: "received", rawJson: raw })
    }));
    expect(await worker.run(WS, task)).toBe("uncertain");
    tombstone(f.slice.database, MEM.orion);
    f.advance();
    expect(await worker.run(WS, task)).toBe("superseded_source");
    expect(extracts).toBe(1);
    expect(attemptRows(f.slice.database, task).some((row) => row.state === "received")).toBe(false);
    expect(semanticFts(f.slice.database)).toEqual([]);
  });

  it("hides leftover semantic FTS after an active row is retention-tombstoned", async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, "Alice owns Orion");
    expect(await f.worker({
      execute: async (request) => response(request),
      reconcile: async () => ({ kind: "unknown" as const })
    }).run(WS, task)).toBe("completed");
    expect(f.repo.searchReady(WS, "Orion", 10)).toHaveLength(1);
    tombstone(f.slice.database, MEM.orion);
    expect(semanticFts(f.slice.database, MEM.orion)).toEqual([]);
    f.slice.database.connection.prepare("INSERT INTO garden_semantic_fts VALUES (?, ?, ?)")
      .run(WS, MEM.orion, "Alice owns Orion");
    expect(f.repo.searchReady(WS, "Orion", 10)).toEqual([]);
  });

  it("rejects an oversized execute completion before durable received state", async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, "Alice owns Orion");
    const huge = JSON.stringify({
      signals: [{ object_kind: "decision", confidence: 0.8, matched_text: "x".repeat(8_000), distilled_fact: "x" }]
    });
    const worker = f.worker({
      execute: async () => huge,
      reconcile: async () => ({ kind: "unknown" as const })
    }, f.audit, 3, 32 * 16_384, 20);
    expect(await worker.run(WS, task)).toBe("completion_limit_exceeded");
    expect(attemptRows(f.slice.database, task).some((row) => row.state === "received")).toBe(false);
    expect(semanticFts(f.slice.database)).toEqual([]);
  });

  it("rejects the same oversized completion on reconcile without persisting raw bytes", async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, "Alice owns Orion");
    let raw = "";
    const transport = SemanticEnrichmentWorker.composeProviderTransport({
      extract: async ({ userPrompt }) => {
        raw = response(userPrompt);
        throw new Error("response lost");
      },
      reconcile: async () => ({ kind: "received", rawJson: raw })
    }, { maxCompletionUtf8Bytes: 20 });
    const worker = f.worker(transport, f.audit, 3, 32 * 16_384, 20);
    expect(await worker.run(WS, task)).toBe("uncertain");
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(20);
    f.advance();
    expect(await worker.run(WS, task)).toBe("completion_limit_exceeded");
    expect(attemptRows(f.slice.database, task).some((row) => row.state === "received")).toBe(false);
    expect(semanticFts(f.slice.database, MEM.orion)).toEqual([]);
  });

  it("rejects oversized completions when the worker is constructed without maxCompletionUtf8Bytes", async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, "Alice owns Orion");
    const huge = "x".repeat(262_145);
    const worker = f.worker({
      execute: async () => huge,
      reconcile: async () => ({ kind: "unknown" as const })
    });
    expect(await worker.run(WS, task)).toBe("completion_limit_exceeded");
    expect(attemptRows(f.slice.database, task).some((row) => row.state === "received")).toBe(false);
    expect(semanticFts(f.slice.database)).toEqual([]);
  });

  it("rejects already-received oversized raw before put or publication", async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, "Alice owns Orion");
    const t = {
      execute: async (request: string) => response(request),
      reconcile: async () => ({ kind: "unknown" as const })
    };
    const crashed = f.worker(t, async (action, claimed, mutate) => {
      const result = await f.audit(action, claimed, mutate);
      if (action === "received") throw new Error("process stopped after received commit");
      return result;
    });
    await expect(crashed.run(WS, task)).rejects.toThrow(/received commit/);
    expect(attemptRows(f.slice.database, task).some((row) => row.state === "received")).toBe(true);
    f.advance();
    expect(await f.worker(t, f.audit, 3, 32 * 16_384, 20).run(WS, task)).toBe("completion_limit_exceeded");
    expect(f.slice.database.connection.prepare(
      "SELECT COUNT(*) AS n FROM garden_semantic_artifacts"
    ).get()).toEqual({ n: 0 });
    expect(semanticFts(f.slice.database)).toEqual([]);
  });
});
