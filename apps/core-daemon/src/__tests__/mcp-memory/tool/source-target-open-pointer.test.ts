import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import {
  SoulOpenPointerResponseSchema,
  UNKNOWN_UTTERANCE_ATTRIBUTION,
  hashContentDigest,
  hashLabeledIdentity,
  hashSourceRecordId
} from "@do-soul/alaya-protocol";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteFieldEraseBarrierRepo,
  SqliteFieldSourceRecordRepo,
  SqliteSourceRootRecallReader,
  initDatabase,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "./mcp-memory-tool-handler-fixture.js";

const WORKSPACE_A = "ws-source-open-a";
const WORKSPACE_B = "ws-source-open-b";
const CLOCK = "2026-09-10T00:00:00.000Z";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), "alaya-open-source-target-"));
  const db: StorageDatabase = initDatabase({ filename: join(dir, "alaya.db") });
  cleanups.push(() => {
    db.close({ optimize: false });
    rmSync(dir, { recursive: true, force: true });
  });
  for (const ws of [WORKSPACE_A, WORKSPACE_B]) {
    db.connection
      .prepare(
        `INSERT INTO workspaces (workspace_id, name, root_path, workspace_kind, default_engine_binding, workspace_state, created_at, archived_at, default_engine_class)
         VALUES (?, ?, ?, 'local', 'native', 'active', ?, NULL, 'coding_engine')`
      )
      .run(ws, ws, dir, CLOCK);
  }
  const records = new SqliteFieldSourceRecordRepo(db, fieldContractSha256);
  const capsules = new SqliteEvidenceCapsuleRepo(db);
  const erase = new SqliteFieldEraseBarrierRepo(db, fieldContractSha256);
  const fieldSource = new SqliteSourceRootRecallReader(records, capsules);
  const handler = createMcpMemoryToolHandler({
    ...createDeps(),
    now: () => CLOCK,
    fieldSource
  });
  return { db, records, erase, handler };
}

function insertSourceRecord(
  records: SqliteFieldSourceRecordRepo,
  workspaceId: string,
  sourceId: string,
  version: string,
  recordedAt: string,
  body: string
) {
  const digest = hashContentDigest(body, fieldContractSha256);
  return records.insert({
    record_id: hashSourceRecordId({
      source_id: sourceId,
      source_version: version,
      content_digest: digest
    }, fieldContractSha256),
    workspace_id: workspaceId,
    source_id: sourceId,
    source_version: version,
    content_digest: digest,
    evidence_object_id: null,
    recorded_at: recordedAt,
    event_time: recordedAt,
    valid_from: recordedAt,
    valid_to: null,
    operator_id: "op-1",
    speaker: "user",
    scope_class: "project",
    attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    source_body: body
  });
}

describe("soul.open_pointer source_target boundary", () => {
  it("supports bounded UTF-8 continuation across chunks without minting an object_id", async () => {
    const { records, handler } = setupDb();
    const longBody = "😀".repeat(2500);
    const record = insertSourceRecord(records, WORKSPACE_A, "sess-long", "v1", CLOCK, longBody);
    const target = {
      root_kind: "source_record" as const,
      root_id: record.record_id,
      source_version: record.source_version,
      content_digest: record.content_digest,
      evidence_object_id: null
    };
    const ctx = { workspaceId: WORKSPACE_A, runId: "run-1", agentTarget: "codex", sessionId: "s-1" };

    const first = await handler.call({
      toolName: "soul.open_pointer",
      arguments: { source_target: target, start_offset: 0, byte_budget: 2048 },
      context: ctx
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstParsed = SoulOpenPointerResponseSchema.parse(first.output);
    expect(firstParsed.object_id).toBeUndefined();
    expect(Buffer.byteLength(firstParsed.content.content ?? "", "utf8")).toBeLessThanOrEqual(2048);
    expect(firstParsed.content.span?.content_complete).toBe(false);

    const nextOffset = firstParsed.content.span!.content_end;
    const second = await handler.call({
      toolName: "soul.open_pointer",
      arguments: { source_target: target, start_offset: nextOffset, byte_budget: 65536 },
      context: ctx
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondParsed = SoulOpenPointerResponseSchema.parse(second.output);
    expect(secondParsed.content.span?.content_start).toBe(nextOffset);
    expect(secondParsed.content.span?.content_end).toBeGreaterThan(nextOffset);
  });

  it("denies foreign-workspace reads, rejects caller workspace_id, refuses non-current and erased roots", async () => {
    const { records, erase, handler } = setupDb();
    const oldRecord = insertSourceRecord(records, WORKSPACE_A, "sess-rev", "v1", "2026-09-01T00:00:00.000Z", "old body");
    const currentRecord = insertSourceRecord(records, WORKSPACE_A, "sess-rev", "v2", CLOCK, "current body");

    const oldTarget = {
      root_kind: "source_record" as const,
      root_id: oldRecord.record_id,
      source_version: oldRecord.source_version,
      content_digest: oldRecord.content_digest,
      evidence_object_id: null
    };
    const currentTarget = {
      root_kind: "source_record" as const,
      root_id: currentRecord.record_id,
      source_version: currentRecord.source_version,
      content_digest: currentRecord.content_digest,
      evidence_object_id: null
    };

    const foreignDenied = await handler.call({
      toolName: "soul.open_pointer",
      arguments: { source_target: currentTarget },
      context: { workspaceId: WORKSPACE_B, runId: "run-b", agentTarget: "codex", sessionId: "s-b" }
    });
    expect(foreignDenied).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    const spoofRejected = await handler.call({
      toolName: "soul.open_pointer",
      arguments: { source_target: { ...currentTarget, workspace_id: WORKSPACE_A } },
      context: { workspaceId: WORKSPACE_B, runId: "run-b", agentTarget: "codex", sessionId: "s-b" }
    });
    expect(spoofRejected).toMatchObject({ ok: false, error: { code: "VALIDATION" } });

    const ctxA = { workspaceId: WORKSPACE_A, runId: "run-a", agentTarget: "codex", sessionId: "s-a" };
    const staleDenied = await handler.call({
      toolName: "soul.open_pointer",
      arguments: { source_target: oldTarget },
      context: ctxA
    });
    expect(staleDenied).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

    const digestMismatch = await handler.call({
      toolName: "soul.open_pointer",
      arguments: { source_target: { ...currentTarget, content_digest: `sha256:${"0".repeat(64)}` } },
      context: ctxA
    });
    expect(digestMismatch).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

    erase.apply({
      identity: hashLabeledIdentity("erase_barrier", [WORKSPACE_A, "source_record", currentRecord.record_id, ""], fieldContractSha256),
      barrier_id: "erase-source-target-test",
      workspace_id: WORKSPACE_A,
      generation_id: null,
      subject_kind: "source_record",
      subject_id: currentRecord.record_id,
      erased_at: CLOCK
    });
    const postErase = await handler.call({
      toolName: "soul.open_pointer",
      arguments: { source_target: currentTarget },
      context: ctxA
    });
    expect(postErase).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });
});
