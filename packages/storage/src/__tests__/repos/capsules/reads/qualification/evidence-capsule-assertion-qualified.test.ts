import { buildAssociativeFactKeyProjections, type AssociativeFactFrame } from "@do-soul/alaya-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvidenceCapsuleRepo,
  evidenceCapsuleDatabases
} from "../../evidence-capsule-repo-fixture.js";
import {
  assistantMatch,
  ownerMatch,
  seedFallbackV2
} from "../../assistant-observation-qualified-fixture.js";
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

  it("qualifies stored fact keys through their grounded materialized signal", async () => {
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

  it("fails closed when a stored fact key differs from its source assertion", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa");
    await repo.create(capsule);
    await persistAssertionProof(database, capsule);
    database.connection.prepare(`
      INSERT INTO evidence_search_projections (
        evidence_object_id, projection_id, projection_kind, workspace_id, source_hash, content
      ) VALUES (?, 5, 'fact_key', ?, ?, 'tampered fact key')
    `).run(capsule.object_id, capsule.workspace_id, capsule.source_hash);

    await expect(repo.findRecallQualifiedByIds("workspace-1", [{
      object_id: capsule.object_id,
      matched_projection: { projection_id: 5, projection_kind: "fact_key" }
    }])).rejects.toThrow("requested fact key does not match its source assertion");
  });

  it("rejects unauthenticated fact keys before writing the capsule", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa");
    await expect(repo.create(capsule, buildAssociativeFactKeyProjections(FACT_FRAME)))
      .rejects.toThrow("Fact-key projections are not accepted on evidence creation");
    await expect(repo.findById(capsule.object_id)).resolves.toBeNull();
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM evidence_search_projections").get())
      .toEqual({ count: 0 });
  });
});
