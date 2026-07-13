import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it } from "vitest";
import { SynthesisStatus } from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqliteSynthesisCapsuleRepo
} from "@do-soul/alaya-storage";
import { createRecallReadWorkerClient } from "../../runtime/recall-read-worker-client.js";

const builtWorkerUrl = new URL("../../../dist/runtime/recall-read-worker.js", import.meta.url);

describe("RecallReadWorkerClient", () => {
  // Loud failure (not skip): the wave gate builds before testing, so a missing
  // dist is a real regression, never an excuse to silently pass.
  beforeAll(() => {
    if (!existsSync(fileURLToPath(builtWorkerUrl))) {
      throw new Error("Built recall-read-worker dist missing. Run `rtk pnpm build` before this test.");
    }
  });

  it("keeps the daemon event loop available during a file-backed SQLite recall read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-test-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    const repo = new SqliteMemoryEntryRepo(database);
    const workspaceId = "workspace-1";
    const rowCount = 900;

    try {
      for (let index = 0; index < rowCount; index += 1) {
        await repo.create(createMemoryEntry({
          object_id: randomUUID(),
          workspace_id: workspaceId,
          content: `Worker recall load row ${index}`,
          activation_score: 1 - index / rowCount
        }));
      }
      // Parent must release the file before the worker opens it; Windows can
      // hang worker RPC while the parent still holds the same SQLite handle.
      database.close();

      const client = createRecallReadWorkerClient({
        databaseFilename: databasePath,
        workerUrl: builtWorkerUrl
      });
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      try {
        const startedAt = performance.now();
        const timerDelayPromise = new Promise<number>((resolve) => {
          setTimeout(() => resolve(performance.now() - startedAt), 0);
        });
        const rowsPromise = client.memoryRepo.findByWorkspaceId(workspaceId, "hot", {
          limit: rowCount,
          offset: 0
        });

        await expect(timerDelayPromise).resolves.toBeLessThan(50);
        await expect(rowsPromise).resolves.toHaveLength(rowCount);
      } finally {
        await client.close();
      }
    } finally {
      if (!database.isClosed()) {
        database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps worker batch reads scoped to the requested workspace", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-scope-test-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
    const synthesisRepo = new SqliteSynthesisCapsuleRepo(database);
    const workspaceMemoryId = randomUUID();
    const otherWorkspaceMemoryId = randomUUID();
    const workspaceSynthesisId = randomUUID();
    const otherWorkspaceSynthesisId = randomUUID();
    const workspaceEvidenceId = randomUUID();
    const otherWorkspaceEvidenceId = randomUUID();

    try {
      await memoryRepo.create(createMemoryEntry({
        object_id: workspaceMemoryId,
        workspace_id: "workspace-1",
        content: "Worker recall workspace one memory",
        activation_score: 1
      }));
      await memoryRepo.create(createMemoryEntry({
        object_id: otherWorkspaceMemoryId,
        workspace_id: "workspace-2",
        content: "Worker recall workspace two memory",
        activation_score: 1
      }));
      await synthesisRepo.create(createSynthesisCapsule({
        object_id: workspaceSynthesisId,
        workspace_id: "workspace-1",
        run_id: "run-1"
      }));
      await evidenceRepo.create(createEvidenceCapsule({
        object_id: workspaceEvidenceId,
        workspace_id: "workspace-1",
        run_id: "run-1",
        artifact_ref: "doc-s1-t10"
      }));
      await evidenceRepo.create(createEvidenceCapsule({
        object_id: otherWorkspaceEvidenceId,
        workspace_id: "workspace-2",
        run_id: "run-2",
        artifact_ref: "doc-s1-t11"
      }));
      await synthesisRepo.create(createSynthesisCapsule({
        object_id: otherWorkspaceSynthesisId,
        workspace_id: "workspace-2",
        run_id: "run-2"
      }));
      database.close();

      const client = createRecallReadWorkerClient({
        databaseFilename: databasePath,
        workerUrl: builtWorkerUrl
      });
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      try {
        await expect(
          client.memoryRepo.findByIds!("workspace-1", [
            workspaceMemoryId,
            otherWorkspaceMemoryId
          ])
        ).resolves.toMatchObject([{ object_id: workspaceMemoryId }]);
        await expect(
          client.memoryRepo.searchManyByKeywordWithinObjectIds!(
            "workspace-1",
            [
              { queryText: "workspace one", limit: 5 },
              { queryText: "Worker recall", limit: 5 }
            ],
            [workspaceMemoryId, otherWorkspaceMemoryId]
          )
        ).resolves.toEqual([
          [expect.objectContaining({ object_id: workspaceMemoryId })],
          [expect.objectContaining({ object_id: workspaceMemoryId })]
        ]);
        await expect(
          client.synthesisSearchPort.findByIds("workspace-1", [
            workspaceSynthesisId,
            otherWorkspaceSynthesisId
          ])
        ).resolves.toMatchObject([{ object_id: workspaceSynthesisId }]);
        await expect(
          client.evidenceSearchPort.findSourceAnchorsByIds!("workspace-1", [
            workspaceEvidenceId,
            otherWorkspaceEvidenceId
          ])
        ).resolves.toEqual([{
          evidence_object_id: workspaceEvidenceId,
          artifact_ref: "doc-s1-t10"
        }]);
      } finally {
        await client.close();
      }
    } finally {
      if (!database.isClosed()) {
        database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects worker page requests above the bounded read limit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-page-test-"));
    const database = initDatabase({ filename: join(directory, "alaya.db") });

    try {
      const client = createRecallReadWorkerClient({
        databaseFilename: database.filename,
        workerUrl: builtWorkerUrl
      });
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      try {
        await expect(
          client.memoryRepo.findByWorkspaceId("workspace-1", "hot", {
            limit: 5001,
            offset: 0
          })
        ).rejects.toThrow("page.limit must be an integer between 0 and 5000");
      } finally {
        await client.close();
      }
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("times out pending worker requests and closes the client", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-timeout-test-"));
    const workerPath = join(directory, "silent-worker.mjs");
    writeFileSync(
      workerPath,
      `import { parentPort } from "node:worker_threads";\nparentPort?.on("message", () => {});\n`
    );
    const client = createRecallReadWorkerClient({
      databaseFilename: join(directory, "alaya.db"),
      workerUrl: pathToFileURL(workerPath),
      requestTimeoutMs: 5
    });

    try {
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      await expect(
        client.memoryRepo.findByWorkspaceId("workspace-1", "hot", {
          limit: 1,
          offset: 0
        })
      ).rejects.toThrow("timed out after 5ms");
      await expect(client.memoryRepo.findByWorkspaceId("workspace-1")).rejects.toThrow(
        "recall read worker is closed"
      );
    } finally {
      await client?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves close when the worker never responds to the close request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-close-timeout-test-"));
    const workerPath = join(directory, "silent-worker.mjs");
    writeFileSync(
      workerPath,
      `import { parentPort } from "node:worker_threads";\nparentPort?.on("message", () => {});\n`
    );
    const client = createRecallReadWorkerClient({
      databaseFilename: join(directory, "alaya.db"),
      workerUrl: pathToFileURL(workerPath),
      requestTimeoutMs: 5
    });

    try {
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      await expect(client.close()).resolves.toBeUndefined();
      await expect(client.memoryRepo.findByWorkspaceId("workspace-1")).rejects.toThrow(
        "recall read worker is closed"
      );
    } finally {
      await client?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createMemoryEntry(overrides: {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly content: string;
  readonly activation_score: number;
}) {
  return {
    object_id: overrides.object_id,
    object_kind: "memory_entry" as const,
    schema_version: 1,
    lifecycle_state: "active" as const,
    created_at: "2026-06-17T00:00:00.000Z",
    updated_at: "2026-06-17T00:00:00.000Z",
    created_by: "test",
    dimension: "procedure" as const,
    source_kind: "user" as const,
    formation_kind: "explicit" as const,
    scope_class: "project" as const,
    content: overrides.content,
    domain_tags: ["recall"],
    evidence_refs: [],
    workspace_id: overrides.workspace_id,
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot" as const,
    activation_score: overrides.activation_score,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}

function createSynthesisCapsule(overrides: {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
}) {
  return {
    object_id: overrides.object_id,
    object_kind: "synthesis_capsule" as const,
    schema_version: 1,
    lifecycle_state: "active" as const,
    created_at: "2026-06-17T00:00:00.000Z",
    updated_at: "2026-06-17T00:00:00.000Z",
    created_by: "test",
    topic_key: "recall/worker",
    synthesis_type: "phase_synthesis" as const,
    summary: `Synthesis for ${overrides.workspace_id}`,
    evidence_refs: [],
    source_memory_refs: [],
    workspace_id: overrides.workspace_id,
    run_id: overrides.run_id,
    synthesis_status: SynthesisStatus.WORKING
  };
}

function createEvidenceCapsule(overrides: {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly artifact_ref: string;
}) {
  return {
    object_id: overrides.object_id,
    object_kind: "evidence_capsule" as const,
    schema_version: 1,
    lifecycle_state: "active" as const,
    created_at: "2026-06-17T00:00:00.000Z",
    updated_at: "2026-06-17T00:00:00.000Z",
    created_by: "test",
    evidence_kind: "tool_output" as const,
    semantic_anchor: { topic: "worker", keywords: [], summary: "worker anchor" },
    event_anchor: null,
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: overrides.artifact_ref
    },
    evidence_health_state: "verified" as const,
    gist: "worker evidence",
    excerpt: "worker evidence excerpt",
    source_hash: null,
    run_id: overrides.run_id,
    workspace_id: overrides.workspace_id,
    surface_id: null
  };
}
