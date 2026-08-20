import { createHash } from "node:crypto";
import {
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
  buildAssociativeFactKeyProjections,
  evidenceFactFrameFormationCapturePreimage,
  groundOpenSemanticFactorGraph,
  openSemanticFactorFormationCapturePreimage,
  type AssociativeFactFrame,
  type EvidenceCapsule,
  type EvidenceFactFrameFormationCapture,
  type EvidenceFactFrameFormationCaptureBody,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorFormationCaptureBody
} from "@do-soul/alaya-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvidenceCapsuleRepo,
  evidenceCapsuleDatabases
} from "../evidence-capsule-repo-fixture.js";
import {
  assistantMatch,
  ownerMatch,
  seedFallbackV2
} from "../assistant-observation-qualified-fixture.js";
import {
  ASSERTION,
  assertionCapsule,
  insertMaterializationEvent,
  persistAssertionProof,
  persistAssertionSignal,
  verifiedAssertionSourceHash
} from "./verified-assertion-qualification-fixture.js";
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
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    await repo.create(capsule);
    await persistAssertionProof(database, capsule);

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [ownerMatch(capsule.object_id)]
    )).resolves.toEqual([{
      capsule,
      verified_user_projection: false
    }]);
  });

  it("qualifies the unique evidence link in a multi-object materialization", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("cccccccc-0000-4000-8000-cccccccccccc");
    const signal = await persistAssertionSignal(database);
    await repo.create(capsule);
    insertMaterializationEvent(database, signal, capsule, [{
      object_kind: "memory_entry",
      object_id: "memory-1"
    }]);

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [ownerMatch(capsule.object_id)]
    )).resolves.toEqual([{
      capsule,
      verified_user_projection: false
    }]);
  });

  it("returns the evidence-owned semantic factor formation on owner reads", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("cccccccc-1111-4111-8111-cccccccccccc");
    const semanticFormation = semanticFactorFormationCapture();
    await repo.create(capsule, [], undefined, semanticFormation);
    await persistAssertionProof(database, capsule);

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [ownerMatch(capsule.object_id)]
    )).resolves.toEqual([{
      capsule,
      verified_user_projection: false,
      semantic_factor_formation: semanticFormation
    }]);
  });

  it("fails closed when the semantic factor formation receipt is corrupt", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("cccccccc-2222-4222-8222-cccccccccccc");
    await repo.create(capsule, [], undefined, semanticFactorFormationCapture());
    database.connection.prepare(`
      UPDATE evidence_semantic_factor_formations
      SET capture_digest = ?
      WHERE evidence_object_id = ?
    `).run(`sha256:${"0".repeat(64)}`, capsule.object_id);

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [ownerMatch(capsule.object_id)]
    )).rejects.toMatchObject({ name: "EvidenceProjectionIntegrityError" });
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
      "requested projection owner does not match its verified receipt"
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
      "requested projection owner does not match its verified receipt"
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
    await persistAssertionProof(database, capsule);
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
    await persistAssertionProof(database, capsule);
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

function semanticFactorFormationCapture(): OpenSemanticFactorFormationCapture {
  const graph = groundOpenSemanticFactorGraph({
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("actor", "I", 0, 1, "speaker"),
      factor("predicate", "bought", 2, 8, "buy"),
      factor("object", "my bookshelf", 9, 21, "bookshelf"),
      factor("source", "IKEA", 27, 31, "ikea")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "purchase",
      predicate_factor_id: "predicate",
      arguments: [
        { position: 0, binding_identity: "agent", reference_kind: "factor",
          reference_id: "actor" },
        { position: 1, binding_identity: "object", reference_kind: "factor",
          reference_id: "object" },
        { position: 2, binding_identity: "source", reference_kind: "factor",
          reference_id: "source" }
      ]
    }]
  }, ASSERTION);
  if (graph === null) throw new Error("semantic factor fixture must be grounded");
  const body: OpenSemanticFactorFormationCaptureBody = {
    schema_version: 1,
    operator_id: OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
    status: "formed",
    producer_operator_id: "test_open_semantic_factor_v1",
    source_sha256: `sha256:${createHash("sha256").update(ASSERTION, "utf8").digest("hex")}`,
    graph
  };
  return {
    ...body,
    capture_digest: `sha256:${createHash("sha256")
      .update(openSemanticFactorFormationCapturePreimage(body), "utf8")
      .digest("hex")}`
  };
}

function factor(
  factorId: string,
  surface: string,
  _start: number,
  _end: number,
  semanticIdentity: string
) {
  return {
    factor_id: factorId,
    surface,
    semantic_identity: semanticIdentity
  };
}
