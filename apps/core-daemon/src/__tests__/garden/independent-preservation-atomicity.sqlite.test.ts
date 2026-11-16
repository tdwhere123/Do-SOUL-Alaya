import { afterEach, expect, it } from "vitest";
import { createHistoricalMemoryCapture } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { createPreservationFixture, PRESERVATION_CLOCK, PRESERVATION_WORKSPACE } from "./independent-preservation.test-support.js";

const fixtures: Awaited<ReturnType<typeof createPreservationFixture>>[] = [];
afterEach(async () => { for (const f of fixtures) await f.dispose(); fixtures.length = 0; });
async function fixture() { const f = await createPreservationFixture(); fixtures.push(f); return f; }

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
