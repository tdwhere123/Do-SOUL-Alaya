import { createHash } from "node:crypto";
import {
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
  SignalEventType,
  SignalState,
  SoulSignalMaterializedPayloadSchema,
  buildAssociativeFactKeyProjections,
  buildVerifiedUserAssertionReceiptPreimage,
  evidenceFactFrameFormationCapturePreimage,
  formatVerifiedUserAssertionSourceHash,
  type AssociativeFactFrame,
  type CandidateMemorySignal,
  type EvidenceCapsule,
  type EvidenceFactFrameFormationCapture,
  type EvidenceFactFrameFormationCaptureBody
} from "@do-soul/alaya-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageDatabase } from "../../../../sqlite/db.js";
import { SqliteSignalRepo } from "../../../../repos/signal/signal-repo.js";
import {
  createEvidenceCapsule,
  createEvidenceCapsuleRepo,
  evidenceCapsuleDatabases
} from "../evidence-capsule-repo-fixture.js";
import {
  assistantMatch,
  ownerMatch,
  seedFallbackV2
} from "../assistant-observation-qualified-fixture.js";

const ASSERTION = "I bought my bookshelf from IKEA.";
const SOURCE_CORPUS = `User: ${ASSERTION}`;
const FACT_FRAME = Object.freeze({
  schema_version: 1 as const,
  slots: Object.freeze([
    Object.freeze({ role: "subject" as const, text: "I" }),
    Object.freeze({ role: "relation" as const, text: "bought" }),
    Object.freeze({ role: "value" as const, text: "my bookshelf" }),
    Object.freeze({ role: "qualifier" as const, text: "from IKEA" })
  ])
}) satisfies Readonly<AssociativeFactFrame>;

afterEach(() => {
  for (const database of evidenceCapsuleDatabases) database.close();
  evidenceCapsuleDatabases.clear();
});

describe("verified assertion evidence qualification", () => {
  it("qualifies without a turn-fallback receipt", async () => {
    const { repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    await repo.create(capsule);

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [ownerMatch(capsule.object_id)]
    )).resolves.toEqual([{
      capsule,
      verified_user_projection: false
    }]);
  });

  it.each([
    ["excerpt", { excerpt: "I bought my desk from IKEA." }],
    ["gist", { gist: "User: I bought my desk from IKEA." }],
    ["run", { run_id: "run-2" }],
    ["surface", { surface_id: "surface-drift" }]
  ] satisfies readonly [string, Partial<EvidenceCapsule>][])(
    "rejects a receipt that does not bind its %s",
    async (_field, overrides) => {
      const { repo } = await createEvidenceCapsuleRepo();
      const capsule = assertionCapsule(
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        overrides
      );
      await repo.create(capsule);

      await expect(repo.findRecallQualifiedByIds(
        "workspace-1",
        [ownerMatch(capsule.object_id)]
      )).resolves.toEqual([]);
    }
  );

  it("keeps fallback Assistant authority closed when an assertion tag wins", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const proof = await seedFallbackV2(
      database,
      repo,
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      "assistant"
    );
    const sourceHash = verifiedAssertionSourceHash(
      ASSERTION,
      proof.capsule.gist,
      proof.capsule
    );
    database.connection.prepare(`
      UPDATE evidence_capsules
      SET excerpt = ?, source_hash = ?
      WHERE object_id = ?
    `).run(ASSERTION, sourceHash, proof.capsule.object_id);
    database.connection.prepare(`
      UPDATE evidence_search_projections
      SET source_hash = ?
      WHERE evidence_object_id = ?
    `).run(sourceHash, proof.capsule.object_id);
    insertMaterializationEvent(database, proof.signal, proof.capsule);

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [assistantMatch(proof.capsule.object_id)]
    )).rejects.toThrow(
      "requested Assistant observation does not match its verified receipt"
    );
  });

  it("does not authorize an Assistant projection", async () => {
    const { repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("ffffffff-ffff-4fff-8fff-ffffffffffff");
    await repo.create(capsule, [{
      projection_id: 1,
      projection_kind: "assistant_observation",
      content: "Assistant-only content"
    }]);

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [assistantMatch(capsule.object_id)]
    )).rejects.toThrow(
      "requested Assistant observation does not match its verified receipt"
    );
  });

  it("rederives a fact key from its persisted canonical formation", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    await repo.create(
      capsule,
      buildAssociativeFactKeyProjections(FACT_FRAME),
      factFrameFormationCapture(capsule)
    );
    expect(database.connection.prepare(`
      SELECT status, source_hash FROM evidence_fact_frame_formations
      WHERE evidence_object_id = ?
    `).get(capsule.object_id)).toEqual({
      status: "formed",
      source_hash: capsule.source_hash
    });

    await expect(repo.findRecallQualifiedByIds("workspace-1", [{
      object_id: capsule.object_id,
      matched_projection: { projection_id: 5, projection_kind: "fact_key" }
    }])).resolves.toEqual([{
      capsule,
      verified_user_projection: false,
      matched_projection: {
        projection_id: 5,
        projection_kind: "fact_key",
        content: "I bought my bookshelf"
      },
      matched_fact_key_forms: [{
        kind: "leave_one_slot_out",
        omitted_slot: { slot_index: 3, role: "qualifier" }
      }],
      matched_fact_frame: FACT_FRAME
    }]);
    const allFactKeys = await repo.findRecallQualifiedFactKeysByIds(
      "workspace-1",
      [capsule.object_id]
    );
    expect(allFactKeys).toHaveLength(5);
    expect(allFactKeys.every(({ matched_projection: projection }) =>
      projection?.projection_kind === "fact_key"
    )).toBe(true);
  });

  it("keeps pre-formation fact keys readable through the historical Signal fallback", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa");
    const signal = await persistAssertionSignal(database);
    await repo.create(capsule);
    database.connection.prepare(`
      INSERT INTO evidence_search_projections (
        evidence_object_id, projection_id, projection_kind,
        workspace_id, source_hash, content
      ) VALUES (?, 5, 'fact_key', ?, ?, 'I bought my bookshelf')
    `).run(capsule.object_id, capsule.workspace_id, capsule.source_hash);
    insertMaterializationEvent(database, signal, capsule);

    await expect(repo.findRecallQualifiedByIds("workspace-1", [{
      object_id: capsule.object_id,
      matched_projection: { projection_id: 5, projection_kind: "fact_key" }
    }])).resolves.toEqual([expect.objectContaining({
      matched_fact_frame: FACT_FRAME,
      matched_projection: expect.objectContaining({ content: "I bought my bookshelf" })
    })]);
  });

  it("fails closed when a stored fact key differs from its canonical formation", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa");
    await repo.create(
      capsule,
      buildAssociativeFactKeyProjections(FACT_FRAME),
      factFrameFormationCapture(capsule)
    );
    database.connection.prepare(`
      UPDATE evidence_search_projections SET content = 'tampered fact key'
      WHERE evidence_object_id = ? AND projection_id = 5
    `).run(capsule.object_id);

    await expect(repo.findRecallQualifiedByIds("workspace-1", [{
      object_id: capsule.object_id,
      matched_projection: { projection_id: 5, projection_kind: "fact_key" }
    }])).rejects.toThrow("requested fact key does not match its canonical formation");
  });

  it("rejects a source-drifted formation without partially writing Evidence", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa");
    const driftedCapture = factFrameFormationCapture({
      ...capsule,
      source_hash: "sha256:drifted"
    });

    await expect(repo.create(
      capsule,
      buildAssociativeFactKeyProjections(FACT_FRAME),
      driftedCapture
    )).rejects.toThrow("source hash does not match");
    await expect(repo.findById(capsule.object_id)).resolves.toBeNull();
    expect(database.connection.prepare(`
      SELECT
        (SELECT COUNT(*) FROM evidence_search_projections) AS projections,
        (SELECT COUNT(*) FROM evidence_fact_frame_formations) AS formations
    `).get()).toEqual({ projections: 0, formations: 0 });
  });
});

function factFrameFormationCapture(
  capsule: Readonly<EvidenceCapsule>
): EvidenceFactFrameFormationCapture {
  const body: EvidenceFactFrameFormationCaptureBody = {
    schema_version: 1,
    operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
    status: "formed",
    producer_operator_id: "test_grounded_fact_frame_v1",
    source_hash: capsule.source_hash,
    fact_frame: FACT_FRAME
  };
  return {
    ...body,
    capture_digest: `sha256:${createHash("sha256")
      .update(evidenceFactFrameFormationCapturePreimage(body), "utf8")
      .digest("hex")}`
  };
}

async function persistAssertionSignal(database: StorageDatabase): Promise<CandidateMemorySignal> {
  const signal = {
    signal_id: "signal-assertion",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    signal_state: "emitted",
    object_kind: "fact",
    scope_hint: null,
    domain_tags: [],
    confidence: 0.9,
    evidence_refs: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      source_assertion: ASSERTION,
      distilled_fact: ASSERTION,
      source_grounding: {
        version: 1,
        status: "grounded",
        content_basis: "source_assertion",
        source_assertion: ASSERTION,
        proposed_matched_text: ASSERTION,
        reasons: []
      },
      fact_frame: {
        schema_version: 1,
        slots: [
          { role: "subject", text: "I" },
          { role: "relation", text: "bought" },
          { role: "value", text: "my bookshelf" },
          { role: "qualifier", text: "from IKEA" }
        ]
      }
    },
    created_at: "2026-03-20T00:00:00.000Z"
  } as const;
  const repo = new SqliteSignalRepo(database);
  await repo.create(signal);
  await repo.updateState(signal.signal_id, SignalState.MATERIALIZED);
  return { ...signal, signal_state: SignalState.MATERIALIZED };
}

function assertionCapsule(
  objectId: string,
  overrides: Partial<EvidenceCapsule> = {}
): EvidenceCapsule {
  const sourceHash = verifiedAssertionSourceHash(
    ASSERTION,
    SOURCE_CORPUS,
    createEvidenceCapsule()
  );
  return createEvidenceCapsule({
    object_id: objectId,
    lifecycle_state: "active",
    created_by: "garden_compile",
    evidence_kind: "conversation_excerpt",
    evidence_health_state: "verified",
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: "msg-1"
    },
    gist: SOURCE_CORPUS,
    excerpt: ASSERTION,
    source_hash: sourceHash,
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null,
    ...overrides
  });
}

function verifiedAssertionSourceHash(
  assertion: string,
  sourceCorpus: string,
  scope: Pick<EvidenceCapsule, "workspace_id" | "run_id" | "surface_id">
): string {
  return formatVerifiedUserAssertionSourceHash(
    createHash("sha256")
      .update(buildVerifiedUserAssertionReceiptPreimage({
        workspace_id: scope.workspace_id,
        run_id: scope.run_id,
        surface_id: scope.surface_id,
        source_assertion: assertion,
        source_corpus: sourceCorpus
      }), "utf8")
      .digest("hex")
  );
}

function insertMaterializationEvent(
  database: StorageDatabase,
  signal: CandidateMemorySignal,
  capsule: EvidenceCapsule
): void {
  const payload = SoulSignalMaterializedPayloadSchema.parse({
    signal_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    created_objects: [{ object_kind: "evidence_capsule", object_id: capsule.object_id }],
    success: true
  });
  database.connection.prepare(`
    INSERT INTO event_log (
      event_id, event_type, entity_type, entity_id, workspace_id,
      run_id, caused_by, revision, payload_json, created_at
    ) VALUES (?, ?, 'candidate_memory_signal', ?, ?, ?, 'materialization_router', 0, ?, ?)
  `).run(
    "event-assertion-precedence",
    SignalEventType.SOUL_SIGNAL_MATERIALIZED,
    signal.signal_id,
    signal.workspace_id,
    signal.run_id,
    JSON.stringify(payload),
    signal.created_at
  );
}
