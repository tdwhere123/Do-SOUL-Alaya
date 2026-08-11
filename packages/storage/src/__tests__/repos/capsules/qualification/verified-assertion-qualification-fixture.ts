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
import type { StorageDatabase } from "../../../../sqlite/db.js";
import { SqliteSignalRepo } from "../../../../repos/signal/signal-repo.js";
import { createEvidenceCapsule } from "../evidence-capsule-repo-fixture.js";

export const ASSERTION = "I bought my bookshelf from IKEA.";
export const SOURCE_CORPUS = `User: ${ASSERTION}`;

export async function persistAssertionSignal(
  database: StorageDatabase
): Promise<CandidateMemorySignal> {
  const sourceHash = verifiedAssertionSourceHash(ASSERTION, SOURCE_CORPUS, {
    workspace_id: "workspace-1", run_id: "run-1", surface_id: null
  });
  const signal = assertionSignal(sourceHash);
  const repo = new SqliteSignalRepo(database);
  await repo.create(signal);
  await repo.updateState(signal.signal_id, SignalState.MATERIALIZED);
  return { ...signal, signal_state: SignalState.MATERIALIZED };
}

export async function persistAssertionProof(
  database: StorageDatabase,
  capsule: EvidenceCapsule
): Promise<void> {
  const signal = await persistAssertionSignal(database);
  insertMaterializationEvent(database, signal, capsule);
}

export function assertionCapsule(
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
      file_path: null, line_range: null, symbol_name: null, artifact_ref: "msg-1"
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

export function verifiedAssertionSourceHash(
  assertion: string,
  sourceCorpus: string,
  scope: Pick<EvidenceCapsule, "workspace_id" | "run_id" | "surface_id">
): string {
  const digest = createHash("sha256").update(buildVerifiedUserAssertionReceiptPreimage({
    workspace_id: scope.workspace_id,
    run_id: scope.run_id,
    surface_id: scope.surface_id,
    source_assertion: assertion,
    source_corpus: sourceCorpus
  }), "utf8").digest("hex");
  return formatVerifiedUserAssertionSourceHash(digest);
}

export function insertMaterializationEvent(
  database: StorageDatabase,
  signal: CandidateMemorySignal,
  capsule: EvidenceCapsule,
  additionalCreatedObjects: readonly Readonly<{
    readonly object_kind: string;
    readonly object_id: string;
  }>[] = []
): void {
  const payload = SoulSignalMaterializedPayloadSchema.parse({
    signal_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    created_objects: [
      { object_kind: "evidence_capsule", object_id: capsule.object_id },
      ...additionalCreatedObjects
    ],
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

function assertionSignal(sourceHash: string): CandidateMemorySignal {
  return {
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
      full_turn_content: SOURCE_CORPUS,
      verified_user_assertion_source_hash: sourceHash,
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
  };
}
