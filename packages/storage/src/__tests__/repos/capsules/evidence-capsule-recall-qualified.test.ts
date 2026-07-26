import { createHash } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  SignalEventType,
  SignalState,
  SoulSignalMaterializedPayloadSchema,
  buildGardenSourceTurnFallbackReceiptPreimage,
  buildGardenSourceTurnFallbackV2ReceiptPreimage,
  formatGardenSourceTurnFallbackArtifactRef,
  formatGardenSourceTurnFallbackSourceHash,
  formatGardenSourceTurnFallbackV2SourceHash,
  type CandidateMemorySignal,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSignalRepo } from "../../../repos/signal/signal-repo.js";
import type { StorageDatabase } from "../../../sqlite/db.js";
import {
  createEvidenceCapsule,
  createEvidenceCapsuleRepo,
  evidenceCapsuleDatabases
} from "./evidence-capsule-repo-fixture.js";

afterEach(() => {
  for (const database of evidenceCapsuleDatabases) database.close();
  evidenceCapsuleDatabases.clear();
});

describe("SqliteEvidenceCapsuleRepo.findRecallQualifiedByIds", () => {
  it("returns a garden fallback only when its persisted proof closure is complete", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const proof = await seedFallback(
      database,
      repo,
      "valid",
      "11111111-1111-4111-8111-111111111111"
    );
    insertMaterializationEvent(database, proof.signal, proof.capsule, "event-valid");

    await expect(repo.findRecallQualifiedByIds("workspace-1", [
      proof.capsule.object_id,
      "missing"
    ])).resolves.toEqual([proof.capsule]);
  });

  it("accepts a v2 fallback only when the persisted user projection is bound", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const proof = await seedFallbackV2(
      database,
      repo,
      "66666666-6666-4666-8666-666666666666"
    );
    insertMaterializationEvent(database, proof.signal, proof.capsule, "event-v2");

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [proof.capsule.object_id]
    )).resolves.toEqual([proof.capsule]);

    database.connection.prepare(
      "UPDATE evidence_capsules SET excerpt = ? WHERE object_id = ?"
    ).run("Assistant projection", proof.capsule.object_id);

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [proof.capsule.object_id]
    )).resolves.toEqual([]);
  });

  it("rejects a forged format-only evidence row", async () => {
    const { repo } = await createEvidenceCapsuleRepo();
    const forged = createEvidenceCapsule({
      object_id: "22222222-2222-4222-8222-222222222222",
      lifecycle_state: "active",
      created_by: "garden_compile",
      evidence_kind: "conversation_excerpt",
      evidence_health_state: "verified",
      physical_anchor: {
        file_path: null,
        line_range: null,
        symbol_name: null,
        artifact_ref: formatGardenSourceTurnFallbackArtifactRef("missing-signal")
      },
      source_hash: formatGardenSourceTurnFallbackSourceHash("a".repeat(64))
    });
    await repo.create(forged);

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [forged.object_id]
    )).resolves.toEqual([]);
  });

  it.each(["missing", "failed", "duplicate"] as const)(
    "rejects %s materialization proof",
    async (materialization) => {
      const { database, repo } = await createEvidenceCapsuleRepo();
      const proof = await seedFallback(
        database,
        repo,
        materialization,
        evidenceId(materialization)
      );
      if (materialization !== "missing") {
        insertMaterializationEvent(
          database,
          proof.signal,
          proof.capsule,
          `event-${materialization}-1`,
          materialization !== "failed"
        );
      }
      if (materialization === "duplicate") {
        insertMaterializationEvent(
          database,
          proof.signal,
          proof.capsule,
          `event-${materialization}-2`,
          true,
          1
        );
      }

      await expect(repo.findRecallQualifiedByIds(
        "workspace-1",
        [proof.capsule.object_id]
      )).resolves.toEqual([]);
    }
  );
});

function evidenceId(materialization: "missing" | "failed" | "duplicate"): string {
  return {
    missing: "33333333-3333-4333-8333-333333333333",
    failed: "44444444-4444-4444-8444-444444444444",
    duplicate: "55555555-5555-4555-8555-555555555555"
  }[materialization];
}

async function seedFallback(
  database: StorageDatabase,
  repo: Awaited<ReturnType<typeof createEvidenceCapsuleRepo>>["repo"],
  suffix: string,
  evidenceId: string
): Promise<{
  readonly signal: CandidateMemorySignal;
  readonly capsule: EvidenceCapsule;
}> {
  const signal = createFallbackSignal(`signal-${suffix}`, `Source corpus ${suffix}`);
  const signalRepo = new SqliteSignalRepo(database);
  await signalRepo.create(signal);
  await signalRepo.updateState(signal.signal_id, SignalState.MATERIALIZED);
  const materialized = CandidateMemorySignalSchema.parse({
    ...signal,
    signal_state: SignalState.MATERIALIZED
  });
  const digest = receiptDigest(materialized);
  const capsule = createEvidenceCapsule({
    object_id: evidenceId,
    lifecycle_state: "active",
    created_by: "garden_compile",
    evidence_kind: "conversation_excerpt",
    evidence_health_state: "verified",
    gist: `Source corpus ${suffix}`,
    excerpt: `Source corpus ${suffix}`,
    source_hash: formatGardenSourceTurnFallbackSourceHash(digest),
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: formatGardenSourceTurnFallbackArtifactRef(materialized.signal_id)
    },
    run_id: materialized.run_id,
    workspace_id: materialized.workspace_id,
    surface_id: materialized.surface_id
  });
  await repo.create(capsule);
  return { signal: materialized, capsule };
}

async function seedFallbackV2(
  database: StorageDatabase,
  repo: Awaited<ReturnType<typeof createEvidenceCapsuleRepo>>["repo"],
  evidenceId: string
): Promise<{
  readonly signal: CandidateMemorySignal;
  readonly capsule: EvidenceCapsule;
}> {
  const signal = createFallbackV2Signal();
  const materialized = await persistMaterializedSignal(database, signal);
  const capsule = createFallbackV2Capsule(evidenceId, materialized);
  await repo.create(capsule);
  return { signal: materialized, capsule };
}

function createFallbackV2Signal(): CandidateMemorySignal {
  const receiptInput = createFallbackV2ReceiptInput();
  const digest = sha256(buildGardenSourceTurnFallbackV2ReceiptPreimage(receiptInput));
  return CandidateMemorySignalSchema.parse({
    signal_id: receiptInput.signal_id,
    workspace_id: receiptInput.workspace_id,
    run_id: receiptInput.run_id,
    surface_id: receiptInput.surface_id,
    source: "garden_compile",
    signal_kind: "potential_evidence_anchor",
    signal_state: "emitted",
    object_kind: "source_turn",
    scope_hint: null,
    domain_tags: ["source-turn"],
    confidence: 1,
    evidence_refs: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      full_turn_content: receiptInput.source_corpus,
      source_role_spans: receiptInput.source_role_spans,
      evidence_preservation: {
        version: 2,
        reason: receiptInput.reason,
        truncated: false,
        chars_clipped: 0,
        source_receipt_sha256: digest
      }
    },
    source_observation: receiptInput.source_observation,
    created_at: receiptInput.created_at
  });
}

function createFallbackV2ReceiptInput() {
  const corpus = "User: Source fact\nAssistant: Acknowledged";
  const sourceObservation = {
    observed_at: "2026-03-20T00:00:00.000Z",
    authority: "trusted_host_event" as const,
    source_event_id: "source-signal-v2"
  };
  const receiptInput = {
    signal_id: "signal-v2",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    created_at: "2026-03-20T00:00:00.000Z",
    source_observation: sourceObservation,
    source_corpus: corpus,
    source_role_spans: [
      { role: "user" as const, start: 6, end: 17 },
      { role: "assistant" as const, start: 29, end: 41 }
    ],
    reason: "empty_extraction" as const,
    truncated: false,
    chars_clipped: 0
  };
  return receiptInput;
}

async function persistMaterializedSignal(
  database: StorageDatabase,
  signal: CandidateMemorySignal
): Promise<CandidateMemorySignal> {
  const signalRepo = new SqliteSignalRepo(database);
  await signalRepo.create(signal);
  await signalRepo.updateState(signal.signal_id, SignalState.MATERIALIZED);
  return CandidateMemorySignalSchema.parse({
    ...signal,
    signal_state: SignalState.MATERIALIZED
  });
}

function createFallbackV2Capsule(
  evidenceId: string,
  signal: CandidateMemorySignal
): EvidenceCapsule {
  return createEvidenceCapsule({
    object_id: evidenceId,
    lifecycle_state: "active",
    created_by: "garden_compile",
    evidence_kind: "conversation_excerpt",
    evidence_health_state: "verified",
    gist: "User: Source fact\nAssistant: Acknowledged",
    excerpt: "Source fact",
    source_hash: formatGardenSourceTurnFallbackV2SourceHash(receiptDigest(signal)),
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: formatGardenSourceTurnFallbackArtifactRef(signal.signal_id)
    },
    run_id: signal.run_id,
    workspace_id: signal.workspace_id,
    surface_id: signal.surface_id
  });
}

function createFallbackSignal(signalId: string, corpus: string): CandidateMemorySignal {
  const sourceObservation = {
    observed_at: "2026-03-20T00:00:00.000Z",
    authority: "trusted_host_event" as const,
    source_event_id: `source-${signalId}`
  };
  const receiptInput = {
    signal_id: signalId,
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    created_at: "2026-03-20T00:00:00.000Z",
    source_observation: sourceObservation,
    source_corpus: corpus,
    reason: "empty_extraction" as const,
    truncated: false,
    chars_clipped: 0
  };
  return CandidateMemorySignalSchema.parse({
    signal_id: signalId,
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_evidence_anchor",
    signal_state: "emitted",
    object_kind: "source_turn",
    scope_hint: null,
    domain_tags: ["source-turn"],
    confidence: 1,
    evidence_refs: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      full_turn_content: corpus,
      evidence_preservation: {
        version: 1,
        reason: receiptInput.reason,
        truncated: false,
        chars_clipped: 0,
        source_receipt_sha256: sha256(
          buildGardenSourceTurnFallbackReceiptPreimage(receiptInput)
        )
      }
    },
    source_observation: sourceObservation,
    created_at: receiptInput.created_at
  });
}

function receiptDigest(signal: CandidateMemorySignal): string {
  const preservation = signal.raw_payload.evidence_preservation as {
    readonly source_receipt_sha256: string;
  };
  return preservation.source_receipt_sha256;
}

function insertMaterializationEvent(
  database: StorageDatabase,
  signal: CandidateMemorySignal,
  capsule: EvidenceCapsule,
  eventId: string,
  success = true,
  revision = 0
): void {
  const payload = SoulSignalMaterializedPayloadSchema.parse({
    signal_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    created_objects: success
      ? [{ object_kind: "evidence_capsule", object_id: capsule.object_id }]
      : [],
    success,
    ...(success ? {} : { error: "materialization failed" })
  });
  database.connection.prepare(`
    INSERT INTO event_log (
      event_id, event_type, entity_type, entity_id, workspace_id,
      run_id, caused_by, revision, payload_json, created_at
    ) VALUES (?, ?, 'candidate_memory_signal', ?, ?, ?, 'materialization_router', ?, ?, ?)
  `).run(
    eventId,
    success
      ? SignalEventType.SOUL_SIGNAL_MATERIALIZED
      : SignalEventType.SOUL_SIGNAL_MATERIALIZATION_FAILED,
    signal.signal_id,
    signal.workspace_id,
    signal.run_id,
    revision,
    JSON.stringify(payload),
    signal.created_at
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
