import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { EventPublisher, WorkspaceService, fieldContractSha256 } from "@do-soul/alaya-core";
import { createHistoricalMemoryCapture } from "@do-soul/alaya-protocol";
import { SqliteRunRepo, SqliteWorkspaceRepo } from "@do-soul/alaya-storage";
import { registerSynthesisRoutes } from "../../routes/memory/entries/syntheses.js";
import {
  createPreservationFixture,
  EXACT_MEMBER_TEXT,
  PRESERVATION_CLOCK,
  PRESERVATION_WORKSPACE
} from "./independent-preservation.test-support.js";

const WS = PRESERVATION_WORKSPACE;


const fixtures: Awaited<ReturnType<typeof createPreservationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures) await fixture.dispose(); fixtures.length = 0; });
async function fixture() { const value = await createPreservationFixture(); fixtures.push(value); return value; }

describe("independent historical retention through the native forgetting path", () => {
  it("retains exact historical material through deferred sweeps, guarded GC and SQLite reopen", async () => {
    const f = await fixture();
    const { memory } = await f.publishMember("primary-source");
    f.database.connection.prepare(`UPDATE memory_entries SET domain_tags='["history","unicode"]',
      facet_tags='[{"facet":"event_activity","value":"historical exact"}]', canonical_entities='["alpha","中文"]',
      activation_score=0.25,retention_score=0.75,reinforcement_count=3,contradiction_count=2,
      confidence=0.625,decay_profile='stable',storage_tier='warm',manifestation_state='excerpt',
      projection_schema_version=1,time_precision='day',time_source='explicit',event_time_start='2019-12-31T00:00:00.000Z'
      WHERE object_id=?`).run(memory.object_id);
    const capsule = await f.createCapsule([memory.object_id]);
    const before = await f.memoryService.findById(memory.object_id);
    expect(before).toMatchObject({ content: EXACT_MEMBER_TEXT, domain_tags: ["history", "unicode"],
      facet_tags: [{ facet: "event_activity", value: "historical exact" }], canonical_entities: ["alpha", "中文"],
      activation_score: 0.25, retention_score: 0.75, reinforcement_count: 3, contradiction_count: 2,
      confidence: 0.625, decay_profile: "stable", storage_tier: "warm", manifestation_state: "excerpt",
      projection_schema_version: 1, time_precision: "day", time_source: "explicit", event_time_start: "2019-12-31T00:00:00.000Z" });
    expect(EXACT_MEMBER_TEXT.length).toBeGreaterThan(600);
    expect(capsule.summary).not.toContain(EXACT_MEMBER_TEXT);
    f.notifications.length = 0;

    const terminal = await f.sweep();
    expect(terminal.error_message).toBeNull();
    expect(terminal).toMatchObject({ success: true, objects_affected: [memory.object_id] });
    expect(await f.synthesisService.findByIdScoped(capsule.object_id, PRESERVATION_WORKSPACE)).toEqual(capsule);
    expect(await f.synthesisCapsuleRepo.findByWorkspaceId(PRESERVATION_WORKSPACE)).toEqual([capsule]);
    expect((await f.synthesisCapsuleRepo.searchByKeywordField(PRESERVATION_WORKSPACE, "organizing", 10)).matches)
      .toEqual(expect.arrayContaining([expect.objectContaining({ object_id: capsule.object_id })]));
    const retained = await f.synthesisService.readHistoricalMember(PRESERVATION_WORKSPACE, capsule.object_id, memory.object_id);
    expect(retained).toMatchObject({ status: "ready", history: { kind: "historical_memory_capture", member: before } });
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0]).toMatchObject({ committed: true,
      event: { payload_json: { to_state: "tombstone", preservation: { schema_version: 1, capsule_id: capsule.object_id } } } });
    expect(JSON.stringify(f.notifications[0]?.event)).not.toContain(EXACT_MEMBER_TEXT);

    expect(await f.sweep()).toMatchObject({ success: true, outcome: "skipped", objects_affected: [] });
    const deleted = await f.sweep(true);
    expect(deleted.error_message).toBeNull();
    expect(deleted).toMatchObject({ success: true, objects_affected: [memory.object_id] });
    expect(await f.memoryService.findById(memory.object_id)).toBeNull();
    expect(await f.synthesisService.readHistoricalMember(PRESERVATION_WORKSPACE, capsule.object_id, memory.object_id)).toEqual(retained);
    expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_memory_bindings").get()).toEqual({ n: 0 });
    const reopened = f.reopen();
    expect(await reopened.synthesisService.findByIdScoped(capsule.object_id, PRESERVATION_WORKSPACE)).toEqual(capsule);
    expect(await reopened.synthesisService.readHistoricalMember(PRESERVATION_WORKSPACE, capsule.object_id, memory.object_id)).toEqual(retained);
    expect(await reopened.synthesisService.readHistoricalMember("different-workspace", capsule.object_id, memory.object_id))
      .toEqual({ status: "missing" });
  });

  it("adopts multiple members without incrementing or rewriting the capsule revision", async () => {
    const f = await fixture();
    const first = await f.publishMember("source-one", "First exact statement.");
    const second = await f.publishMember("source-two", "Second exact statement.");
    const capsule = await f.createCapsule([first.memory.object_id, second.memory.object_id]);
    const revision = f.database.connection.prepare("SELECT revision FROM preservation_capsule_revisions WHERE capsule_id=?").get(capsule.object_id);

    expect(await f.sweep()).toMatchObject({ success: true,
      objects_affected: expect.arrayContaining([first.memory.object_id, second.memory.object_id]) });
    expect(f.database.connection.prepare("SELECT revision FROM preservation_capsule_revisions WHERE capsule_id=?").get(capsule.object_id)).toEqual(revision);
    for (const published of [first, second]) {
      expect(await f.synthesisService.readHistoricalMember(PRESERVATION_WORKSPACE, capsule.object_id, published.memory.object_id))
        .toMatchObject({ status: "ready", history: { member: { content: published.memory.content } } });
    }
    expect(await f.sweep(true)).toMatchObject({ success: true,
      objects_affected: expect.arrayContaining([first.memory.object_id, second.memory.object_id]) });
    expect(await f.synthesisService.findByIdScoped(capsule.object_id, PRESERVATION_WORKSPACE)).toEqual(capsule);
  });
});

it.each(["missing", "wrong", "throwing"])("cannot commit an unsealed capture with a %s audit callback", async mode => {
  const f = await fixture();
  const { memory } = await f.publishMember("atomic-source");
  const capsule = await f.createCapsule([memory.object_id]);
  const other = await f.createCapsule([memory.object_id]);
  const before = await f.memoryService.findById(memory.object_id);
  const nomination = await f.memoryEntryRepo.readHistoricalCaptureCandidate(PRESERVATION_WORKSPACE, memory.object_id, capsule.object_id);
  if (nomination.status !== "ready") throw new Error("expected a native candidate");
  const capture = createHistoricalMemoryCapture(nomination.candidate, PRESERVATION_CLOCK, fieldContractSha256)!;
  const [wrongEvent] = await f.eventLogRepo.queryByEntityAll("synthesis_capsule", capsule.object_id);
  if (wrongEvent === undefined) throw new Error("expected setup audit");
  const { event_id: ignoredId, created_at: ignoredTime, revision: ignoredRevision, ...wrongInput } = wrongEvent;
  void ignoredId; void ignoredTime; void ignoredRevision;
  const audits = f.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get();
  const options = mode === "missing" ? undefined : { onTransition: () => {
    // The temporary proof must be available to the owning privacy trigger, but never survive this failure.
    expect(f.database.connection.prepare("SELECT audit_event_id FROM historical_memory_captures").get())
      .toEqual({ audit_event_id: null });
    expect(f.database.connection.prepare("SELECT object_id FROM privacy_current_quarantine WHERE object_id=?").get(other.object_id))
      .toEqual({ object_id: other.object_id });
    // A successfully inserted but wrong audit must roll back too, not just the proof rows.
    const inserted = f.eventLogRepo.append(wrongInput);
    if (mode === "throwing") throw new Error("callback interrupted");
    return inserted;
  } };
  // @ts-expect-error runtime boundary deliberately receives a missing/non-synchronous audit callback.
  await expect(f.memoryEntryRepo.autonomousTombstone({ objectId: memory.object_id, disposition: "compressed",
    dispositionRef: capsule.object_id, updatedAt: PRESERVATION_CLOCK, preservation: capture }, options)).rejects.toThrow();
  expect(await f.memoryService.findById(memory.object_id)).toEqual(before);
  for (const table of ["historical_memory_captures", "historical_memory_capture_sources", "privacy_dependency_quarantine"]) {
    expect(f.database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get()).toEqual(audits);
  expect(await f.synthesisCapsuleRepo.findByWorkspaceId(PRESERVATION_WORKSPACE)).toHaveLength(2);
  expect((await f.synthesisCapsuleRepo.searchByKeywordField(PRESERVATION_WORKSPACE, "organizing", 10)).matches).toHaveLength(2);
  expect(await f.synthesisService.findByIdScoped(capsule.object_id, PRESERVATION_WORKSPACE)).toEqual(capsule);
  expect(await f.synthesisService.readHistoricalMember(PRESERVATION_WORKSPACE, capsule.object_id, memory.object_id)).toEqual({ status: "missing" });
  await f.memoryService.autonomousTombstone(memory.object_id, "compressed", capsule.object_id, "retry", "deterministic_rule");
  expect(await f.synthesisService.readHistoricalMember(PRESERVATION_WORKSPACE, capsule.object_id, memory.object_id))
    .toMatchObject({ status: "ready" });
});

it("covers every actual SQLite member column except the five canonical terminal substitutions", async () => {
  const f = await fixture();
  const columns = f.database.connection.prepare("PRAGMA table_info(memory_entries)").all() as { name: string }[];
  const trigger = f.database.connection.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='preservation_member_changed'")
    .get() as { sql: string };
  const substitutions = new Set(["lifecycle_state", "retention_state", "forget_disposition", "forget_disposition_ref", "updated_at"]);
  const compared = new Set([...trigger.sql.matchAll(/NEW\.([a-z_]+)/g)].map(match => match[1]!));
  expect(columns.filter(column => !substitutions.has(column.name)).map(column => column.name).sort())
    .toEqual([...compared].filter(column => !substitutions.has(column)).sort());
  // Column coverage alone is not sufficient: all non-terminal values must compare NEW to OLD.
  for (const { name } of columns.filter(column => !substitutions.has(column.name))) {
    expect(trigger.sql).toContain(`OLD.${name}`);
  }
});

it("defers more than one batch of unsupported oldest tombstones once without starving newer proven GC", async () => {
  const f = await fixture();
  const published = await f.publishMember("eligible-newer", "retained newer material");
  const capsule = await f.createCapsule([published.memory.object_id]);
  const ids: string[] = [];
  for (let i = 0; i < 51; i++) {
    const id = randomUUID(); ids.push(id);
    await f.memoryEntryRepo.create({ ...published.memory, object_id: id, evidence_refs: [],
      lifecycle_state: "tombstone", retention_state: "tombstoned", forget_disposition: "compressed",
      forget_disposition_ref: "legacy-capsule-without-proof", updated_at: "2010-01-01T00:00:00.000Z" });
  }
  await f.sweep();
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_gc_deferrals").get()).toEqual({ n: 0 });
  expect(await f.sweep(true)).toMatchObject({ success: true, objects_affected: [] });
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_gc_deferrals").get()).toEqual({ n: 50 });
  expect(await f.sweep(true)).toMatchObject({ success: true, objects_affected: [published.memory.object_id] });
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_gc_deferrals").get()).toEqual({ n: 51 });
  const audits = () => f.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log WHERE json_extract(payload_json,'$.reason_code') LIKE 'preservation_revoked:%'").get();
  expect(audits()).toEqual({ n: 51 });
  expect(await f.sweep(true)).toMatchObject({ success: true, objects_affected: [] });
  expect(audits()).toEqual({ n: 51 });
  expect(await f.memoryService.autonomousHardDeleteTombstoned(ids[0]!, "direct retry", "deterministic_rule")).toBe(false);
  expect(audits()).toEqual({ n: 51 });
  expect(await f.synthesisService.readHistoricalMember(WS, capsule.object_id, published.memory.object_id)).toMatchObject({ status: "ready" });
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_entries").get()).toEqual({ n: 51 });
  const reopened = f.reopen();
  expect(await reopened.sweep(true)).toMatchObject({ success: true, objects_affected: [] });
  expect(reopened.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_gc_deferrals").get()).toEqual({ n: 51 });
});

it("rolls back a failed deferral audit and reconsiders a legitimately changed revision", async () => {
  const f = await fixture();
  const { memory } = await f.publishMember("deferred-source");
  f.database.connection.prepare("DELETE FROM source_statement_memory_bindings WHERE memory_id=?").run(memory.object_id);
  f.database.connection.prepare("UPDATE memory_entries SET lifecycle_state='tombstone',retention_state='tombstoned',forget_disposition='compressed',forget_disposition_ref='legacy' WHERE object_id=?")
    .run(memory.object_id);
  f.database.connection.exec("CREATE TRIGGER refuse_defer BEFORE INSERT ON memory_gc_deferrals BEGIN SELECT RAISE(ABORT,'deferral unavailable'); END");
  await expect(f.memoryService.autonomousHardDeleteTombstoned(memory.object_id, "GC", "deterministic_rule")).rejects.toThrow();
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log WHERE json_extract(payload_json,'$.reason_code') LIKE 'preservation_revoked:%'").get()).toEqual({ n: 0 });
  f.database.connection.exec("DROP TRIGGER refuse_defer");
  expect(await f.memoryService.autonomousHardDeleteTombstoned(memory.object_id, "GC", "deterministic_rule")).toBe(false);
  f.database.connection.prepare("UPDATE memory_entries SET evidence_refs='[]',reinforcement_count=0,forget_disposition='judged_useless',forget_disposition_ref=NULL WHERE object_id=?")
    .run(memory.object_id);
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_gc_deferrals").get()).toEqual({ n: 0 });
  expect(await f.memoryService.autonomousHardDeleteTombstoned(memory.object_id, "GC", "deterministic_rule")).toBe(true);
});

it("reports unsupported compressed membership as a Janitor skip without falling through to judged-useless", async () => {
  const f = await fixture();
  const { memory } = await f.publishMember("unsupported-member");
  await f.createCapsule([memory.object_id]);
  f.database.connection.prepare("DELETE FROM source_statement_memory_bindings WHERE memory_id=?").run(memory.object_id);
  const result = await f.sweep();
  expect(result).toMatchObject({ success: true, outcome: "skipped", objects_affected: [] });
  expect(await f.memoryService.findById(memory.object_id)).toMatchObject({ lifecycle_state: "dormant", forget_disposition: null });
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM historical_memory_captures").get()).toEqual({ n: 0 });
});

it("serves explicitly historical material over HTTP with workspace containment and irreversible erase", async () => {
  const f = await createPreservationFixture();
  const workspaceRepo = new SqliteWorkspaceRepo(f.database);
  await workspaceRepo.create({ workspace_id: "independent-workspace", name: "Independent", root_path: "/tmp/independent",
    workspace_kind: "local_repo", default_engine_binding: null, workspace_state: "active" });
  const workspaceService = new WorkspaceService({ workspaceRepo, runRepo: new SqliteRunRepo(f.database),
    eventPublisher: new EventPublisher({ eventLogRepo: f.eventLogRepo, runHotStateService: { apply: () => undefined },
      runtimeNotifier: { ...f.notifier, notify: () => undefined } }) });
  const app = new Hono();
  registerSynthesisRoutes(app, { workspaceService, synthesisService: f.synthesisService });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected an HTTP port");
    const base = `http://127.0.0.1:${address.port}`;
    const published = await f.publishMember("http-source");
    const sibling = await f.publishMember("http-independent-sibling", "Independent sibling material only.");
    const capsule = await f.createCapsule([published.memory.object_id, sibling.memory.object_id]);
    const path = (ws: string) => `${base}/workspaces/${ws}/syntheses/${capsule.object_id}/historical-members/${published.memory.object_id}`;
    await f.sweep(); await f.sweep(true);
    expect(await f.memoryService.findById(published.memory.object_id)).toBeNull();
    expect(await f.memoryService.findById(sibling.memory.object_id)).toBeNull();
    const siblingPath = `${base}/workspaces/${WS}/syntheses/${capsule.object_id}/historical-members/${sibling.memory.object_id}`;
    const siblingBefore = await (await fetch(siblingPath)).json();
    expect(siblingBefore).toMatchObject({ data: { status: "ready", history: { member: { content: sibling.memory.content } } } });
    expect(JSON.stringify(siblingBefore)).not.toContain(published.memory.content);
    expect(JSON.stringify(siblingBefore)).not.toContain(capsule.summary);
    const response = await fetch(path(WS));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: "ready", history: {
      kind: "historical_memory_capture", member: { content: published.memory.content, lifecycle_state: "dormant" }
    } } });
    expect(await (await fetch(path("independent-workspace"))).json()).toEqual({ success: true, data: { status: "missing" } });
    f.field.fieldRepos.erase.apply({ barrier_id: "http-erase", workspace_id: WS, generation_id: null,
      subject_kind: "source_record", subject_id: published.source.record.identity, erased_at: "2020-01-03T00:00:00.000Z" });
    expect(await (await fetch(path(WS))).json()).toEqual({ success: true, data: { status: "erased" } });
    expect(await (await fetch(siblingPath)).json()).toEqual(siblingBefore);
    const live = await (await fetch(`${base}/workspaces/${WS}/syntheses/${capsule.object_id}`)).json();
    expect(live).toMatchObject({ data: { summary: "erased", topic_key: "erased", lifecycle_state: "tombstone" } });
    expect(JSON.stringify(live)).not.toContain(published.memory.content);
    const reopened = f.reopen();
    expect(await reopened.synthesisService.readHistoricalMember(WS, capsule.object_id, sibling.memory.object_id))
      .toMatchObject({ status: "ready", history: { member: { content: sibling.memory.content } } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.dispose();
  }
});
