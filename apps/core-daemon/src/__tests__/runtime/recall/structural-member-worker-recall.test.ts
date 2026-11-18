import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());

import { createHash } from "node:crypto";
import {
  QUESTION_TIME_PROPOSAL_PRODUCER_ID, SoulMemorySearchResponseSchema, SoulOpenPointerResponseSchema, formatConditionalFieldDigest
} from "@do-soul/alaya-protocol";
import {
  EventPublisher, RecallService, RelationAssertionService, capableRecallConsumerDeclaration,
  compileConditionalFieldQuery, fieldContractSha256, runConditionalFieldRecallWithReceipt
} from "@do-soul/alaya-core";
import {
  SqliteEventLogRepo, SqliteEvidenceCapsuleRepo, SqliteFieldSourceRecordRepo,
  SqliteRelationAssertionRepo, SqliteSourceRootRecallReader, type StorageDatabase
} from "@do-soul/alaya-storage";
import { materializeWorkspaceSessionStructuralRelations } from "../../../runtime/garden-wiring/session-structural-relations.js";
import { collectSoftStructuralNeighbors } from "../../../runtime/recall-read-worker/member-index-neighbors.js";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { CLOCK, WS, withIndexedSources } from "./source-semantic-index-acquisition.test-support.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const PAST = "2020-01-01T00:00:00.000Z";
const TIGHT_BUDGET = {
  schema_version: 1 as const, work_units: 10_000, memory_bytes: 900_000,
  page_budget: 5, finalization_reserve: 100, min_envelope: 10
};

function lanternProposal(query: string) {
  return {
    schema_version: 1 as const,
    original_query_digest: formatConditionalFieldDigest(sha256Hex(query)),
    producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
    evidence_conditions: [{ statement: "User visited <place>.", speaker: "user" as const, anchors: ["Lantern"] }]
  };
}

function createAssertionService(database: StorageDatabase) {
  const eventLogRepo = new SqliteEventLogRepo(database);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runtimeNotifier: { notify: async () => undefined, notifyEntry: async () => undefined },
    runHotStateService: { apply: () => undefined }
  });
  return {
    eventLogRepo,
    assertionService: new RelationAssertionService({
      repo: new SqliteRelationAssertionRepo(database), eventPublisher, eventHistory: eventLogRepo
    })
  };
}

function insertSessionRounds(
  database: StorageDatabase, r0: string, r1: string, t0: string, t1: string
) {
  const insertMsg = database.connection.prepare(
    `INSERT INTO host_session_messages (workspace_id, container_key, message_id, position, container_scope, container_id, role, completeness, fidelity, host_reported_at, content_digest, run_id, producer, admitted_at, pending_body, round_index, round_root_id)
     VALUES (?, 'conv-key', ?, ?, 'session', 'conv', 'user', 'complete', 'original_bytes', ?, ?, 'run-cf', 'test', ?, NULL, ?, ?)`
  );
  insertMsg.run(WS, "msg-0", 0, t0, sha256Hex("r0"), CLOCK, 0, r0);
  insertMsg.run(WS, "msg-1", 1, t1, sha256Hex("r1"), CLOCK, 1, r1);
}

function pageRoots(index: { entries: readonly { target: { kind: string; root_id?: string; object_id?: string } }[] }) {
  return index.entries.map(entry => entry.target.kind === "source_evidence" ? entry.target.root_id : entry.target.object_id);
}

it("hides future-admitted relation kinds from asOf and compiles EPSILON until they are visible", async () => {
  const sources = [
    { id: "host-session:conv:r0", text: "User: We visited Lantern Archive for the rare atlas.", eventTime: "2026-09-10T10:00:00.000Z", vector: [1, 0, 0] },
    { id: "host-session:conv:r1", text: "Assistant: The third vault stays locked overnight.", eventTime: "2026-09-11T10:00:00.000Z", vector: [0, 1, 0] }
  ];
  await withIndexedSources(sources, async (fixture) => {
    const { database } = fixture;
    const r0 = fixture.targets.find(row => row.source_id === sources[0]!.id)!.target.root_id;
    const r1 = fixture.targets.find(row => row.source_id === sources[1]!.id)!.target.root_id;
    insertSessionRounds(database, r0, r1, sources[0]!.eventTime, sources[1]!.eventTime);
    const { assertionService } = createAssertionService(database);
    await materializeWorkspaceSessionStructuralRelations({
      database, assertionService, workspaceId: WS, useSourceRecordedTime: true
    });
    const admitted = database.connection.prepare(
      "SELECT min(admitted_at) AS earliest, max(admitted_at) AS latest FROM relation_assertions WHERE workspace_id = ?"
    ).get(WS) as { readonly earliest: string; readonly latest: string };
    expect(admitted.latest <= "2026-09-11T10:00:00.000Z").toBe(true);
    const readers = createConditionalFieldObserverReaders(database);
    expect(readers.relationKinds!({ workspaceId: WS, subject: null, limit: 32, asOf: "2026-09-10T10:30:00.000Z" })).toEqual([]);
    expect(readers.relationKinds!({ workspaceId: WS, subject: null, limit: 32, asOf: CLOCK })).toEqual([
      "next_round_in_session", "prev_round_in_session"
    ]);
    const recall = (asOf: string) => runConditionalFieldRecallWithReceipt({
      workspace_id: WS, query_text: "Lantern Archive", snapshot_id: fixture.selection.profile_id,
      interpretation_clock: CLOCK, as_of: asOf, expires_at: "2026-09-19T00:00:00.000Z", lifetime_now: CLOCK,
      authorized_scopes: ["project"], result_kind_view: "source_only", interpretation_proposal: lanternProposal("Lantern Archive"),
      budget: TIGHT_BUDGET, readers
    });
    const hidden = recall("2026-09-10T10:30:00.000Z");
    const visible = recall(CLOCK);
    const hiddenKinds = (hidden.execution_receipt.compile_input as { available_relation_kinds?: readonly string[] })
      .available_relation_kinds;
    expect(hiddenKinds === undefined || hiddenKinds.length === 0).toBe(true);
    expect(compileConditionalFieldQuery(hidden.execution_receipt.compile_input as Parameters<typeof compileConditionalFieldQuery>[0]).program.kind)
      .toBe("epsilon");
    expect((visible.execution_receipt.compile_input as { available_relation_kinds?: readonly string[] }).available_relation_kinds)
      .toEqual(["next_round_in_session", "prev_round_in_session"]);
  });
});

it("does not starve mixed or source_only page-1 hydration under dense memory_entries", async () => {
  const sources = [
    { id: "host-session:conv:r0", text: "User: We visited Lantern Archive for the rare atlas.", eventTime: "2026-09-10T10:00:00.000Z", vector: [1, 0, 0] },
    { id: "host-session:conv:r1", text: "Assistant: The third vault stays locked overnight.", eventTime: "2026-09-10T10:01:00.000Z", vector: [0, 1, 0] }
  ];
  await withIndexedSources(sources, async (fixture) => {
    const { database } = fixture;
    const r0 = fixture.targets.find(row => row.source_id === sources[0]!.id)!.target.root_id;
    const r1 = fixture.targets.find(row => row.source_id === sources[1]!.id)!.target.root_id;
    insertSessionRounds(database, r0, r1, sources[0]!.eventTime, sources[1]!.eventTime);
    const { assertionService, eventLogRepo } = createAssertionService(database);
    await materializeWorkspaceSessionStructuralRelations({ database, assertionService, workspaceId: WS, admittedAt: CLOCK });
    const insertMemory = database.connection.prepare(
      `INSERT INTO memory_entries (object_id, lifecycle_state, created_at, updated_at, created_by, dimension, source_kind, formation_kind, scope_class, content, evidence_refs, workspace_id, run_id, valid_from)
       VALUES (?, 'active', ?, ?, 'test', 'observation', 'compiler', 'extracted', 'project', ?, '[]', ?, 'run-1', ?)`
    );
    for (let index = 0; index < 80; index += 1) {
      const objectId = `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`;
      await eventLogRepo.append({
        event_type: "soul.memory.created", entity_type: "memory_entry", entity_id: objectId,
        workspace_id: WS, run_id: "run-1", caused_by: "test", payload_json: { object_id: objectId }
      });
      insertMemory.run(objectId, CLOCK, CLOCK, `Archive note ${index} about the lantern vault.`, WS, CLOCK);
    }
    const readers = createConditionalFieldObserverReaders(database);
    const recall = (view: "mixed" | "source_only", asOf: string) => runConditionalFieldRecallWithReceipt({
      workspace_id: WS, query_text: "Lantern Archive", snapshot_id: fixture.selection.profile_id,
      interpretation_clock: CLOCK, as_of: asOf, expires_at: "2026-09-19T00:00:00.000Z", lifetime_now: CLOCK,
      authorized_scopes: ["project"], result_kind_view: view, interpretation_proposal: lanternProposal("Lantern Archive"),
      budget: TIGHT_BUDGET, readers
    });
    for (const view of ["source_only", "mixed"] as const) {
      const baseline = recall(view, PAST);
      const treated = recall(view, CLOCK);
      expect(treated.index.completeness.payload).not.toBe("omitted");
      expect(treated.index.completeness.transport).not.toBe("interrupted");
      const baselineRoots = pageRoots(baseline.index);
      const treatedRoots = pageRoots(treated.index);
      expect(treatedRoots.length).toBeGreaterThanOrEqual(baselineRoots.length);
      expect(baselineRoots.every(id => treatedRoots.includes(id))).toBe(true);
      for (const entry of treated.index.entries) {
        if (entry.target.kind !== "source_evidence" || entry.target.span === undefined) continue;
        expect(entry.target.span.content_end - entry.target.span.content_start).toBeGreaterThan(17);
      }
    }
  });
});

it("exposes a Soft-grade non-pool graph neighbor in member_index with an openable source_target", async () => {
  const sources = [
    ...Array.from({ length: 32 }, (_, index) => ({
      id: `host-session:conv:r${index}`,
      text: `User: We visited Lantern Archive hall ${index}.`,
      eventTime: `2026-09-10T10:${String(index).padStart(2, "0")}:00.000Z`,
      vector: [1, 0, 0] as const
    })),
    {
      id: "host-session:conv:neighbor",
      text: "User: The third vault stays locked overnight.",
      eventTime: "2026-09-10T11:00:00.000Z",
      vector: [0, 1, 0] as const
    }
  ];
  await withIndexedSources(sources, async (fixture) => {
    const { database } = fixture;
    const neighbor = fixture.targets.find(row => row.source_id === "host-session:conv:neighbor")!.target.root_id;
    const insertMsg = database.connection.prepare(
      `INSERT INTO host_session_messages (workspace_id, container_key, message_id, position, container_scope, container_id, role, completeness, fidelity, host_reported_at, content_digest, run_id, producer, admitted_at, pending_body, round_index, round_root_id)
       VALUES (?, ?, ?, ?, 'session', 'conv', 'user', 'complete', 'original_bytes', ?, ?, 'run-cf', 'test', ?, NULL, ?, ?)`
    );
    for (const target of fixture.targets) {
      if (target.source_id === "host-session:conv:neighbor") continue;
      const lantern = target.target.root_id;
      insertMsg.run(WS, `conv-${lantern}`, `m0-${lantern}`, 0, "2026-09-10T10:00:00.000Z", sha256Hex(lantern), CLOCK, 0, lantern);
      insertMsg.run(WS, `conv-${lantern}`, `m1-${lantern}`, 1, "2026-09-10T11:00:00.000Z", sha256Hex(neighbor), CLOCK, 1, neighbor);
    }
    const { assertionService } = createAssertionService(database);
    const materialized = await materializeWorkspaceSessionStructuralRelations({
      database, assertionService, workspaceId: WS, admittedAt: CLOCK
    });
    expect(materialized.assertionsAdmitted).toBeGreaterThanOrEqual(2);
    const lanternRoots = fixture.targets.filter(row => row.source_id !== "host-session:conv:neighbor").map(row => row.target.root_id);
    expect(collectSoftStructuralNeighbors(database, {
      workspaceId: WS, asOf: CLOCK, authorizedScopes: ["project"], anchors: lanternRoots, exclude: new Set(lanternRoots)
    }).some(source => source.target.root_id === neighbor)).toBe(true);
    const members = { workspaceId: WS, anchors: lanternRoots, exclude: new Set(lanternRoots) };
    expect(collectSoftStructuralNeighbors(database, { ...members, asOf: PAST, authorizedScopes: ["project"] })).toEqual([]);
    expect(collectSoftStructuralNeighbors(database, { ...members, asOf: CLOCK, authorizedScopes: ["global_core"] })).toEqual([]);
    const client = await fixture.openClient();
    const handler = createMcpMemoryToolHandler({
      ...createDeps(), now: () => CLOCK,
      recallService: new RecallService({
        ...createDependencies().dependencies, now: () => CLOCK,
        readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
        activeConstraintsPort: client.activeConstraintsPort
      })
    });
    const output = await handler.call({
      toolName: "soul.recall",
      arguments: {
        ...capableRecallConsumerDeclaration(), query: "Lantern Archive", scope_class: "project",
        dimension: null, domain_tags: null, max_results: 5, result_kind_view: "source_only",
        query_coordinates: { evidence_conditions: [{ statement: "User visited <place>.", speaker: "user", anchors: ["Lantern"] }] }
      },
      context: { workspaceId: WS, runId: null, sessionId: "s-neighbor", agentTarget: "codex" }
    });
    if (!output.ok) throw new Error(JSON.stringify(output.error));
    const recalled = SoulMemorySearchResponseSchema.parse(output.output);
    const delivered = new Set(recalled.results.map(item => item.target.kind === "source_evidence" ? item.target.root_id : ""));
    expect(delivered.has(neighbor)).toBe(false);
    const memberRoots = (recalled.member_index ?? []).map(item => item.root_id);
    const line = (recalled.member_index ?? []).find(item => item.root_id === neighbor);
    if (line === undefined) throw new Error(`neighbor=${neighbor} members=${JSON.stringify(memberRoots)}`);
    expect(line.in_pool).toBe(false);
    const sourceTarget = line.source_target;
    if (sourceTarget === undefined) throw new Error("member_index line missing source_target");
    expect(sourceTarget.root_id).toBe(neighbor);
    const poolLines = (recalled.member_index ?? []).filter(item => item.in_pool);
    const neighborIndex = (recalled.member_index ?? []).findIndex(item => item.root_id === neighbor);
    expect(neighborIndex).toBeGreaterThanOrEqual(poolLines.length);
    const opened = await createMcpMemoryToolHandler({
      ...createDeps(), now: () => CLOCK,
      fieldSource: new SqliteSourceRootRecallReader(
        new SqliteFieldSourceRecordRepo(database, fieldContractSha256),
        new SqliteEvidenceCapsuleRepo(database)
      )
    }).call({
      toolName: "soul.open_pointer", arguments: { source_target: line!.source_target },
      context: { workspaceId: WS, runId: "run-1", sessionId: "s-neighbor", agentTarget: "codex" }
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const parsed = SoulOpenPointerResponseSchema.parse(opened.output);
    expect(parsed.object_kind).toBe("source_evidence");
    expect(parsed.content.content).toContain("third vault");
  });
});
