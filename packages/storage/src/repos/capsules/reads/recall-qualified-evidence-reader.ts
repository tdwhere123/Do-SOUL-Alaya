import { createHash } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  SignalEventType,
  SoulSignalMaterializedPayloadSchema,
  formatGardenSourceTurnFallbackSourceHash,
  formatGardenSourceTurnFallbackV2SourceHash,
  isGardenSourceTurnFallbackV2Receipt,
  parseVerifiedUserAssertionSourceHash,
  readGardenSourceTurnFallbackArtifactSignalId,
  verifyGardenSourceTurnFallbackReceipt,
  type CandidateMemorySignal,
  type EvidenceCapsule,
  type GardenSourceTurnFallbackVerifiedReceipt,
  type OpenSemanticFactorFormationCapture,
  type EvidenceFactFrameFormationCapture
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../../sqlite/refreshable-statement-holder.js";
import { parseNullableJsonColumn } from "../../shared/parse-json-column.js";
import { parseEvidenceCapsuleRow } from "../mappers/evidence-capsule-mappers.js";
import type {
  EvidenceSearchMatch,
  RecallQualifiedEvidence,
  VerifiedAssertionLocatorResolver
} from "../evidence-recall-types.js";
import {
  compareQualifiedProjectionIdentity,
  EvidenceProjectionIntegrityError,
  normalizeEvidenceSearchMatches,
  qualifyEvidenceMatch,
  readQualifiedProjectionIndex,
  type StoredProjectionRow
} from "./qualification/qualified-evidence-projection.js";
import { readStoredSemanticFactorFormation } from
  "./qualification/semantic-factor-formation-read.js";
import { readStoredFactFrameFormation } from
  "./qualification/fact-frame-formation-read.js";
import { matchesVerifiedAssertionReceipt } from
  "./qualification/verified-assertion-receipt-proof.js";
import {
  prepareQualifiedEvidenceStatements,
  type QualifiedEvidenceStatements
} from "../statements/qualification/qualified-evidence-statements.js";
import type {
  EvidenceCandidate,
  EvidenceQualificationRow,
  QualificationInputs,
  QualifiedEvidenceProof,
  StoredMaterializationRow,
  StoredSignalRow
} from "./qualification/recall-qualified-evidence-types.js";

const QUERY_CHUNK_SIZE = 500;

export class RecallQualifiedEvidenceReader {
  private readonly statementHolder: RefreshableStatementHolder<QualifiedEvidenceStatements>;
  private readonly strictParse: boolean;
  private parseSkipCount = 0;

  public constructor(
    db: StorageDatabase,
    private readonly resolveVerifiedAssertionLocator?: VerifiedAssertionLocatorResolver,
    options: Readonly<{ readonly strictParse?: boolean }> = {}
  ) {
    this.statementHolder = new RefreshableStatementHolder(
      db,
      prepareQualifiedEvidenceStatements
    );
    this.strictParse = options.strictParse === true;
  }

  public get skippedParseCount(): number {
    return this.parseSkipCount;
  }

  public find(
    workspaceId: string,
    requestedMatches: readonly EvidenceSearchMatch[]
  ): readonly RecallQualifiedEvidence[] {
    const matches = normalizeEvidenceSearchMatches(requestedMatches);
    if (matches.length === 0) return Object.freeze([]);
    const qualified: RecallQualifiedEvidence[] = [];
    for (let offset = 0; offset < matches.length; offset += QUERY_CHUNK_SIZE) {
      qualified.push(...this.findChunk(
        workspaceId,
        matches.slice(offset, offset + QUERY_CHUNK_SIZE)
      ));
    }
    return qualified.sort((left, right) =>
      left.capsule.created_at.localeCompare(right.capsule.created_at) ||
      left.capsule.object_id.localeCompare(right.capsule.object_id) ||
      compareQualifiedProjectionIdentity(left.matched_projection, right.matched_projection)
    );
  }

  public findReceiptQualifiedOwnerIds(
    workspaceId: string,
    requestedObjectIds: readonly string[]
  ): readonly string[] {
    const objectIds = [...new Set(requestedObjectIds
      .map((objectId) => objectId.trim())
      .filter((objectId) => objectId.length > 0))];
    const qualified: string[] = [];
    for (let offset = 0; offset < objectIds.length; offset += QUERY_CHUNK_SIZE) {
      qualified.push(...this.findReceiptQualifiedOwnerIdsChunk(
        workspaceId,
        objectIds.slice(offset, offset + QUERY_CHUNK_SIZE)
      ));
    }
    return Object.freeze(qualified.sort((left, right) => left.localeCompare(right)));
  }

  private findChunk(
    workspaceId: string,
    matches: readonly EvidenceSearchMatch[]
  ): readonly RecallQualifiedEvidence[] {
    const evidenceObjectIds = [...new Set(matches.map((match) => match.object_id))];
    const { candidates, signals, events } = this.readQualificationInputs(
      workspaceId,
      evidenceObjectIds
    );
    if (candidates.length === 0) return [];
    const projections = readQualifiedProjectionIndex(
      this.statementHolder.active().findProjectionRows.all(
        workspaceId,
        JSON.stringify(evidenceObjectIds)
      ) as StoredProjectionRow[]
    );
    const candidateById = new Map(candidates.map((candidate) => [
      candidate.capsule.object_id,
      candidate
    ]));
    return matches.flatMap((match) => {
      const candidate = candidateById.get(match.object_id);
      if (candidate === undefined) return [];
      const proof = readQualifiedProof(
        candidate,
        candidate.signalId === null ? undefined : signals.get(candidate.signalId),
        events,
        match.matched_projection !== undefined,
        this.resolveVerifiedAssertionLocator
      );
      if (proof === null) return [];
      const qualified = qualifyEvidenceMatch(
        match,
        candidate.capsule,
        proof.turnReceipt,
        projections,
        candidate.signalId === null ? undefined : signals.get(candidate.signalId),
        candidate.semanticFactorFormation,
        candidate.factFrameFormation
      );
      return qualified === null ? [] : [qualified];
    });
  }

  private findReceiptQualifiedOwnerIdsChunk(
    workspaceId: string,
    objectIds: readonly string[]
  ): readonly string[] {
    const { candidates, signals, events } = this.readQualificationInputs(
      workspaceId,
      objectIds
    );
    return candidates.flatMap((candidate) => {
      const proof = readQualifiedProof(
        candidate,
        candidate.signalId === null ? undefined : signals.get(candidate.signalId),
        events,
        false,
        this.resolveVerifiedAssertionLocator
      );
      return proof === null ? [] : [candidate.capsule.object_id];
    });
  }

  private readQualificationInputs(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): QualificationInputs {
    const candidates = readEvidenceCandidates(
      this.statementHolder.active().findEvidenceRows.all(
        workspaceId,
        JSON.stringify(evidenceObjectIds)
      ) as EvidenceQualificationRow[],
      {
        strictParse: this.strictParse,
        recordSkip: () => {
          this.parseSkipCount += 1;
        }
      }
    );
    const signalIds = [...new Set(candidates.flatMap((candidate) =>
      candidate.signalId === null ? [] : [candidate.signalId]
    ))];
    const signals = readSignals(this.statementHolder.active().findSignalRows.all(
      workspaceId,
      JSON.stringify(signalIds)
    ) as StoredSignalRow[]);
    const events = groupEvents(this.statementHolder.active().findMaterializationRows.all(
      workspaceId,
      JSON.stringify(signalIds),
      SignalEventType.SOUL_SIGNAL_MATERIALIZED
    ) as StoredMaterializationRow[]);
    return { candidates, signals, events };
  }
}
interface EvidenceParseSink {
  readonly strictParse: boolean;
  recordSkip(): void;
}
function readEvidenceCandidates(
  rows: readonly EvidenceQualificationRow[],
  parse: EvidenceParseSink
): readonly EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  for (const row of rows) {
    const candidate = readEvidenceCandidate(row, parse);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}

function readEvidenceCandidate(
  row: EvidenceQualificationRow,
  parse: EvidenceParseSink
): EvidenceCandidate | null {
  try {
    const capsule = parseEvidenceCapsuleRow(row);
    const signalId = row.source_signal_id ?? readGardenSourceTurnFallbackArtifactSignalId(
      capsule.physical_anchor?.artifact_ref ?? null
    );
    const factFrameFormation = readFactFrameFormation(row, capsule);
    const semanticFactorFormation = readSemanticFactorFormation(
      row, capsule, factFrameFormation
    );
    return matchesEvidenceEnvelope(capsule)
      ? {
          capsule,
          signalId,
          ...(semanticFactorFormation === undefined ? {} : { semanticFactorFormation }),
          ...(factFrameFormation === undefined ? {} : { factFrameFormation })
        }
      : null;
  } catch (error) {
    if (error instanceof EvidenceProjectionIntegrityError) throw error;
    parse.recordSkip();
    if (parse.strictParse) throw error;
    process.emitWarning("evidence candidate parse failed; skipping row", {
      code: "ALAYA_EVIDENCE_CANDIDATE_PARSE_FAILED",
      detail: JSON.stringify({
        layer: "storage",
        object_id: row.object_id,
        error: error instanceof Error ? error.message : "unknown"
      })
    });
    return null;
  }
}

function readFactFrameFormation(
  row: EvidenceQualificationRow,
  capsule: Readonly<EvidenceCapsule>
): Readonly<EvidenceFactFrameFormationCapture> | undefined {
  if (capsule.source_hash === null) return undefined;
  try {
    return readStoredFactFrameFormation(row, capsule.workspace_id, capsule.source_hash);
  } catch (error) {
    throw new EvidenceProjectionIntegrityError(
      capsule.object_id,
      error instanceof Error ? error.message : "invalid fact-frame formation capture"
    );
  }
}

function readSemanticFactorFormation(
  row: EvidenceQualificationRow,
  capsule: Readonly<EvidenceCapsule>,
  factFrame: Readonly<EvidenceFactFrameFormationCapture> | undefined
): Readonly<OpenSemanticFactorFormationCapture> | undefined {
  try {
    return readStoredSemanticFactorFormation(
      row,
      capsule.workspace_id,
      capsule.excerpt,
      factFrame
    );
  } catch (error) {
    throw new EvidenceProjectionIntegrityError(
      capsule.object_id,
      error instanceof Error ? error.message : "invalid semantic factor formation capture"
    );
  }
}

function matchesEvidenceEnvelope(capsule: Readonly<EvidenceCapsule>): boolean {
  return capsule.lifecycle_state === "active" &&
    capsule.created_by === "garden_compile" &&
    capsule.evidence_health_state === "verified" &&
    capsule.evidence_kind === "conversation_excerpt";
}
function readSignals(
  rows: readonly StoredSignalRow[]
): ReadonlyMap<string, Readonly<CandidateMemorySignal>> {
  const signals = new Map<string, Readonly<CandidateMemorySignal>>();
  for (const row of rows) {
    const signal = readSignal(row);
    if (signal !== null) signals.set(signal.signal_id, signal);
  }
  return signals;
}

function readSignal(row: StoredSignalRow): Readonly<CandidateMemorySignal> | null {
  const parsed = CandidateMemorySignalSchema.safeParse({
    signal_id: row.signal_id,
    workspace_id: row.workspace_id,
    run_id: row.run_id,
    surface_id: row.surface_id,
    source: row.source,
    signal_kind: row.signal_kind,
    object_kind: row.object_kind,
    scope_hint: row.scope_hint,
    domain_tags: parseJson(row.domain_tags_json, "domain_tags_json"),
    confidence: row.confidence,
    evidence_refs: parseJson(row.evidence_refs_json, "evidence_refs_json"),
    source_memory_refs: parseJson(row.source_memory_refs_json, "source_memory_refs_json"),
    supersedes_refs: parseJson(row.supersedes_refs_json, "supersedes_refs_json"),
    exception_to_refs: parseJson(row.exception_to_refs_json, "exception_to_refs_json"),
    contradicts_refs: parseJson(row.contradicts_refs_json, "contradicts_refs_json"),
    incompatible_with_refs: parseJson(row.incompatible_with_refs_json, "incompatible_with_refs_json"),
    raw_payload: parseJson(row.raw_payload_json, "raw_payload_json"),
    source_observation: parseJson(row.source_observation_json, "source_observation_json"),
    signal_state: row.signal_state,
    created_at: row.created_at,
    ...(row.source_delivery_ids_json === null
      ? {}
      : { source_delivery_ids: parseJson(row.source_delivery_ids_json, "source_delivery_ids_json") })
  });
  return parsed.success && parsed.data.signal_state === "materialized"
    ? parsed.data
    : null;
}

function groupEvents(
  rows: readonly StoredMaterializationRow[]
): ReadonlyMap<string, readonly StoredMaterializationRow[]> {
  const grouped = new Map<string, StoredMaterializationRow[]>();
  for (const row of rows) {
    const current = grouped.get(row.entity_id);
    if (current === undefined) grouped.set(row.entity_id, [row]);
    else current.push(row);
  }
  return grouped;
}

function readQualifiedProof(
  candidate: EvidenceCandidate,
  signal: Readonly<CandidateMemorySignal> | undefined,
  events: ReadonlyMap<string, readonly StoredMaterializationRow[]>,
  strictProjection: boolean,
  resolveAssertionLocator: VerifiedAssertionLocatorResolver | undefined
): Readonly<QualifiedEvidenceProof> | null {
  if (parseVerifiedUserAssertionSourceHash(candidate.capsule.source_hash) !== null) {
    const materializations = candidate.signalId === null ? [] : events.get(candidate.signalId) ?? [];
    return signal !== undefined && matchesVerifiedAssertionReceipt({
      capsule: candidate.capsule,
      signalId: candidate.signalId,
      signal,
      resolveAssertionLocator
    }) &&
      materializations.length === 1 &&
      matchesMaterialization(materializations[0]!, candidate, signal)
        ? Object.freeze({ turnReceipt: null })
        : rejectProof(candidate, strictProjection);
  }
  if (candidate.signalId === null) return null;
  if (signal === undefined) return null;
  const receipt = verifyGardenSourceTurnFallbackReceipt(signal, sha256);
  if (receipt === null) return null;
  if (!matchesReceipt(candidate, receipt)) {
    return rejectProof(candidate, strictProjection);
  }
  const materializations = events.get(candidate.signalId) ?? [];
  return materializations.length === 1 &&
    matchesMaterialization(materializations[0]!, candidate, receipt)
    ? Object.freeze({ turnReceipt: receipt })
    : null;
}

function rejectProof(
  candidate: EvidenceCandidate,
  strictProjection: boolean
): null {
  if (strictProjection) {
    throw new EvidenceProjectionIntegrityError(
      candidate.capsule.object_id,
      "requested projection owner does not match its verified receipt"
    );
  }
  return null;
}

function matchesReceipt(
  candidate: EvidenceCandidate,
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt>
): boolean {
  const capsule = candidate.capsule;
  if (candidate.signalId === null) return false;
  return receipt.signal_id === candidate.signalId &&
    receipt.source_observation?.authority === "trusted_host_event" &&
    capsule.workspace_id === receipt.workspace_id &&
    capsule.run_id === receipt.run_id &&
    capsule.surface_id === receipt.surface_id &&
    capsule.gist === receipt.source_corpus &&
    matchesReceiptSourceHash(capsule, receipt);
}

function matchesReceiptSourceHash(
  capsule: Readonly<EvidenceCapsule>,
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt>
): boolean {
  const expected = isGardenSourceTurnFallbackV2Receipt(receipt)
    ? formatGardenSourceTurnFallbackV2SourceHash(receipt.digest)
    : formatGardenSourceTurnFallbackSourceHash(receipt.digest);
  return capsule.source_hash === expected;
}

function matchesMaterialization(
  row: StoredMaterializationRow,
  candidate: EvidenceCandidate,
  identity: Readonly<Pick<CandidateMemorySignal, "signal_id" | "workspace_id" | "run_id">>
): boolean {
  if (candidate.signalId === null) return false;
  const payload = SoulSignalMaterializedPayloadSchema.safeParse(
    parseJson(row.payload_json, "payload_json")
  );
  if (!payload.success) return false;
  const created = payload.data.created_objects;
  const matchingEvidence = created.filter((object) =>
    object.object_kind === "evidence_capsule" &&
    object.object_id === candidate.capsule.object_id
  );
  return row.event_type === SignalEventType.SOUL_SIGNAL_MATERIALIZED &&
    row.entity_type === "candidate_memory_signal" &&
    row.entity_id === candidate.signalId &&
    row.workspace_id === identity.workspace_id &&
    row.run_id === identity.run_id &&
    row.caused_by === "materialization_router" &&
    payload.data.signal_id === candidate.signalId &&
    payload.data.workspace_id === identity.workspace_id &&
    payload.data.run_id === identity.run_id &&
    payload.data.success === true &&
    matchingEvidence.length === 1;
}

function parseJson(value: string | null, fieldName: string): unknown {
  return parseNullableJsonColumn(value, fieldName);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
