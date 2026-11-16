import { afterEach, describe, expect, it } from "vitest";
import { createPreservationFixture, EXACT_MEMBER_TEXT, PRESERVATION_WORKSPACE } from "./independent-preservation.test-support.js";

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
