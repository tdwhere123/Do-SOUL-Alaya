import {
  buildAttributedAssociativeFactKeyProjections,
  EvidenceSearchProjectionKindSchema,
  EvidenceSearchProjectionSchema,
  groundAssociativeFactFrame,
  isGardenSourceTurnFallbackV2Receipt,
  projectGardenSourceTurnFallbackV2AssistantObservations,
  projectGardenSourceTurnFallbackV2UserContent,
  readVerifiedUserAssertionSourceHashDigest,
  type EvidenceCapsule,
  type EvidenceSearchProjection,
  type AssociativeFactKeyProjectionForm,
  type CandidateMemorySignal,
  type GardenSourceTurnFallbackVerifiedReceipt
} from "@do-soul/alaya-protocol";
import type {
  EvidenceSearchMatch,
  EvidenceSearchProjectionIdentity,
  RecallQualifiedEvidence
} from "../evidence-recall-types.js";

export interface StoredProjectionRow {
  readonly evidence_object_id: string;
  readonly projection_id: number;
  readonly projection_kind: string;
  readonly workspace_id: string;
  readonly source_hash: string;
  readonly content: string;
}

interface BoundProjection {
  readonly evidenceObjectId: string;
  readonly workspaceId: string;
  readonly sourceHash: string;
  readonly projection: Readonly<EvidenceSearchProjection>;
}

interface RederivedFactKeyProjection {
  readonly projection: Readonly<EvidenceSearchProjection>;
  readonly forms: readonly Readonly<AssociativeFactKeyProjectionForm>[];
}

export type QualifiedProjectionIndex = ReadonlyMap<string, BoundProjection>;

export class EvidenceProjectionIntegrityError extends Error {
  public constructor(evidenceObjectId: string, reason: string) {
    super(`Evidence projection integrity failed for ${evidenceObjectId}: ${reason}`);
    this.name = "EvidenceProjectionIntegrityError";
  }
}

export function normalizeEvidenceSearchMatches(
  requested: readonly EvidenceSearchMatch[]
): readonly EvidenceSearchMatch[] {
  const matches = new Map<string, EvidenceSearchMatch>();
  for (const match of requested) {
    const objectId = match.object_id.trim();
    if (objectId.length === 0) continue;
    const identity = normalizeProjectionIdentity(match.matched_projection);
    if (match.matched_projection !== undefined && identity === undefined) continue;
    const normalized = Object.freeze({
      object_id: objectId,
      ...(identity === undefined ? {} : { matched_projection: identity })
    });
    matches.set(matchKey(normalized), normalized);
  }
  return Object.freeze([...matches.values()]);
}

export function readQualifiedProjectionIndex(
  rows: readonly StoredProjectionRow[]
): QualifiedProjectionIndex {
  const projections = new Map<string, BoundProjection>();
  for (const row of rows) {
    const parsed = EvidenceSearchProjectionSchema.safeParse({
      projection_id: row.projection_id,
      projection_kind: row.projection_kind,
      content: row.content
    });
    if (!parsed.success) continue;
    const bound = Object.freeze({
      evidenceObjectId: row.evidence_object_id,
      workspaceId: row.workspace_id,
      sourceHash: row.source_hash,
      projection: parsed.data
    });
    projections.set(projectionKey(row.evidence_object_id, parsed.data), bound);
  }
  return projections;
}

export function qualifyEvidenceMatch(
  match: EvidenceSearchMatch,
  capsule: Readonly<EvidenceCapsule>,
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt> | null,
  projections: QualifiedProjectionIndex,
  signal?: Readonly<CandidateMemorySignal>
): RecallQualifiedEvidence | null {
  const verifiedUserProjection = hasVerifiedUserProjection(capsule, receipt);
  if (match.matched_projection?.projection_kind === "assistant_observation") {
    const projection = rederiveAssistantProjection(
      match.matched_projection,
      capsule,
      receipt,
      projections
    );
    if (projection === null) {
      throw new EvidenceProjectionIntegrityError(
        capsule.object_id,
        "requested Assistant observation does not match its verified receipt"
      );
    }
    return Object.freeze({
      capsule,
      verified_user_projection: verifiedUserProjection,
      matched_projection: projection
    });
  }
  if (match.matched_projection?.projection_kind === "fact_key") {
    const attributed = rederiveFactKeyProjection(
      match.matched_projection,
      capsule,
      signal,
      projections
    );
    if (attributed === null) {
      throw new EvidenceProjectionIntegrityError(
        capsule.object_id,
        "requested fact key does not match its grounded Signal"
      );
    }
    return Object.freeze({
      capsule,
      verified_user_projection: verifiedUserProjection,
      matched_projection: attributed.projection,
      matched_fact_key_forms: attributed.forms
    });
  }
  if (!matchesOwnerProjection(capsule, receipt)) return null;
  return Object.freeze({
    capsule,
    verified_user_projection: verifiedUserProjection
  });
}

export function compareQualifiedProjectionIdentity(
  left: EvidenceSearchProjectionIdentity | undefined,
  right: EvidenceSearchProjectionIdentity | undefined
): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return left.projection_kind.localeCompare(right.projection_kind) ||
    left.projection_id - right.projection_id;
}

function normalizeProjectionIdentity(
  value: EvidenceSearchProjectionIdentity | undefined
): EvidenceSearchProjectionIdentity | undefined {
  if (value === undefined ||
      !Number.isInteger(value.projection_id) ||
      value.projection_id <= 0) {
    return undefined;
  }
  const kind = EvidenceSearchProjectionKindSchema.safeParse(value.projection_kind);
  return kind.success ? Object.freeze({
    projection_id: value.projection_id,
    projection_kind: kind.data
  }) : undefined;
}

function hasVerifiedUserProjection(
  capsule: Readonly<EvidenceCapsule>,
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt> | null
): boolean {
  if (!isGardenSourceTurnFallbackV2Receipt(receipt)) return false;
  const content = projectGardenSourceTurnFallbackV2UserContent(receipt);
  return content.length > 0 && capsule.excerpt === content;
}

function matchesOwnerProjection(
  capsule: Readonly<EvidenceCapsule>,
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt> | null
): boolean {
  // Assertion-family stores the distilled fact in excerpt; turn-span equality
  // would reject the display-atomic arm after its assertion proof already bound it.
  if (readVerifiedUserAssertionSourceHashDigest(capsule.source_hash) !== null) {
    return (capsule.excerpt?.trim() ?? "").length > 0;
  }
  if (receipt === null) return false;
  if (!isGardenSourceTurnFallbackV2Receipt(receipt)) {
    return capsule.excerpt === receipt.source_corpus;
  }
  const userContent = projectGardenSourceTurnFallbackV2UserContent(receipt);
  return userContent.length > 0 && capsule.excerpt === userContent;
}

function rederiveAssistantProjection(
  identity: EvidenceSearchProjectionIdentity,
  capsule: Readonly<EvidenceCapsule>,
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt> | null,
  projections: QualifiedProjectionIndex
): Readonly<EvidenceSearchProjection> | null {
  if (!isGardenSourceTurnFallbackV2Receipt(receipt)) return null;
  const content = projectGardenSourceTurnFallbackV2AssistantObservations(receipt)[
    identity.projection_id - 1
  ];
  if (content === undefined) return null;
  const stored = projections.get(projectionKey(capsule.object_id, identity));
  if (stored === undefined ||
      stored.evidenceObjectId !== capsule.object_id ||
      stored.workspaceId !== receipt.workspace_id ||
      stored.sourceHash !== capsule.source_hash ||
      stored.projection.content !== content) {
    return null;
  }
  return Object.freeze({
    projection_id: identity.projection_id,
    projection_kind: "assistant_observation",
    content
  });
}

function rederiveFactKeyProjection(
  identity: EvidenceSearchProjectionIdentity,
  capsule: Readonly<EvidenceCapsule>,
  signal: Readonly<CandidateMemorySignal> | undefined,
  projections: QualifiedProjectionIndex
): Readonly<RederivedFactKeyProjection> | null {
  if (!matchesFactKeySignalEnvelope(signal, capsule)) return null;
  const assertion = readPayloadText(signal.raw_payload.source_assertion);
  if (assertion === null || assertion !== capsule.excerpt) return null;
  const frame = groundAssociativeFactFrame(signal.raw_payload.fact_frame, assertion);
  if (frame === null) return null;
  const attributed = buildAttributedAssociativeFactKeyProjections(frame).find(
    ({ projection }) => projection.projection_id === identity.projection_id
  );
  const expected = attributed?.projection;
  const stored = projections.get(projectionKey(capsule.object_id, identity));
  if (expected === undefined || stored === undefined ||
      stored.evidenceObjectId !== capsule.object_id ||
      stored.workspaceId !== signal.workspace_id ||
      stored.sourceHash !== capsule.source_hash ||
      stored.projection.content !== expected.content) return null;
  return attributed === undefined ? null : Object.freeze(attributed);
}

function matchesFactKeySignalEnvelope(
  signal: Readonly<CandidateMemorySignal> | undefined,
  capsule: Readonly<EvidenceCapsule>
): signal is Readonly<CandidateMemorySignal> {
  if (signal === undefined || signal.source !== "garden_compile" ||
      signal.signal_state !== "materialized" ||
      signal.workspace_id !== capsule.workspace_id ||
      signal.run_id !== capsule.run_id ||
      signal.surface_id !== capsule.surface_id) return false;
  const grounding = signal.raw_payload.source_grounding;
  return typeof grounding === "object" && grounding !== null && !Array.isArray(grounding) &&
    (grounding as Record<string, unknown>).status === "grounded" &&
    (grounding as Record<string, unknown>).content_basis === "source_assertion";
}

function readPayloadText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function matchKey(match: EvidenceSearchMatch): string {
  const identity = match.matched_projection;
  return identity === undefined
    ? `${match.object_id}\u0000owner`
    : projectionKey(match.object_id, identity);
}

function projectionKey(
  evidenceObjectId: string,
  identity: EvidenceSearchProjectionIdentity
): string {
  return `${evidenceObjectId}\u0000${identity.projection_kind}\u0000${identity.projection_id}`;
}
