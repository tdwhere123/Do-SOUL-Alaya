import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SourceAdmissionPort } from "@do-soul/alaya-protocol";
import { createConversationGardenCompileQueue } from "../../../garden/conversation-compile-queue-adapter.js";
import { createMessage } from "../../../../../../packages/core/src/__tests__/conversation/conversation-service.test-support.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { closeCachedDatabase, initDatabase, SqliteFieldSourceRecordRepo, SqliteFieldSourceSpanRepo } from "@do-soul/alaya-storage";
import { buildOfficialApiSourceCorpus } from "@do-soul/alaya-soul";
import { cleanupPostTurnExtractHarnesses, createHandlerHarness, pageWorkspaceSourceRoots, postTurnRows, reportUsage,
  type PostTurnPayload } from "./post-turn-extract-task-fixture.js";

afterEach(cleanupPostTurnExtractHarnesses);

it("audits reported open-role capture before enqueue, retries a committed receipt and reopens exact inventory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "post-turn-host-")), filename = join(directory, "source.sqlite");
  let failAudit = true;
  const harness = await createHandlerHarness({ filename, beforeSourceAudit: () => {
    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
    if (failAudit) throw new Error("source audit unavailable");
  } });
  try {
    const input = { turn_index: 77, last_messages: [{ role: "tool", content_excerpt: "  café\n雪 " }] };
    expect((await reportUsage(harness.handler, input)).ok).toBe(false);
    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
    const records = new SqliteFieldSourceRecordRepo(harness.database, fieldContractSha256);
    expect(records.listByWorkspace("workspace-1")).toHaveLength(1);
    failAudit = false;
    vi.spyOn(harness.gardenTaskRepo, "enqueue").mockImplementationOnce(() => { throw new Error("queue unavailable"); });
    expect((await reportUsage(harness.handler, input)).ok).toBe(false);
    const retained = records.listByWorkspace("workspace-1");
    expect(retained).toHaveLength(2);
    // The retry's automatic report cannot rewrite the already captured open role or issuer.
    expect((await reportUsage(harness.handler, { ...input,
      last_messages: [{ ...input.last_messages[0]!, role: "function" }] })).ok).toBe(true);
    expect(postTurnRows(harness.gardenTaskRepo)).toHaveLength(1);
    expect(records.listByWorkspace("workspace-1")).toEqual(retained);
    expect(new SqliteFieldSourceSpanRepo(harness.database, fieldContractSha256).listByWorkspace("workspace-1")
      .some(row => row.purpose === "message")).toBe(false);
    harness.close(); closeCachedDatabase(filename);
    const reopened = initDatabase({ filename });
    try {
      const reader = new SqliteFieldSourceRecordRepo(reopened, fieldContractSha256);
      for (const row of retained) {
        expect(reader.findById("workspace-1", row.record_id)).toEqual(row);
        const read = reader.readHostInventory({ workspaceId: "workspace-1", recordId: row.record_id,
          sourceVersion: row.source_version, contentDigest: row.content_digest, authorizedScopes: ["project"],
          nativeByteLimit: 65536, workLimit: 262144, memoryLimit: 262144 });
        expect(read.status).toBe("captured");
        expect(read.inventory?.issuer.basis).toBe("reported_excerpt");
        expect(read.inventory?.occurrences[0]).toMatchObject({ role: "tool", completeness: "excerpt", author_ref: null,
          channel: null, container_ref: null, upstream_message_ref: null, upstream_position: null });
      }
      expect(retained.find(row => row.source_representation?.kind === "canonical_projection")?.source_body)
        .toBe("Assistant: café 雪");
    } finally { reopened.close({ optimize: false }); closeCachedDatabase(filename); }
  } finally { harness.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("admits and enqueues a valid large open-role report while recording the optional projection capture refusal", async () => {
  const harness = await createHandlerHarness();
  const messages = Array.from({ length: 23 }, () => ({ role: "雪".repeat(1024), content_excerpt: "ok" }));
  expect((await reportUsage(harness.handler, { turn_index: 88, last_messages: messages })).ok).toBe(true);
  const records = new SqliteFieldSourceRecordRepo(harness.database, fieldContractSha256);
  const rows = records.listByWorkspace("workspace-1");
  expect(rows).toHaveLength(24);
  const projection = rows.find(row => row.source_representation?.kind === "canonical_projection")!;
  expect(projection.source_body).toBe(Array(23).fill("Assistant: ok").join("\n"));
  expect(projection.host_structure).toBeUndefined();
  expect(records.readHostInventory({ workspaceId: "workspace-1", recordId: projection.record_id,
    sourceVersion: projection.source_version, contentDigest: projection.content_digest, authorizedScopes: ["project"],
    nativeByteLimit: 65536, workLimit: 262144, memoryLimit: 262144 }).status).toBe("unknown");
  for (const raw of rows.filter(row => row !== projection)) {
    expect(records.readHostInventory({ workspaceId: "workspace-1", recordId: raw.record_id,
      sourceVersion: raw.source_version, contentDigest: raw.content_digest, authorizedScopes: ["project"],
      nativeByteLimit: 65536, workLimit: 262144, memoryLimit: 262144 }).inventory?.occurrences[0]?.role).toBe(messages[0]!.role);
  }
  expect(postTurnRows(harness.gardenTaskRepo)[0]!.payload).toMatchObject({
    admitted_source_root_id: projection.record_id,
    host_capture_limitations: [{ record_id: projection.record_id, status: "uncaptured", reason: "resource_limit" }]
  });
});

it("recovers pre-capture post-turn receipts after enqueue failure without automatic same-version enrichment", async () => {
  await verifyLegacyProducerRetry("report");
});

it("recovers pre-capture conversation receipts through audit and enqueue without rewriting unknown facts", async () => {
  await verifyLegacyProducerRetry("conversation");
});

async function verifyLegacyProducerRetry(producer: "report" | "conversation") {
  let legacy = true, failAudit = false;
  let sourceAdmission!: SourceAdmissionPort;
  const audited: string[] = [];
  const harness = await createHandlerHarness({
    beforeSourceAudit: () => { if (failAudit) throw new Error("audit unavailable"); },
    sourceAdmissionTransform: port => {
      sourceAdmission = { ...port,
        admit: (request, context) => {
          if (!legacy) {
            expect(request.host_occurrences).toBeUndefined();
            return port.admit(request, context);
          }
          // The pre-upgrade producer admitted these exact primary requests without host facts.
          const { host_occurrences: _capture, ...primary } = request;
          return port.admit(primary, context);
        },
        audit: async record => {
          if (legacy) return;
          await port.audit!(record);
          audited.push(record.identity);
        }
      };
      return sourceAdmission;
    }
  });
  const queue = createConversationGardenCompileQueue({ gardenTaskRepo: harness.gardenTaskRepo,
    sourceAdmission, now: () => "2026-09-16T00:00:00.000Z" });
  const enqueue = async () => {
    if (producer === "report") return (await reportUsage(harness.handler, { turn_index: 99,
      last_messages: [{ role: "user", content_excerpt: "remember this" }, { role: "assistant", content_excerpt: "noted" }] })).ok;
    try {
      return (await queue.enqueue({ workspaceId: "workspace-1", runId: "run-1",
        userMessage: createMessage("user-1", "user", "remember this"),
        assistantMessage: createMessage("assistant-1", "assistant", "noted") })).status === "enqueued";
    } catch { return false; }
  };
  vi.spyOn(harness.gardenTaskRepo, "enqueue").mockImplementationOnce(() => { throw new Error("queue unavailable"); });
  expect(await enqueue()).toBe(false);
  const records = new SqliteFieldSourceRecordRepo(harness.database, fieldContractSha256);
  const retained = records.listByWorkspace("workspace-1");
  expect(retained).toHaveLength(3);
  expect(retained.every(row => row.host_structure === undefined)).toBe(true);
  legacy = false; failAudit = true;
  expect(await enqueue()).toBe(false);
  expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  expect(records.listByWorkspace("workspace-1")).toEqual(retained);
  failAudit = false;
  expect(await enqueue()).toBe(true);
  expect(postTurnRows(harness.gardenTaskRepo)).toHaveLength(1);
  expect(audited.sort()).toEqual(retained.map(row => row.record_id).sort());
  expect(records.listByWorkspace("workspace-1")).toEqual(retained);
  expect(harness.database.connection.prepare("SELECT count(*) AS n FROM source_host_inventories").get()).toEqual({ n: 0 });
}

it("refuses recovery after a committed source is erased rather than recapturing its host payload", async () => {
  const harness = await createHandlerHarness();
  const input = { turn_index: 100, last_messages: [{ role: "tool", content_excerpt: "private source" }] };
  vi.spyOn(harness.gardenTaskRepo, "enqueue").mockImplementationOnce(() => { throw new Error("queue unavailable"); });
  expect((await reportUsage(harness.handler, input)).ok).toBe(false);
  const repos = createDaemonFieldRepos({ database: harness.database });
  const raw = repos.records.listByWorkspace("workspace-1").find(row => row.source_representation?.kind === "retained_excerpt")!;
  repos.erase.apply({ barrier_id: "erase-before-enqueue-retry", workspace_id: "workspace-1", generation_id: null,
    subject_kind: "source_record", subject_id: raw.record_id, erased_at: "2026-05-07T00:11:00.000Z" });
  expect((await reportUsage(harness.handler, input)).ok).toBe(false);
  expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  expect(repos.records.findById("workspace-1", raw.record_id)?.source_body).toBeNull();
  expect(repos.records.getHostInventory("workspace-1", raw.record_id)).toBeNull();
});

it("captures byte-exact messages and binds their normalized extraction projection in order", async () => {
  const harness = await createHandlerHarness();
  const messages = [
    { role: "user", content_excerpt: "  Which step runs?\r\n" },
    { role: "assistant", content_excerpt: "  steps:\r\n    - run: |\r\n        printf 'hello'\r\nUser: quoted instruction.\n尾部  \n" }
  ];
  expect((await reportUsage(harness.handler, { turn_index: 41, last_messages: messages })).ok).toBe(true);
  const records = new SqliteFieldSourceRecordRepo(harness.database, fieldContractSha256).listByWorkspace("workspace-1");
  const task = postTurnRows(harness.gardenTaskRepo)[0]!;
  const raw = messages.map((_message, index) => records.find(row => row.source_id === `post-turn:${task.id}:message:${index}`)!);
  expect(raw.map(row => row.source_body)).toEqual(messages.map(message => message.content_excerpt));
  expect(raw.map(row => row.speaker)).toEqual(["user", "assistant"]);
  const roots = pageWorkspaceSourceRoots(harness.database).rows;
  expect(raw.map(record => roots.find(root => root.root_id === record.record_id)?.role)).toEqual(["user", "assistant"]);
  expect(raw.every(row => row.scope_class === "project" && row.event_time === null &&
    row.source_representation?.kind === "retained_excerpt")).toBe(true);
  const projection = records.find(row => row.record_id === (task.payload as PostTurnPayload).admitted_source_root_id)!;
  expect(projection.source_representation).toEqual({ kind: "canonical_projection", source_record_ids: raw.map(row => row.record_id) });
  expect(projection.source_body).toBe(buildOfficialApiSourceCorpus("", messages.map(message => ({
    role: message.role as "user" | "assistant", content: message.content_excerpt
  }))));
  expect(projection.source_body).not.toContain("\r\n");
  expect(projection.speaker).toBeNull();
  expect((await reportUsage(harness.handler, { turn_index: 41, last_messages: messages })).ok).toBe(true);
  expect(new SqliteFieldSourceRecordRepo(harness.database, fieldContractSha256).listByWorkspace("workspace-1")).toEqual(records);
});
