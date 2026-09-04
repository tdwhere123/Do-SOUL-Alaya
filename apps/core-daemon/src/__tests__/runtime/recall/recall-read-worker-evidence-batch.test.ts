import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo
} from "@do-soul/alaya-storage";
import {
  createRecallReadWorkerClient,
  type RecallReadWorkerClient
} from "../../../runtime/recall/recall-read-worker-client.js";

const builtWorkerUrl = new URL("../../../../dist/runtime/recall/recall-read-worker.js", import.meta.url);

beforeAll(() => {
  if (!existsSync(fileURLToPath(builtWorkerUrl))) {
    throw new Error(
      "Built recall-read-worker dist missing. Run `pnpm build` before this test."
    );
  }
});

describe("RecallReadWorkerClient evidence batch alignment", () => {
  it("preserves query order and workspace scope", async () => {
    const fixture = await createFixture();
    try {
      const queries = [
        { queryText: "worker shared", limit: 1, refinement_depths: [2] },
        { queryText: "alphauniquekey", limit: 2 },
        { queryText: "absentuniquekey", limit: 4 },
        { queryText: "betauniquekey", limit: 3 }
      ] as const;
      const scalarFields = await loadScalarFields(fixture.client, queries);
      const batch = await fixture.client.evidenceSearchPort.searchManyByKeywordField!(
        "workspace-1",
        queries
      );

      expect(batch).toEqual(scalarFields);
      expect(batch[0]?.matches).toHaveLength(1);
      expect(batch[0]?.refinement_levels?.[0]?.matches).toHaveLength(2);
      expect(batch[1]?.matches).toEqual([
        expect.objectContaining({
          object_id: fixture.alphaEvidenceId
        })
      ]);
      expect(batch[2]?.matches).toEqual([]);
      expect(batch[3]?.matches).toEqual([
        expect.objectContaining({ object_id: fixture.betaEvidenceId })
      ]);
      expect(batch[1]?.matches[0]?.object_id).not.toBe(batch[3]?.matches[0]?.object_id);
    } finally {
      await fixture.client.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("RecallReadWorkerClient evidence batch validation", () => {
  it("rejects the whole request when one query is malformed", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        fixture.client.evidenceSearchPort.searchManyByKeywordField!("workspace-1", [
          { queryText: "worker", limit: 5 },
          { queryText: "invalid", limit: Number.NaN }
        ])
      ).rejects.toThrow("queries[1].limit must be a finite number");
      const scalarField = await fixture.client.evidenceSearchPort.searchByKeywordField!(
        "workspace-1", "worker", 5
      );
      expect(scalarField.matches).toHaveLength(2);
      expect(scalarField.matches).toEqual(expect.arrayContaining([
        expect.objectContaining({ object_id: fixture.alphaEvidenceId }),
        expect.objectContaining({ object_id: fixture.betaEvidenceId })
      ]));
    } finally {
      await fixture.client.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }, 30_000);
});

async function createFixture(): Promise<Readonly<{
  readonly directory: string;
  readonly alphaEvidenceId: string;
  readonly betaEvidenceId: string;
  readonly client: RecallReadWorkerClient;
}>> {
  const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-evidence-batch-test-"));
  const databasePath = join(directory, "alaya.db");
  const database = initDatabase({ filename: databasePath });
  const repo = new SqliteEvidenceCapsuleRepo(database);
  const alphaEvidenceId = randomUUID();
  const betaEvidenceId = randomUUID();
  try {
    await repo.create(createEvidenceCapsule(
      alphaEvidenceId, "workspace-1", "run-1", "worker shared alphauniquekey"
    ));
    await repo.create(createEvidenceCapsule(
      betaEvidenceId, "workspace-1", "run-2", "worker shared betauniquekey"
    ));
    await repo.create(createEvidenceCapsule(
      randomUUID(), "workspace-2", "run-3", "worker shared alphauniquekey betauniquekey"
    ));
  } finally {
    database.close();
  }
  const client = createRecallReadWorkerClient({
    databaseFilename: databasePath,
    workerUrl: builtWorkerUrl
  });
  if (client === null) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error("file-backed recall worker client is unavailable");
  }
  return { directory, alphaEvidenceId, betaEvidenceId, client };
}

async function loadScalarFields(
  client: RecallReadWorkerClient,
  queries: readonly Readonly<{
    readonly queryText: string;
    readonly limit: number;
    readonly refinement_depths?: readonly number[];
  }>[]
) {
  const batches = [];
  for (const query of queries) {
    batches.push(await client.evidenceSearchPort.searchByKeywordField!(
      "workspace-1", query.queryText, query.limit, query.refinement_depths
    ));
  }
  return batches;
}

function createEvidenceCapsule(
  objectId: string,
  workspaceId: string,
  runId: string,
  text: string
) {
  return {
    object_id: objectId,
    object_kind: "evidence_capsule" as const,
    schema_version: 1,
    lifecycle_state: "active" as const,
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
    created_by: "test",
    evidence_kind: "tool_output" as const,
    semantic_anchor: { topic: "worker", keywords: [], summary: text },
    event_anchor: null,
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: `${workspaceId}-artifact`
    },
    evidence_health_state: "verified" as const,
    gist: text,
    excerpt: `${text} excerpt`,
    source_hash: null,
    run_id: runId,
    workspace_id: workspaceId,
    surface_id: null
  };
}
