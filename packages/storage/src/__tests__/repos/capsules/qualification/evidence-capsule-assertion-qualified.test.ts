import { createHash } from "node:crypto";
import {
  SignalEventType,
  SignalState,
  SoulSignalMaterializedPayloadSchema,
  buildVerifiedUserAssertionReceiptPreimage,
  formatVerifiedUserAssertionSourceHash,
  type CandidateMemorySignal,
  type EvidenceCapsule
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

  it("rederives a fact key from its materialized grounded Signal", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    const signal = await persistAssertionSignal(database);
    await repo.create(capsule, [{
      projection_id: 5,
      projection_kind: "fact_key",
      content: "I bought my bookshelf"
    }]);
    insertMaterializationEvent(database, signal, capsule);

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
      }
    }]);
    await expect(repo.findRecallQualifiedFactKeysByIds(
      "workspace-1",
      [capsule.object_id]
    )).resolves.toEqual([expect.objectContaining({
      matched_projection: expect.objectContaining({ projection_kind: "fact_key" })
    })]);
  });

  it("fails closed when a stored fact key differs from its grounded frame", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa");
    const signal = await persistAssertionSignal(database);
    await repo.create(capsule, [{
      projection_id: 5,
      projection_kind: "fact_key",
      content: "I bought my desk from"
    }]);
    insertMaterializationEvent(database, signal, capsule);

    await expect(repo.findRecallQualifiedByIds("workspace-1", [{
      object_id: capsule.object_id,
      matched_projection: { projection_id: 5, projection_kind: "fact_key" }
    }])).rejects.toThrow("requested fact key does not match its grounded Signal");
  });
});

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
