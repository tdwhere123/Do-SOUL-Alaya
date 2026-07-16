import {
  RecallOriginPlaneSchema,
  type RecallOriginPlane
} from "@do-soul/alaya-protocol";

export type DiagnosticObjectKind = "memory_entry" | "synthesis_capsule";
export type DiagnosticCandidateIdentityMode = "strict" | "legacy";

export interface DiagnosticCandidateIdentity {
  readonly candidateKey: string;
  readonly sourceCandidateKey: string;
  readonly objectId: string;
  readonly objectKind: DiagnosticObjectKind;
  readonly originPlane: RecallOriginPlane;
  readonly legacy: boolean;
}

export function readRecallOriginPlane(value: unknown): RecallOriginPlane | null {
  const parsed = RecallOriginPlaneSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readDiagnosticObjectKind(value: unknown): DiagnosticObjectKind | null {
  return value === "memory_entry" || value === "synthesis_capsule" ? value : null;
}

export function buildDiagnosticCandidateKey(
  originPlane: RecallOriginPlane,
  objectKind: DiagnosticObjectKind,
  objectId: string
): string {
  return `${originPlane}:${objectKind}:${objectId}`;
}

export function buildObjectIdentityKey(objectKind: string, objectId: string): string {
  return `${objectKind}:${objectId}`;
}

export function readDiagnosticCandidateIdentity(
  record: Readonly<Record<string, unknown>>,
  mode: DiagnosticCandidateIdentityMode
): DiagnosticCandidateIdentity | null {
  const objectId = mode === "strict"
    ? readString(record.object_id)
    : readString(record.object_id) ?? readString(record.memory_id) ?? readString(record.id);
  if (objectId === null) return null;
  const objectKind = readDiagnosticObjectKind(
    mode === "legacy" ? record.object_kind ?? "memory_entry" : record.object_kind
  );
  if (objectKind === null) return null;
  if (mode === "strict") return readStrictIdentity(record, objectId, objectKind);
  const originPlane = readRecallOriginPlane(record.origin_plane) ?? "workspace_local";
  const candidateKey = buildDiagnosticCandidateKey(originPlane, objectKind, objectId);
  return {
    candidateKey,
    sourceCandidateKey: readString(record.candidate_key) ?? candidateKey,
    objectId,
    objectKind,
    originPlane,
    legacy: true
  };
}

function readStrictIdentity(
  record: Readonly<Record<string, unknown>>,
  objectId: string,
  objectKind: DiagnosticObjectKind
): DiagnosticCandidateIdentity | null {
  const originPlane = readRecallOriginPlane(record.origin_plane);
  const candidateKey = readString(record.candidate_key);
  if (originPlane === null || candidateKey === null ||
      candidateKey !== buildDiagnosticCandidateKey(originPlane, objectKind, objectId)) return null;
  return {
    candidateKey,
    sourceCandidateKey: candidateKey,
    objectId,
    objectKind,
    originPlane,
    legacy: false
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
