import { stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageError, createSoulMemoryStorage } from "../storage/index.js";

const tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite SOUL Memory storage", () => {
  it("migrates baseline tables and persists memory, recall, audit, session, and portability records", async () => {
    const root = await makeTmpRoot();
    const databasePath = join(root, "soul-memory.db");
    const backupPath = join(root, "backups", "soul-memory.backup.db");
    let tick = 0;
    const storage = createSoulMemoryStorage({
      path: databasePath,
      now: () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`
    });

    expect(storage.health()).toEqual({
      ok: true,
      schemaVersion: 1,
      path: databasePath
    });

    const scope = storage.createScope({
      scopeId: "scope-project",
      plane: "project_local",
      scopeKind: "workspace",
      scopeRef: "/repo",
      metadata: { workspace: "repo" }
    });
    const memory = storage.createMemory({
      memoryId: "mem-strict-workflow",
      plane: "project_local",
      scopeId: scope.scopeId,
      title: "Strict workflow",
      body: "Use rtk and verify before claiming completion.",
      sourceType: "operator",
      sourceRef: "prompt",
      metadata: { tags: ["workflow", "verification"] }
    });
    const globalMemory = storage.createMemory({
      memoryId: "mem-global",
      plane: "global_personal",
      title: "Global preference",
      body: "Prefer evidence-backed answers.",
      sourceType: "operator",
      sourceRef: "profile"
    });

    const evidence = storage.addEvidence({
      evidenceId: "evidence-1",
      memoryId: memory.memoryId,
      sourceType: "prompt",
      sourceRef: "turn-1",
      payload: { quote: "verify before claiming completion" }
    });
    storage.addAuditEvent({
      auditEventId: "audit-1",
      eventType: "memory.created",
      entityType: "memory",
      entityId: memory.memoryId,
      actorRef: "operator",
      payload: { source: evidence.evidenceId }
    });
    storage.createMemoryEdge({
      edgeId: "edge-1",
      fromMemoryId: memory.memoryId,
      toMemoryId: globalMemory.memoryId,
      edgeType: "supports",
      metadata: { reason: "specific project rule follows global preference" }
    });

    const session = storage.startMemorySession({
      sessionId: "session-1",
      agentKind: "codex",
      clientVersion: "standard",
      mode: "attach",
      hostRef: "wsl",
      projectRef: "do-what-new",
      workspaceRef: "/repo"
    });
    const pack = storage.createContextPack({
      contextPackId: "pack-1",
      sessionId: session.sessionId,
      queryText: "How should storage work be verified?",
      taskSummary: "Implement SQLite storage",
      planePolicy: { precedence: ["project_local", "global_personal"] },
      recallPolicyVersion: "prototype-1",
      explanationSummary: "Project storage workflow memory is directly relevant."
    });
    storage.addContextPackEntry({
      entryId: "entry-1",
      contextPackId: pack.contextPackId,
      memoryId: memory.memoryId,
      memoryPlane: "project_local",
      usageRecommendation: "blocking",
      score: 0.9,
      rank: 1,
      reason: "Task requires repo workflow discipline.",
      sourceRefs: [evidence.evidenceId],
      isSensitive: false
    });
    storage.addRecallExclusion({
      exclusionId: "exclusion-1",
      contextPackId: pack.contextPackId,
      memoryId: globalMemory.memoryId,
      sourcePlane: "global_personal",
      reason: "Local project rule is more specific.",
      evidenceId: evidence.evidenceId,
      lifecycleState: "active"
    });
    storage.recordMemoryUsage({
      usageEventId: "usage-1",
      sessionId: session.sessionId,
      contextPackId: pack.contextPackId,
      memoryId: memory.memoryId,
      eventType: "recall_item_delivered",
      proofRef: "pack-1"
    });
    storage.recordMemoryIngest({
      ingestEventId: "ingest-1",
      sessionId: session.sessionId,
      memoryId: memory.memoryId,
      eventType: "memory_accepted",
      outcome: "durable"
    });
    storage.recordViolation({
      violationId: "violation-1",
      sessionId: session.sessionId,
      violationType: "context_pack_not_attached",
      severity: "warning",
      summary: "Synthetic warning for audit coverage."
    });
    const metadata = storage.recordPortabilityMetadata({
      metadataId: "metadata-1",
      operationId: "export-1",
      operationType: "export",
      status: "started",
      itemCounts: { memories: 2 }
    });
    const completedMetadata = storage.finishPortabilityMetadata(metadata.metadataId, {
      status: "completed"
    });
    const backupMetadata = await storage.backupTo(backupPath);
    const finished = storage.finishMemorySession(session.sessionId, {
      contextPackId: pack.contextPackId,
      usageState: "used",
      postRunIngestState: "completed",
      violationSummary: { warning: 1 }
    });

    expect(storage.searchMemories("rtk verify")).toHaveLength(1);
    expect(storage.listMemories({ plane: "project_local" })).toHaveLength(1);
    expect(storage.updateMemory(memory.memoryId, { governanceState: "accepted" }).governanceState).toBe(
      "accepted"
    );
    expect(storage.listEvidence(memory.memoryId)[0]?.payload).toEqual({
      quote: "verify before claiming completion"
    });
    expect(storage.listAuditEvents({ entityId: memory.memoryId })).toHaveLength(1);
    expect(storage.listMemoryEdges(memory.memoryId)).toHaveLength(1);
    expect(storage.getContextPack(pack.contextPackId)).toMatchObject({
      includedCount: 1,
      excludedCount: 1,
      entries: [{ memoryId: memory.memoryId, usageRecommendation: "blocking" }],
      exclusions: [{ memoryId: globalMemory.memoryId, reason: "Local project rule is more specific." }]
    });
    expect(storage.getMemoryUsageEvent("usage-1")?.eventType).toBe("recall_item_delivered");
    expect(storage.getMemoryIngestEvent("ingest-1")?.outcome).toBe("durable");
    expect(storage.listSessionViolations(session.sessionId)).toHaveLength(1);
    expect(completedMetadata.status).toBe("completed");
    expect(backupMetadata.status).toBe("completed");
    expect((await stat(backupPath)).size).toBeGreaterThan(0);
    expect(finished).toMatchObject({
      usageState: "used",
      postRunIngestState: "completed",
      violationSummary: { warning: 1 }
    });

    storage.close();

    const tableNames = readSqliteTableNames(databasePath);
    expect(tableNames).toEqual(
      expect.arrayContaining([
        "storage_migrations",
        "scopes",
        "memories",
        "evidence",
        "audit_events",
        "memory_edges",
        "memory_sessions",
        "context_packs",
        "context_pack_entries",
        "recall_exclusions",
        "memory_usage_events",
        "memory_ingest_events",
        "agent_contract_violations",
        "export_import_metadata"
      ])
    );

    const reopened = createSoulMemoryStorage({ path: databasePath });
    expect(reopened.getMemory(memory.memoryId)?.metadata).toEqual({
      tags: ["workflow", "verification"]
    });
    reopened.close();
  });

  it("fails closed when a stored JSON field is corrupted", async () => {
    const root = await makeTmpRoot();
    const databasePath = join(root, "corrupt-json.db");
    const storage = createSoulMemoryStorage({ path: databasePath });

    storage.createMemory({
      memoryId: "mem-json",
      plane: "global_personal",
      title: "JSON safety",
      body: "Stored JSON fields must parse explicitly.",
      sourceType: "operator",
      sourceRef: "test"
    });
    storage.close();

    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE memories SET metadata_json = ? WHERE memory_id = ?").run("{broken", "mem-json");
    db.close();

    const corrupted = createSoulMemoryStorage({ path: databasePath, migrate: false });
    expect(() => corrupted.getMemory("mem-json")).toThrow(StorageError);
    corrupted.close();
  });
});

async function makeTmpRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "soul-memory-storage-"));
  tmpRoots.push(path);
  return path;
}

function readSqliteTableNames(databasePath: string): readonly string[] {
  const db = new DatabaseSync(databasePath);
  try {
    const rows = db
      .prepare(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC
      `
      )
      .all() as { readonly name: string }[];

    return rows.map((row) => row.name);
  } finally {
    db.close();
  }
}
