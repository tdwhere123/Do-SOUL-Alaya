import { describe, expect, it, vi } from "vitest";
import { EvidenceService, RecallService } from "@do-soul/alaya-core";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  CLOCK,
  EVIDENCE_ID,
  MEMORY_ID,
  composeField,
  createPlantedHarness,
  createPlantedRecall,
  memoryEntry,
  persistMemory,
  plantRevoke,
  produceAdaSource,
  readArtifactCount,
  readProjectionPinReleases,
  realMemoryRepo,
  recallRequest
} from "./p217-planted-harness.js";

const planted = createPlantedHarness();

describe("source to recall live path", () => {
  it("continues recall with a verified sealed empty generation", async () => {
    const empty = openEmptyRecall();
    const result = await empty.recall.recall(recallRequest("Ada"));

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics?.field_projection_trace).toMatchObject({
      candidate_keys: []
    });
    expect(readArtifactCount(empty.database)).toBe(1);
    expect(readProjectionPinReleases(empty.database)).toEqual([CLOCK]);
  });

  it("changes final membership when the sealed source factor changes", async () => {
    const treatment = await openRecall("ada");
    const control = await openRecall("grace");

    const treatmentResult = await treatment.recall.recall(recallRequest("Ada"));
    const controlResult = await control.recall.recall(recallRequest("Ada"));

    expect(treatmentResult.candidates.map((candidate) => candidate.object_id))
      .toContain(MEMORY_ID);
    expect(treatmentResult.candidates.find((candidate) => candidate.object_id === MEMORY_ID)
      ?.source_channels).toContain("field_projection");
    assertFieldTrace(treatmentResult);
    expect(controlResult.candidates.map((candidate) => candidate.object_id))
      .not.toContain(MEMORY_ID);
    expect(readArtifactCount(treatment.database)).toBe(1);
    expect(readProjectionPinReleases(treatment.database)).toEqual([CLOCK]);
    expect(readProjectionPinReleases(control.database)).toEqual([CLOCK]);
  });

  it("evaluates evidence health at the query reference time", async () => {
    const runtime = await openRecall("ada");
    await runtime.evidenceService.transitionHealth(
      EVIDENCE_ID, "broken", "test_transition", "system"
    );

    const before = await runtime.recall.recall({
      ...recallRequest("Ada"),
      referenceTime: "2026-08-16T00:00:30.000Z"
    });
    const after = await runtime.recall.recall({
      ...recallRequest("Ada"),
      referenceTime: "2026-08-16T00:02:00.000Z"
    });
    expect(before.candidates.map((candidate) => candidate.object_id)).toContain(MEMORY_ID);
    expect(after.candidates.map((candidate) => candidate.object_id)).not.toContain(MEMORY_ID);
  });

  it("introduces the winner only through field_projection on a real memory repo", async () => {
    const runtime = await openPersistedAdaRecall();
    const lexical = await runtime.memoryRepo.searchByKeyword("workspace-1", "Ada", 10);
    const result = await runtime.recall.recall(recallRequest("Ada", {
      diagnosticCapture: "answer_features"
    }));
    const winner = result.candidates.find((candidate) => candidate.object_id === MEMORY_ID);
    const diagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === MEMORY_ID
    );

    expect(lexical.map((hit) => hit.object_id)).not.toContain(MEMORY_ID);
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([MEMORY_ID]);
    expect(winner?.source_channels).toContain("field_projection");
    expect(diagnostic?.admission_planes).toEqual(["activation"]);
    expect(diagnostic?.plane_first_admitted).toBe("activation");
    expect(diagnostic?.plane_winning_admission).toBe("activation");
    assertFieldTrace(result);
    expect(readProjectionPinReleases(runtime.database)).toEqual([CLOCK]);
  });

  it("drops the winner after a planted revoke effect", async () => {
    const runtime = await openPersistedAdaRecall();
    plantRevoke(runtime.field, EVIDENCE_ID, "2026-08-16T00:01:00.000Z");

    const before = await runtime.recall.recall({
      ...recallRequest("Ada"),
      referenceTime: "2026-08-16T00:00:30.000Z"
    });
    const after = await runtime.recall.recall({
      ...recallRequest("Ada"),
      referenceTime: "2026-08-16T00:02:00.000Z"
    });

    expect(before.candidates.map((candidate) => candidate.object_id)).toEqual([MEMORY_ID]);
    expect(after.candidates.map((candidate) => candidate.object_id)).toEqual([]);
    expect(before.diagnostics?.field_projection_trace?.candidate_keys).toEqual([EVIDENCE_ID]);
    expect(after.diagnostics?.field_projection_trace?.candidate_keys).toEqual([]);
  });
});

function assertFieldTrace(result: Awaited<ReturnType<RecallService["recall"]>>): void {
  const fieldTrace = result.diagnostics?.field_projection_trace;
  expect(fieldTrace?.candidate_keys).toEqual([EVIDENCE_ID]);
  expect(fieldTrace?.candidate_receipts[EVIDENCE_ID]).not.toHaveLength(0);
  expect(fieldTrace?.generation_id).toEqual(expect.any(String));
  expect(fieldTrace?.condition_digest).toEqual(expect.any(String));
  expect(fieldTrace?.activation).toMatchObject({
    generation_id: fieldTrace?.generation_id,
    condition_digest: fieldTrace?.condition_digest,
    opened_candidate_keys: expect.arrayContaining([EVIDENCE_ID])
  });
  expect(Object.hasOwn(fieldTrace ?? {}, "stop")).toBe(false);
}

function openEmptyRecall(): Readonly<{
  recall: RecallService;
  database: StorageDatabase;
}> {
  const database = planted.openMemoryDatabase();
  const field = composeField(database);
  field.projectionLifecycle.rebuild("workspace-1", CLOCK);
  return {
    database,
    recall: createPlantedRecall({
      database,
      field,
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => [])
      }
    })
  };
}

async function openRecall(factorValue: string): Promise<Readonly<{
  recall: RecallService;
  database: StorageDatabase;
  evidenceService: EvidenceService;
}>> {
  const filename = planted.createTempFilename();
  const formationDatabase = planted.openDatabase(filename, { seed: true });
  await produceAdaSource(formationDatabase, composeField(formationDatabase).stores, factorValue);
  planted.close(formationDatabase);
  const database = planted.openDatabase(filename);
  const field = composeField(database);
  const memory = memoryEntry({ content: "Use the Ada source note.", activation_score: 0.8 });
  return {
    database,
    evidenceService: new EvidenceService({
      evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database),
      eventLogRepo: new SqliteEventLogRepo(database),
      runtimeNotifier: { notifyEntry: vi.fn() },
      now: () => "2026-08-16T00:01:00.000Z",
      projectionLifecycle: field.projectionLifecycle
    }),
    recall: createPlantedRecall({
      database,
      field,
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async (_workspaceId, ids) =>
          ids.includes(EVIDENCE_ID) ? [memory] : [])
      }
    })
  };
}

async function openPersistedAdaRecall(): Promise<Readonly<{
  recall: RecallService;
  database: StorageDatabase;
  field: ReturnType<typeof composeField>;
  memoryRepo: ReturnType<typeof realMemoryRepo>;
}>> {
  const filename = planted.createTempFilename();
  const formationDatabase = planted.openDatabase(filename, { seed: true });
  await produceAdaSource(formationDatabase, composeField(formationDatabase).stores, "ada");
  await persistMemory(formationDatabase, memoryEntry());
  planted.close(formationDatabase);
  const database = planted.openDatabase(filename);
  const field = composeField(database);
  const memoryRepo = realMemoryRepo(database);
  return {
    database,
    field,
    memoryRepo,
    recall: createPlantedRecall({ database, field, memoryRepo })
  };
}
