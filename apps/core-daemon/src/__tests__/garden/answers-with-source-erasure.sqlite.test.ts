import { expect, it } from "vitest";
import { createAuditedSourceAdmission, fieldContractSha256, RelationAssertionService } from "@do-soul/alaya-core";
import { initDatabase, SqliteRelationRecallReader, SqliteTemporalPathProjectionReader } from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from "../../runtime/field/field-composition.js";
import { CLOCK, createFaults, createHandoffRuntime, EVIDENCE, IDS, notifier, seedHandoffData, WORKSPACE } from "./embedding-backfill-follow-up-fixture.js";

it("withdraws answers formed through an erased EvidenceCapsule and verifies surviving inputs", async () => {
  const database = initDatabase({ filename: ":memory:" });
  try {
    await seedHandoffData(database);
    const { eventLog, publisher, relationRepo, answersPort } = createHandoffRuntime(database, createFaults());
    const field = createDaemonFieldComposition({ database, eventLogRepo: eventLog });
    const source = await createAuditedSourceAdmission({ stores: field.stores, eventLogRepo: eventLog,
      runtimeNotifier: notifier, sha256: fieldContractSha256 }).admit({
      workspace_id: WORKSPACE, source_id: "hq-source", source_version: "1", content_bytes: "Fixture source evidence.",
      recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null, spans: [], evidence_object_id: EVIDENCE[0]
    }, { workspaceId: WORKSPACE });
    for (const objectIds of [[IDS[0], IDS[1]], [IDS[1], IDS[2]]]) {
      const plan = await answersPort.prepareForBackfill({ workspaceId: WORKSPACE, runId: null, objectIds });
      await plan.execute(() => undefined);
    }
    let now = CLOCK;
    const service = new RelationAssertionService({ repo: relationRepo, eventPublisher: publisher,
      eventHistory: eventLog, now: () => now });
    const projections = new SqliteTemporalPathProjectionReader(relationRepo);
    const bounded = new SqliteRelationRecallReader(database);
    const affected = relationRepo.listAssertionsInCurrentTransaction().find(assertion =>
      assertion.evidence_receipts.some(receipt => receipt.evidence_id === EVIDENCE[0]));
    expect(affected?.evidence_receipts.map(receipt => receipt.evidence_id)).toContain(EVIDENCE[0]);
    await expect(service.verifyAndRebuild()).resolves.toMatchObject({ activeProjectionCount: 2 });
    await expect(projections.findByWorkspace(WORKSPACE, { asOf: CLOCK })).resolves.toHaveLength(2);

    now = "2030-01-02T00:00:00.000Z";
    field.fieldRepos.erase.apply({ workspace_id: WORKSPACE, barrier_id: "erase-hq", generation_id: null,
      subject_kind: "source_record", subject_id: source.record.identity, erased_at: now });
    expect(bounded.read(WORKSPACE, null, "answers_with", 10).observations.map(row => row.evidenceRefs))
      .toEqual([[EVIDENCE[1], EVIDENCE[2]]]);
    await expect(service.refreshProjection()).resolves.toMatchObject({ activeProjectionCount: 1 });
    await expect(projections.findByWorkspace(WORKSPACE)).resolves.toHaveLength(1);
    await expect(service.verifyAndRebuild(CLOCK)).resolves.toMatchObject({ activeProjectionCount: 1 });
    await expect(projections.findByWorkspace(WORKSPACE, { asOf: CLOCK })).resolves.toHaveLength(1);

    database.connection.prepare("UPDATE evidence_capsules SET event_anchor = NULL WHERE object_id = ?").run(EVIDENCE[2]);
    await expect(service.verifyAndRebuild()).rejects.toThrow(/Evidence .* is not anchored/i);
  } finally {
    database.close();
  }
});
