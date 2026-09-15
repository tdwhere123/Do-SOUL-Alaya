import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoundSourceInterpretationSchema,
  CandidateMemorySignalSchema,
  SOURCE_INTERPRETATION_CONTRACT,
  locateSourceInterpretation,
  type SourceLocatedInterpretation
} from "@do-soul/alaya-protocol";
import {
  SqliteEventLogRepo,
  SqliteKarmaEventRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { DynamicsService } from "../../../dynamics/dynamics-service.js";
import { EvidenceService } from "../../../memory/evidence-service.js";
import { MemoryService } from "../../../memory/memory-service.js";
import { createAuditedSourceAdmission } from "../../../memory/evidence-create/audited-source-admission.js";
import { createInMemoryFieldStores } from "../../../memory/evidence-create/field-stores.js";
import { createSourceObservationPublication } from "../../../memory/evidence-create/source-observation-publication.js";
import { deriveAddressableSpanViews } from "../../../memory/evidence-create/source-span-views.js";
import { CoreError } from "../../../shared/errors.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { evaluateSignalTriage } from "../../../memory/signal-service-helpers.js";
import {
  REAL_SQLITE_TEST_RUN_ID,
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createRecallRealStorage
} from "../../shared/real-sqlite.test-support.js";

const CLOCK = "2026-09-14T00:00:00.000Z";
const ASSERTION = "Alice uses tools.";
const SOURCE = `User: ${ASSERTION}`;
const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

async function openFixture(filename = ":memory:") {
  const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRecallRealStorage(
    (db) => databases.add(db),
    filename
  );
  const eventLogRepo = new SqliteEventLogRepo(database);
  const stores = createInMemoryFieldStores();
  const notify = { notifyEntry: vi.fn(async () => undefined) };
  const sourceAdmission = createAuditedSourceAdmission({
    stores, eventLogRepo, sha256: fieldContractSha256
  });
  const evidenceService = new EvidenceService({
    evidenceCapsuleRepo, eventLogRepo, runtimeNotifier: notify
  });
  const memoryService = new MemoryService({
    memoryEntryRepo, eventLogRepo, evidenceService, runtimeNotifier: notify,
    dynamicsService: new DynamicsService({
      memoryRepo: memoryEntryRepo,
      karmaEventRepo: new SqliteKarmaEventRepo(database),
      eventLogRepo, runtimeNotifier: notify
    })
  });
  return {
    database, stores, sourceAdmission, evidenceService, memoryService, notify, memoryEntryRepo,
    evidenceCapsuleRepo, eventLogRepo,
    publication: createSourceObservationPublication({
      stores, sourceAdmission, evidenceService, memoryService, sha256: fieldContractSha256
    })
  };
}

async function admitSource(
  fixture: Awaited<ReturnType<typeof openFixture>>,
  content = SOURCE,
  sourceVersion = "1",
  recordedAt = CLOCK
) {
  return await fixture.sourceAdmission.admit({
    workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
    source_id: "artifact-1",
    source_version: sourceVersion,
    content_bytes: content,
    evidence_object_id: null,
    recorded_at: recordedAt,
    event_time: null,
    valid_from: null,
    valid_to: null,
    speaker: "user",
    scope_class: "project",
    spans: deriveAddressableSpanViews(content)
  }, { workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID });
}

function locatedInterpretation(
  response: Parameters<typeof locateSourceInterpretation>[0]["response"] = {
    kind: "received",
    value: { interpretations: [{ assertion_id: 1, relations: [{
      predicate: { text: "uses" },
      arguments: [
        { role: "agent", phrase: { text: "Alice" } },
        { role: "object", phrase: { text: "tools" } }
      ],
      qualifiers: []
    }] }] }
  },
  source = SOURCE,
  assertion = ASSERTION
): SourceLocatedInterpretation {
  return locateSourceInterpretation({
    source, artifactKey: "artifact-1", sha256: fieldContractSha256,
    assertion: { assertion_id: 1, text: assertion, source_span: [source.indexOf(assertion), source.indexOf(assertion) + assertion.length] },
    response
  });
}

function observationSignal(located: SourceLocatedInterpretation, overrides: Record<string, unknown> = {}) {
  const { raw_payload, ...rest } = overrides;
  return CandidateMemorySignalSchema.parse({
    signal_id: "signal-1",
    workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
    run_id: REAL_SQLITE_TEST_RUN_ID,
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_semantic_observation",
    interpretation_contract: SOURCE_INTERPRETATION_CONTRACT,
    object_kind: null,
    confidence: null,
    scope_hint: "project",
    domain_tags: [],
    evidence_refs: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: { source_interpretation: located, ...(raw_payload as object ?? {}) },
    source_observation: {
      observed_at: CLOCK, authority: "trusted_host_event", source_event_id: "event-1"
    },
    created_at: CLOCK,
    ...rest
  });
}

describe("source observation publication", () => {
  it("accepts interpretation signals without using the scored kind/confidence route", () => {
    const signal = observationSignal(locatedInterpretation());
    expect(evaluateSignalTriage(signal)).toBe("accepted");
    expect(signal.confidence).toBeNull();
    expect(signal.object_kind).toBeNull();
  });

  it("publishes a source-bound observation, reopens the same identity, and keeps confidence unknown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-source-observation-"));
    const filename = join(directory, "memory.sqlite");
    const fixture = await openFixture(filename);
    await admitSource(fixture);
    const located = locatedInterpretation();
    const published = await fixture.publication.publish({
      signal: observationSignal(located),
      sourceEventAnchor: {
        event_type: "soul.signal.emitted", event_id: "emit-1", occurred_at: CLOCK
      }
    });
    expect(published.memory.dimension).toBe("observation");
    expect(published.memory.confidence).toBeNull();
    expect(published.memory.content).toBe(ASSERTION);
    expect(published.bound.source_target.root_kind).toBe("source_record");
    expect(published.bound.source_target.evidence_object_id).toBe(published.evidence.object_id);
    expect(published.bound.candidates[0]?.scope_status).toBe("unsupported");
    expect(published.bound.candidates[0]?.arguments[0]?.phrase.lookup_key).toBe("alice");
    expect(published.evidence.evidence_health_state).toBe("questionable");
    expect(published.evidence.excerpt).toBe(ASSERTION);
    expect(BoundSourceInterpretationSchema.parse(JSON.parse(published.evidence.gist)).assertion_binding.context_id)
      .toBe(located.assertion_binding.context_id);
    expect(fixture.notify.notifyEntry).toHaveBeenCalled();
    const memoryId = published.memory.object_id;
    const evidenceId = published.evidence.object_id;
    fixture.database.close();
    databases.delete(fixture.database);

    const reopened = await openFixture(filename);
    const memory = await reopened.memoryService.findById(memoryId);
    const evidence = await reopened.evidenceService.findById(evidenceId);
    expect(memory).toMatchObject({
      object_id: memoryId, dimension: "observation", confidence: null, content: ASSERTION
    });
    expect(evidence?.object_id).toBe(evidenceId);
    const rebound = BoundSourceInterpretationSchema.parse(JSON.parse(evidence!.gist));
    expect(rebound.assertion_binding.context_id).toBe(located.assertion_binding.context_id);
    expect(rebound.source_target.root_id).toBe(published.bound.source_target.root_id);
    expect(rebound.source_target.evidence_object_id).toBe(evidenceId);
  });

  it("converts UTF-16 locators to UTF-8 durable spans", async () => {
    const source = "A café sent mail.";
    const fixture = await openFixture();
    await admitSource(fixture, source);
    const located = locatedInterpretation({
      kind: "received",
      value: { interpretations: [{ assertion_id: 1, relations: [{
        predicate: { text: "sent" }, arguments: [], qualifiers: []
      }] }] }
    }, source, source);
    const published = await fixture.publication.publish({
      signal: observationSignal(located), sourceEventAnchor: null
    });
    expect(published.bound.source_target.span).toEqual({
      content_start: 0,
      content_end: Buffer.byteLength(source, "utf8"),
      retained_extent: "body",
      content_complete: true,
      original_complete: true
    });
    expect(published.bound.source_target.span?.content_end).toBe(source.length + 1);
    expect(published.bound.assertion_binding.source_span).toEqual([
      0, Buffer.byteLength(source, "utf8")
    ]);
    const sentAt = Buffer.byteLength(source.slice(0, source.indexOf("sent")), "utf8");
    expect(published.bound.candidates[0]?.predicate.source_span).toEqual([
      sentAt, sentAt + Buffer.byteLength("sent", "utf8")
    ]);
  });

  it("publishes empty and failed interpretations without minting a certified graph", async () => {
    const fixture = await openFixture();
    await admitSource(fixture);
    const empty = await fixture.publication.publish({
      signal: observationSignal(locatedInterpretation({
        kind: "received", value: { interpretations: [{ assertion_id: 1, relations: [] }] }
      })),
      sourceEventAnchor: null
    });
    expect(empty.bound.outcome).toBe("empty");
    expect(empty.bound.candidates).toEqual([]);
    expect(empty.memory.dimension).toBe("observation");
    const failed = await fixture.publication.publish({
      signal: observationSignal(locatedInterpretation({
        kind: "unavailable", reason: "missing_response"
      }), { signal_id: "signal-failed" }),
      sourceEventAnchor: null
    });
    expect(failed.bound.outcome).toBe("failed");
    expect(failed.bound.diagnostics[0]?.reason).toBe("missing_response");
    expect(failed.memory.object_id).not.toBe(empty.memory.object_id);
  });

  it("rejects wrong root, revision, digest, span, and scope at the shared owner", async () => {
    const fixture = await openFixture();
    await admitSource(fixture);
    const located = locatedInterpretation();
    await expect(fixture.publication.publish({
      signal: observationSignal(located, { scope_hint: "global_core" }),
      sourceEventAnchor: null
    })).rejects.toThrow(/scope is not current/);
    await expect(fixture.publication.publish({
      signal: observationSignal(located, { scope_hint: "not-a-scope" }),
      sourceEventAnchor: null
    })).rejects.toThrow(/unknown scope_hint/);
    await expect(fixture.publication.publish({
      signal: observationSignal({
        ...located,
        assertion_binding: { ...located.assertion_binding, text: "not the source text" }
      }),
      sourceEventAnchor: null
    })).rejects.toThrow(/assertion binding does not match/);
    const mismatchedPhrase = {
      ...located,
      candidates: located.candidates.map((candidate, index) => index === 0
        ? { ...candidate, predicate: { ...candidate.predicate, text: "used" } }
        : candidate)
    };
    await expect(fixture.publication.publish({
      signal: observationSignal(mismatchedPhrase), sourceEventAnchor: null
    })).rejects.toThrow(/candidate phrase does not match/);
    const mismatchedKey = {
      ...located,
      candidates: located.candidates.map((candidate, index) => index === 0
        ? {
          ...candidate,
          predicate: { ...candidate.predicate, lookup_key: "not-the-source-key" }
        }
        : candidate)
    };
    await expect(fixture.publication.publish({
      signal: observationSignal(mismatchedKey), sourceEventAnchor: null
    })).rejects.toThrow(/lookup_key does not match/);
    expectNoPublishedObservation(fixture.database);
    await expect(fixture.publication.publish({
      signal: observationSignal(located, { workspace_id: "workspace-other" }),
      sourceEventAnchor: null
    })).rejects.toThrow(/not currently admitted|workspace/);
    await admitSource(fixture, "User: Alice uses apps.", "2", "2026-09-15T00:00:00.000Z");
    await expect(fixture.publication.publish({
      signal: observationSignal(located), sourceEventAnchor: null
    })).rejects.toThrow(/digest is not current/);
    expectNoPublishedObservation(fixture.database);
    const other = await openFixture();
    await other.sourceAdmission.admit({
      workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
      source_id: "artifact-other",
      source_version: "1",
      content_bytes: SOURCE,
      evidence_object_id: null,
      recorded_at: CLOCK,
      event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project",
      spans: deriveAddressableSpanViews(SOURCE)
    }, { workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID });
    await expect(other.publication.publish({
      signal: observationSignal(located), sourceEventAnchor: null
    })).rejects.toThrow(/not currently admitted/);
    expectNoPublishedObservation(other.database);
  });

  it("ignores model confidence, policy labels, and participant guesses", async () => {
    const fixture = await openFixture();
    await admitSource(fixture);
    const located = locatedInterpretation();
    expect(CandidateMemorySignalSchema.safeParse({
      ...observationSignal(located), confidence: 1
    }).success).toBe(false);
    const published = await fixture.publication.publish({
      signal: observationSignal(located, {
        raw_payload: { policy: "admin", confidence: 0.99, participant: "false-agent" }
      }),
      sourceEventAnchor: null
    });
    expect(published.memory.dimension).toBe("observation");
    expect(published.memory.confidence).toBeNull();
    expect(published.bound.candidates[0]?.scope_status).toBe("unsupported");
    expect(published.bound).not.toHaveProperty("policy");
  });

  it("replays duplicate publication with the same identity and recovers an interrupted memory write", async () => {
    const base = await openFixture();
    await admitSource(base);
    const located = locatedInterpretation();
    const signal = observationSignal(located);
    const first = await base.publication.publish({ signal, sourceEventAnchor: null });
    const again = await base.publication.publish({ signal, sourceEventAnchor: null });
    expect(again.memory.object_id).toBe(first.memory.object_id);
    expect(again.evidence.object_id).toBe(first.evidence.object_id);

    const interrupted = await openFixture();
    await admitSource(interrupted);
    const create = interrupted.memoryService.create.bind(interrupted.memoryService);
    let fail = true;
    const publication = createSourceObservationPublication({
      stores: interrupted.stores,
      sourceAdmission: interrupted.sourceAdmission,
      evidenceService: interrupted.evidenceService,
      memoryService: {
        create: async (input) => {
          if (fail) {
            fail = false;
            throw new Error("memory write interrupted");
          }
          return await create(input);
        },
        findByIdScoped: interrupted.memoryService.findByIdScoped.bind(interrupted.memoryService)
      },
      sha256: fieldContractSha256
    });
    const retrySignal = observationSignal(located, { signal_id: "signal-retry" });
    const interruptedError = await publication.publish({
      signal: retrySignal, sourceEventAnchor: null
    }).then(() => null, (error: unknown) => error);
    expect(interruptedError).toBeInstanceOf(CoreError);
    expect((interruptedError as CoreError).code).toBe("CONFLICT");
    expect((interruptedError as CoreError).message).toMatch(/interrupted after evidence creation/);
    const capsules = await interrupted.evidenceService.findByWorkspaceId(REAL_SQLITE_TEST_WORKSPACE_ID);
    expect(capsules).toHaveLength(1);
    expect((interruptedError as CoreError).details).toEqual({
      evidence_object_id: capsules[0]!.object_id
    });
    expect(await interrupted.memoryService.findByDimensionAll(REAL_SQLITE_TEST_WORKSPACE_ID, "observation")).toEqual([]);
    const recovered = await publication.publish({ signal: retrySignal, sourceEventAnchor: null });
    expect(recovered.evidence.object_id).toBe(capsules[0]!.object_id);
    expect(recovered.memory.dimension).toBe("observation");
    expect(await interrupted.evidenceService.findByWorkspaceId(REAL_SQLITE_TEST_WORKSPACE_ID)).toHaveLength(1);
  });

  it("reserves one identity for concurrent overlapping publish and after dormancy", async () => {
    const fixture = await openFixture();
    await admitSource(fixture);
    const located = locatedInterpretation();
    const [first, second] = await Promise.all([
      fixture.publication.publish({
        signal: observationSignal(located, { signal_id: "signal-a" }), sourceEventAnchor: null
      }),
      fixture.publication.publish({
        signal: observationSignal(located, { signal_id: "signal-b" }), sourceEventAnchor: null
      })
    ]);
    expect(second.memory.object_id).toBe(first.memory.object_id);
    expect(second.evidence.object_id).toBe(first.evidence.object_id);
    expect(countRows(fixture.database, "SELECT COUNT(*) AS n FROM memory_entries WHERE dimension = 'observation'")).toBe(1);
    expect(countRows(fixture.database, "SELECT COUNT(*) AS n FROM evidence_capsules")).toBe(1);
    fixture.database.connection.prepare(
      "UPDATE memory_entries SET lifecycle_state = 'dormant', storage_tier = 'cold' WHERE object_id = ?"
    ).run(first.memory.object_id);
    expect(await fixture.memoryService.findByDimensionAll(REAL_SQLITE_TEST_WORKSPACE_ID, "observation")).toEqual([]);
    const afterDormant = await fixture.publication.publish({
      signal: observationSignal(located, { signal_id: "signal-dormant" }), sourceEventAnchor: null
    });
    expect(afterDormant.memory.object_id).toBe(first.memory.object_id);
    expect(afterDormant.evidence.object_id).toBe(first.evidence.object_id);
    expect(countRows(fixture.database, "SELECT COUNT(*) AS n FROM memory_entries WHERE dimension = 'observation'")).toBe(1);
  });

  it("does not extra-audit source admission on duplicate publish", async () => {
    const fixture = await openFixture();
    await admitSource(fixture);
    const located = locatedInterpretation();
    await fixture.publication.publish({
      signal: observationSignal(located), sourceEventAnchor: null
    });
    const afterFirst = countRows(
      fixture.database,
      "SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'soul.field.source_record.admitted'"
    );
    await fixture.publication.publish({
      signal: observationSignal(located, { signal_id: "signal-dup" }), sourceEventAnchor: null
    });
    expect(countRows(
      fixture.database,
      "SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'soul.field.source_record.admitted'"
    )).toBe(afterFirst);
  });

  it("rejects a withdrawn newer revision instead of resurrecting an older body", async () => {
    const fixture = await openFixture();
    await admitSource(fixture);
    const withdrawn = await admitSource(
      fixture, "User: Alice uses apps.", "2", "2026-09-15T00:00:00.000Z"
    );
    const stores = {
      ...fixture.stores,
      getStoredRecord: (workspaceId: string, recordId: string) =>
        recordId === withdrawn.record.identity
          ? null
          : fixture.stores.getStoredRecord(workspaceId, recordId),
      listStoredRecords: (workspaceId: string) => fixture.stores.listStoredRecords(workspaceId)
        .filter((row) => row.record.identity !== withdrawn.record.identity)
    };
    const publication = createSourceObservationPublication({
      stores,
      sourceAdmission: fixture.sourceAdmission,
      evidenceService: fixture.evidenceService,
      memoryService: fixture.memoryService,
      sha256: fieldContractSha256
    });
    await expect(publication.publish({
      signal: observationSignal(locatedInterpretation()), sourceEventAnchor: null
    })).rejects.toThrow(/current source body is not available/);
    expectNoPublishedObservation(fixture.database);
  });

  it("rejects observation confidence mutation at the memory update owner", async () => {
    const fixture = await openFixture();
    await admitSource(fixture);
    const published = await fixture.publication.publish({
      signal: observationSignal(locatedInterpretation()), sourceEventAnchor: null
    });
    await expect(fixture.memoryService.update(
      published.memory.object_id, { confidence: 0.9 }, "model score"
    )).rejects.toThrow(/observation confidence cannot be mutated/);
    expect((await fixture.memoryService.findById(published.memory.object_id))?.confidence).toBeNull();
  });
});

function expectNoPublishedObservation(database: StorageDatabase): void {
  expect(countRows(database, "SELECT COUNT(*) AS n FROM memory_entries WHERE dimension = 'observation'")).toBe(0);
  expect(countRows(database, "SELECT COUNT(*) AS n FROM evidence_capsules WHERE gist LIKE '%source-interpretation-v1%'")).toBe(0);
}

function countRows(database: StorageDatabase, sql: string): number {
  return (database.connection.prepare(sql).get() as { n: number }).n;
}
