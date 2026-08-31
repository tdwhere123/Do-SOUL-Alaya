import { createHash } from "node:crypto";
import {
  SignalEventType,
  SignalState,
  SoulSignalMaterializedPayloadSchema,
  buildVerifiedUserAssertionReceiptV2Preimage,
  formatVerifiedUserAssertionV2SourceHash,
  type CandidateMemorySignal,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import {
  buildEvidenceInput,
  buildOfficialApiSourceCorpus,
  OfficialApiGardenProvider,
  verifyOfficialApiSourceLocatorBinding
} from "@do-soul/alaya-soul";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageDatabase } from "../../../../../sqlite/db.js";
import { SqliteSignalRepo } from "../../../../../repos/signal/signal-repo.js";
import {
  createEvidenceCapsule,
  createEvidenceCapsuleRepo,
  evidenceCapsuleDatabases
} from "../../evidence-capsule-repo-fixture.js";
import { ownerMatch } from "../../assistant-observation-qualified-fixture.js";

const ASSERTION = "I use the cobalt release channel for production deployments.";

afterEach(() => {
  for (const database of evidenceCapsuleDatabases) database.close();
  evidenceCapsuleDatabases.clear();
});

describe("official API verified assertion receipt integration", () => {
  it("qualifies the exact persisted corpus used by an oversized receipt", async () => {
    const messages = oversizedUserMessages();
    const sourceCorpus = buildOfficialApiSourceCorpus(ASSERTION, messages);
    const signal = await compileSignal(messages, "signal-corpus-identity");

    const persisted = buildEvidenceInput(signal, undefined, { fullTurnExcerpt: true });
    expect(messages[0]!.content.length).toBeGreaterThan(2_048);
    expect(sourceCorpus.length).toBeGreaterThan(2_048);
    const rawPayload = signal.raw_payload as Readonly<Record<string, unknown>>;
    expect(rawPayload.full_turn_content).toBe(persisted.gist);
    expect(rawPayload.source_assertion).toBe(persisted.excerpt);

    const { database, repo } = await createEvidenceCapsuleRepo(
      ":memory:",
      verifyOfficialApiSourceLocatorBinding
    );
    const capsule = createEvidenceCapsule({
      ...persisted,
      object_id: "a1111111-1111-4111-8111-111111111111",
      lifecycle_state: "active",
      created_at: "2026-08-12T00:00:00.000Z",
      updated_at: "2026-08-12T00:00:00.000Z"
    });
    await repo.create(capsule);
    await persistSignal(database, signal);
    await expect(repo.findRecallQualifiedByIds(
      "workspace-1", [ownerMatch(capsule.object_id)]
    )).resolves.toEqual([]);
    insertMaterializationEvent(database, signal, capsule);
    expect(rawPayload.verified_user_assertion_source_hash).toBe(capsule.source_hash);
    expect(database.connection.prepare(`
      SELECT signal_id FROM recall_routing_key_owners
      WHERE workspace_id = ? AND owner_kind = 'evidence_capsule' AND owner_id = ?
    `).get(capsule.workspace_id, capsule.object_id)).toEqual({ signal_id: signal.signal_id });

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [ownerMatch(capsule.object_id)]
    )).resolves.toEqual([{
      capsule,
      verified_user_projection: false
    }]);
  });

  it("rejects a self-consistent v2 receipt with an unresolved locator", async () => {
    const signal = await compileSignal([{
      message_id: "user-1",
      role: "user" as const,
      content: ASSERTION
    }], "signal-invalid-locator");
    const raw = signal.raw_payload as Readonly<Record<string, unknown>>;
    const corpus = String(raw.full_turn_content);
    const invalidLocator = {
      contract_version: 2 as const,
      kind: "assertion_catalog" as const,
      assertion_id: 2
    };
    const validLocator = raw.source_locator as {
      readonly contract_version: 2;
      readonly kind: "assertion_catalog";
      readonly assertion_id: number;
    };
    expect(verifyOfficialApiSourceLocatorBinding({
      sourceCorpus: corpus,
      sourceAssertion: ASSERTION,
      sourceLocator: validLocator
    })).toBe(true);
    expect(verifyOfficialApiSourceLocatorBinding({
      sourceCorpus: corpus,
      sourceAssertion: ASSERTION,
      sourceLocator: invalidLocator
    })).toBe(false);
    const sourceHash = formatVerifiedUserAssertionV2SourceHash(sha256(
      buildVerifiedUserAssertionReceiptV2Preimage({
        signal_id: signal.signal_id,
        source_locator: invalidLocator,
        workspace_id: signal.workspace_id,
        run_id: signal.run_id,
        surface_id: signal.surface_id,
        source_assertion: ASSERTION,
        source_corpus: corpus
      })
    ));
    const forgedSignal = {
      ...signal,
      raw_payload: {
        ...signal.raw_payload,
        source_locator: invalidLocator,
        verified_user_assertion_source_hash: sourceHash
      }
    };
    const capsule = createEvidenceCapsule({
      object_id: "a2222222-2222-4222-8222-222222222222",
      created_by: "garden_compile",
      evidence_kind: "conversation_excerpt",
      evidence_health_state: "verified",
      gist: corpus,
      excerpt: ASSERTION,
      source_hash: sourceHash
    });
    const { database, repo } = await createEvidenceCapsuleRepo(
      ":memory:",
      verifyOfficialApiSourceLocatorBinding
    );
    await repo.create(capsule);
    await persistSignal(database, forgedSignal);
    insertMaterializationEvent(database, forgedSignal, capsule);

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [ownerMatch(capsule.object_id)]
    )).resolves.toEqual([]);
  });
});

async function compileSignal(
  messages: ReturnType<typeof oversizedUserMessages>,
  signalId: string
): Promise<Readonly<CandidateMemorySignal>> {
  const provider = new OfficialApiGardenProvider({
    apiKey: "sk-test",
    extractor: { extract: async ({ userPrompt }) => {
      const request = JSON.parse(userPrompt) as {
        readonly source_assertions: readonly { readonly assertion_id: number; readonly text: string }[];
      };
      const source = request.source_assertions.find(({ text }) => text.includes(ASSERTION));
      return source === undefined
        ? { rawJson: '{"signals":[]}' }
        : { rawJson: JSON.stringify({ signals: [openSignal(source.assertion_id)] }) };
    } },
    generateSignalId: () => signalId
  });
  const [signal] = await provider.compile(ASSERTION, {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    turn_messages: messages
  });
  if (signal === undefined) throw new Error("expected one grounded assertion signal");
  return signal;
}

function oversizedUserMessages() {
  const fillers = Array.from(
    { length: 80 },
    (_, index) => `I recorded ordinary placeholder detail number ${index}.`
  );
  return [{
    message_id: "user-1",
    role: "user" as const,
    content: [ASSERTION, ...fillers].join(" ")
  }];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function persistSignal(
  database: StorageDatabase,
  signal: Readonly<CandidateMemorySignal>
): Promise<void> {
  const signalRepo = new SqliteSignalRepo(database);
  await signalRepo.create(signal);
  await signalRepo.updateState(signal.signal_id, SignalState.MATERIALIZED);
}

function insertMaterializationEvent(
  database: StorageDatabase,
  signal: Readonly<CandidateMemorySignal>,
  capsule: Readonly<EvidenceCapsule>
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
    "event-corpus-identity",
    SignalEventType.SOUL_SIGNAL_MATERIALIZED,
    signal.signal_id,
    signal.workspace_id,
    signal.run_id,
    JSON.stringify(payload),
    signal.created_at
  );
}

function openSignal(assertionId: number) {
  return {
    signal_kind: "potential_claim",
    object_kind: "deployment_preference",
    confidence: 0.9,
    matched_text: ASSERTION,
    source_locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: assertionId
    },
    semantic_factor_graph: {
      schema_version: 2,
      source_kind: "evidence",
      factors: [{
        factor_id: "f0",
        surface: ASSERTION.slice(0, 64),
        semantic_identity: ASSERTION.slice(0, 64).toLowerCase()
      }],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "p0",
        predicate_factor_id: "f0",
        arguments: [{
          position: 0,
          binding_identity: "assertion",
          reference_kind: "factor",
          reference_id: "f0"
        }]
      }]
    }
  };
}
