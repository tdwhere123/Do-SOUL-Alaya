import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  CandidateMemorySignalSchema,
  SignalEventType,
  SoulSignalMaterializedPayloadSchema,
  hasGardenSourceTurnFallbackAnyReceiptFormat,
  isGardenSourceTurnFallbackV2Receipt,
  projectGardenSourceTurnFallbackV2UserContent,
  readGardenSourceTurnFallbackArtifactSignalId,
  readGardenSourceTurnFallbackV2SourceHashDigest,
  verifyGardenSourceTurnFallbackReceipt
} from "@do-soul/alaya-protocol";
import {
  buildLongMemEvalRoundMessages,
  pairSessionIntoRounds,
  type LongMemEvalQuestion
} from "../../../datasets/longmemeval/ingestion/dataset.js";
import { requireLongMemEvalTimestamp } from "../../../datasets/longmemeval/ingestion/source-time.js";
import { buildLongMemEvalRoundEvidenceRef } from
  "../../../datasets/longmemeval/runner/question/runner-question-seeding.js";
import type {
  LongMemEvalSnapshotDirectEvidenceBinding,
  LongMemEvalSnapshotQuestion,
  LongMemEvalSnapshotSeedRound,
  LongMemEvalSnapshotSidecarEntry
} from "../materialize.js";
import { SNAPSHOT_SIGNAL_MATERIALIZATION_EVENT_SQL } from
  "./seed-ledger-materialization-proof.js";

type VerifiedV2Receipt = Extract<
  NonNullable<ReturnType<typeof verifyGardenSourceTurnFallbackReceipt>>,
  { readonly source_role_spans: unknown }
>;

interface StoredDirectEvidence {
  readonly object_id: string;
  readonly object_kind: string;
  readonly lifecycle_state: string;
  readonly created_by: string;
  readonly evidence_kind: string;
  readonly physical_anchor: string | null;
  readonly evidence_health_state: string;
  readonly gist: string;
  readonly excerpt: string | null;
  readonly source_hash: string | null;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly surface_id: string | null;
}

interface StoredSignal {
  readonly signal_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly source: string;
  readonly signal_kind: string;
  readonly object_kind: string;
  readonly scope_hint: string | null;
  readonly domain_tags_json: string;
  readonly confidence: number;
  readonly evidence_refs_json: string;
  readonly source_memory_refs_json: string;
  readonly supersedes_refs_json: string;
  readonly exception_to_refs_json: string;
  readonly contradicts_refs_json: string;
  readonly incompatible_with_refs_json: string;
  readonly raw_payload_json: string;
  readonly source_delivery_ids_json: string | null;
  readonly source_observation_json: string | null;
  readonly signal_state: string;
  readonly created_at: string;
}

interface StoredEvent {
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly caused_by: string | null;
  readonly payload_json: string;
}

interface DirectBindingContext {
  readonly binding: LongMemEvalSnapshotDirectEvidenceBinding;
  readonly round: LongMemEvalSnapshotSeedRound;
  readonly sidecar: LongMemEvalSnapshotSidecarEntry;
}

export function assertDirectSourceEvidenceClosure(input: {
  readonly db: DatabaseSync;
  readonly question: LongMemEvalSnapshotQuestion;
  readonly source: LongMemEvalQuestion;
  readonly ledger: readonly LongMemEvalSnapshotSeedRound[];
}): void {
  const contexts = indexDeclaredBindings(input.question, input.ledger);
  if (contexts.size === 0) return;
  if (!hasAuthorityColumns(input.db)) {
    if (contexts.size > 0) {
      throw new Error("snapshot direct evidence authority columns are missing");
    }
    return;
  }
  const evidence = readEvidence(input.db, input.question.workspaceId);
  assertExactDirectEvidenceSet(evidence, contexts);
  for (const context of contexts.values()) {
    assertDirectBinding(input.db, evidence, input.question, input.source, context);
  }
}

function hasAuthorityColumns(db: DatabaseSync): boolean {
  const rows = db.prepare("PRAGMA table_info(evidence_capsules)")
    .all() as unknown as readonly { readonly name: string }[];
  const columns = new Set(rows.map((row) => row.name));
  return [
    "created_by",
    "evidence_kind",
    "evidence_health_state",
    "lifecycle_state",
    "source_hash"
  ].every((column) => columns.has(column));
}

function indexDeclaredBindings(
  question: LongMemEvalSnapshotQuestion,
  ledger: readonly LongMemEvalSnapshotSeedRound[]
): Map<string, DirectBindingContext> {
  const sidecar = new Map(question.sidecar
    .filter((entry) => entry.objectKind === "evidence_capsule")
    .map((entry) => [entry.objectId, entry]));
  const contexts = new Map<string, DirectBindingContext>();
  const signalIds = new Set<string>();
  for (const round of ledger) {
    for (const binding of round.directEvidenceBindings ?? []) {
      const entry = sidecar.get(binding.evidenceId);
      if (entry === undefined || contexts.has(binding.evidenceId) ||
          signalIds.has(binding.signalId) || !matchesSidecarRound(entry, round)) {
        throw new Error("snapshot direct evidence seed binding is ambiguous");
      }
      signalIds.add(binding.signalId);
      contexts.set(binding.evidenceId, { binding, round, sidecar: entry });
    }
  }
  if (contexts.size !== sidecar.size) {
    throw new Error("snapshot direct evidence seed binding is incomplete");
  }
  return contexts;
}

function assertExactDirectEvidenceSet(
  evidence: ReadonlyMap<string, StoredDirectEvidence>,
  expected: ReadonlyMap<string, DirectBindingContext>
): void {
  const directIds = [...evidence.values()]
    .filter(isDirectEvidenceFormat)
    .map((row) => row.object_id);
  if (directIds.length !== expected.size ||
      directIds.some((objectId) => !expected.has(objectId))) {
    throw new Error("snapshot direct evidence DB closure mismatch");
  }
}

function assertDirectBinding(
  db: DatabaseSync,
  evidence: ReadonlyMap<string, StoredDirectEvidence>,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  context: DirectBindingContext
): void {
  const row = evidence.get(context.binding.evidenceId);
  const signal = readSignal(db, context.binding.signalId);
  const receipt = signal === null
    ? null
    : verifyGardenSourceTurnFallbackReceipt(signal, sha256);
  const anchor = parseRecord(row?.physical_anchor);
  const artifactSignalId = readGardenSourceTurnFallbackArtifactSignalId(
    readString(anchor?.artifact_ref)
  );
  const expectedSignalId = buildLongMemEvalRoundEvidenceRef(
    source.question_id,
    context.round.sessionIndex,
    context.round.roundIndex
  );
  if (row === undefined || signal === null || receipt === null ||
      !isGardenSourceTurnFallbackV2Receipt(receipt) ||
      !matchesDirectEvidenceEnvelope(row, question, context) ||
      context.binding.signalId !== expectedSignalId ||
      receipt.signal_id !== context.binding.signalId ||
      receipt.workspace_id !== question.workspaceId ||
      receipt.run_id !== question.runId ||
      row.surface_id !== receipt.surface_id ||
      artifactSignalId !== context.binding.signalId ||
      !matchesReceiptSourceHash(row.source_hash, receipt) ||
      !matchesStoredReceiptProjection(row, receipt) ||
      !matchesCanonicalReceipt(receipt, context.round, source)) {
    throw new Error(`snapshot direct evidence receipt mismatch for ${context.binding.evidenceId}`);
  }
  assertMaterializationEvent(db, question, context.binding);
}

function matchesDirectEvidenceEnvelope(
  row: StoredDirectEvidence,
  question: LongMemEvalSnapshotQuestion,
  context: DirectBindingContext
): boolean {
  return row.object_kind === "evidence_capsule" &&
    row.workspace_id === question.workspaceId &&
    row.run_id === question.runId &&
    row.created_by === "garden_compile" &&
    row.lifecycle_state === "active" &&
    row.evidence_health_state === "verified" &&
    row.evidence_kind === "conversation_excerpt" &&
    context.sidecar.sessionId === context.round.sessionId &&
    context.sidecar.hasAnswer === context.round.hasAnswer;
}

function matchesCanonicalReceipt(
  receipt: VerifiedV2Receipt,
  round: LongMemEvalSnapshotSeedRound,
  source: LongMemEvalQuestion
): boolean {
  const observedAt = requireLongMemEvalTimestamp(source.haystack_dates[round.sessionIndex]);
  if (receipt.signal_id.trim().length === 0 ||
      receipt.workspace_id.trim().length === 0 || receipt.run_id.trim().length === 0) {
    return false;
  }
  const observation = receipt.source_observation;
  const metadataMatches =
    (receipt.surface_id === null || receipt.surface_id === round.sessionId) &&
    receipt.created_at === observedAt &&
    observation?.observed_at === observedAt &&
    observation.authority === "trusted_host_event" &&
    observation.source_event_id === receipt.signal_id;
  return metadataMatches && matchesCanonicalV2Receipt(receipt, round, source);
}

function matchesCanonicalV2Receipt(
  receipt: VerifiedV2Receipt,
  round: LongMemEvalSnapshotSeedRound,
  source: LongMemEvalQuestion
): boolean {
  const expected = buildExpectedV2Receipt(source, round);
  return expected !== null &&
    receipt.source_corpus === expected.sourceCorpus &&
    projectGardenSourceTurnFallbackV2UserContent(receipt) === expected.userContent &&
    receipt.source_role_spans.length === expected.sourceRoleSpans.length &&
    receipt.source_role_spans.every((span, index) => {
      const expectedSpan = expected.sourceRoleSpans[index];
      return expectedSpan !== undefined &&
        span.role === expectedSpan.role &&
        span.start === expectedSpan.start &&
        span.end === expectedSpan.end;
    });
}

function buildExpectedV2Receipt(
  source: LongMemEvalQuestion,
  round: LongMemEvalSnapshotSeedRound
): ExpectedV2Receipt | null {
  const session = source.haystack_sessions[round.sessionIndex];
  const pairedRound = session === undefined
    ? undefined
    : pairSessionIntoRounds(session)[round.roundIndex];
  if (session === undefined || pairedRound === undefined) return null;
  const messages = buildLongMemEvalRoundMessages(
    session,
    pairedRound,
    `${source.question_id}-s${round.sessionIndex}-r${round.roundIndex}`
  );
  let sourceCorpus = "";
  const sourceRoleSpans: ExpectedV2Receipt["sourceRoleSpans"][number][] = [];
  const userContent: string[] = [];
  for (const message of messages) {
    const content = message.content.trim();
    const prefix = `${sourceCorpus.length === 0 ? "" : "\n"}` +
      `${message.role === "user" ? "User" : "Assistant"}: `;
    const start = sourceCorpus.length + prefix.length;
    sourceCorpus += prefix + content;
    sourceRoleSpans.push({ role: message.role, start, end: sourceCorpus.length });
    if (message.role === "user") userContent.push(content);
  }
  return { sourceCorpus, sourceRoleSpans, userContent: userContent.join("\n") };
}

interface ExpectedV2Receipt {
  readonly sourceCorpus: string;
  readonly sourceRoleSpans: readonly Readonly<{
    readonly role: "user" | "assistant";
    readonly start: number;
    readonly end: number;
  }>[];
  readonly userContent: string;
}

function matchesReceiptSourceHash(
  sourceHash: string | null,
  receipt: VerifiedV2Receipt
): boolean {
  return readGardenSourceTurnFallbackV2SourceHashDigest(sourceHash) === receipt.digest;
}

function matchesStoredReceiptProjection(
  row: StoredDirectEvidence,
  receipt: VerifiedV2Receipt
): boolean {
  return row.gist === receipt.source_corpus &&
    row.excerpt === projectGardenSourceTurnFallbackV2UserContent(receipt);
}

function assertMaterializationEvent(
  db: DatabaseSync,
  question: LongMemEvalSnapshotQuestion,
  binding: LongMemEvalSnapshotDirectEvidenceBinding
): void {
  const rows = db.prepare(SNAPSHOT_SIGNAL_MATERIALIZATION_EVENT_SQL)
    .all(binding.signalId, SignalEventType.SOUL_SIGNAL_MATERIALIZED) as unknown as
    readonly StoredEvent[];
  const row = rows[0];
  const parsed = parseMaterializedPayload(row?.payload_json);
  const created = parsed?.created_objects ?? [];
  if (rows.length !== 1 || row === undefined || parsed === null ||
      row.entity_id !== binding.signalId ||
      row.workspace_id !== question.workspaceId || row.run_id !== question.runId ||
      row.caused_by !== "materialization_router" ||
      parsed.signal_id !== binding.signalId ||
      parsed.workspace_id !== question.workspaceId || parsed.run_id !== question.runId ||
      parsed.success !== true || created.length !== 1 ||
      created[0]?.object_kind !== "evidence_capsule" ||
      created[0]?.object_id !== binding.evidenceId) {
    throw new Error(`snapshot direct evidence materialization mismatch for ${binding.signalId}`);
  }
}

function readEvidence(
  db: DatabaseSync,
  workspaceId: string
): ReadonlyMap<string, StoredDirectEvidence> {
  const rows = db.prepare(`
    SELECT object_id, object_kind, lifecycle_state, created_by, evidence_kind,
           physical_anchor, evidence_health_state, gist, excerpt, source_hash,
           run_id, workspace_id, surface_id
      FROM evidence_capsules WHERE workspace_id = ?
  `).all(workspaceId) as unknown as readonly StoredDirectEvidence[];
  return new Map(rows.map((row) => [row.object_id, row]));
}

function readSignal(db: DatabaseSync, signalId: string) {
  const row = db.prepare(`
    SELECT signal_id, workspace_id, run_id, surface_id, source, signal_kind,
           object_kind, scope_hint, domain_tags_json, confidence, evidence_refs_json,
           source_memory_refs_json, supersedes_refs_json, exception_to_refs_json,
           contradicts_refs_json, incompatible_with_refs_json, raw_payload_json,
           source_delivery_ids_json, source_observation_json, signal_state, created_at
      FROM signals WHERE signal_id = ?
  `).get(signalId) as unknown as StoredSignal | undefined;
  if (row === undefined) return null;
  const parsed = CandidateMemorySignalSchema.safeParse({
    signal_id: row.signal_id, workspace_id: row.workspace_id, run_id: row.run_id,
    surface_id: row.surface_id, source: row.source, signal_kind: row.signal_kind,
    object_kind: row.object_kind, scope_hint: row.scope_hint,
    domain_tags: parseJson(row.domain_tags_json), confidence: row.confidence,
    evidence_refs: parseJson(row.evidence_refs_json),
    source_memory_refs: parseJson(row.source_memory_refs_json),
    supersedes_refs: parseJson(row.supersedes_refs_json),
    exception_to_refs: parseJson(row.exception_to_refs_json),
    contradicts_refs: parseJson(row.contradicts_refs_json),
    incompatible_with_refs: parseJson(row.incompatible_with_refs_json),
    raw_payload: parseJson(row.raw_payload_json), signal_state: row.signal_state,
    source_observation: parseJson(row.source_observation_json),
    created_at: row.created_at,
    ...(row.source_delivery_ids_json === null
      ? {}
      : { source_delivery_ids: parseJson(row.source_delivery_ids_json) })
  });
  return parsed.success && parsed.data.signal_state === "materialized" ? parsed.data : null;
}

function matchesSidecarRound(
  entry: LongMemEvalSnapshotSidecarEntry,
  round: LongMemEvalSnapshotSeedRound
): boolean {
  const sources = entry.sourceRounds;
  return sources?.length === 1 &&
    sources[0]?.sessionIndex === round.sessionIndex &&
    sources[0]?.roundIndex === round.roundIndex &&
    sources[0]?.sessionId === round.sessionId &&
    sources[0]?.hasAnswer === round.hasAnswer;
}

function isDirectEvidenceFormat(row: StoredDirectEvidence): boolean {
  const anchor = parseRecord(row.physical_anchor);
  return hasGardenSourceTurnFallbackAnyReceiptFormat({
    artifact_ref: readString(anchor?.artifact_ref),
    source_hash: row.source_hash
  });
}

function parseMaterializedPayload(value: string | undefined) {
  const result = SoulSignalMaterializedPayloadSchema.safeParse(parseJson(value));
  return result.success ? result.data : null;
}

function parseRecord(value: string | null | undefined): Record<string, unknown> | null {
  const parsed = parseJson(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function parseJson(value: string | null | undefined): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
