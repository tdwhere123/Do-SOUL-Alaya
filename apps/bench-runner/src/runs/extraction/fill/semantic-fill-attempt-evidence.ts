import { createHash } from "node:crypto";
import type { TransportPack } from "@do-soul/alaya-soul";
import { SEMANTIC_ARTIFACT_MAX_BYTES } from
  "../cache/semantic-artifact/contract.js";
import type {
  SemanticFillAttempt,
  SemanticFillTransportResult
} from "./semantic-fill-executor.js";

export const SEMANTIC_FILL_ATTEMPT_SCHEMA_VERSION = 1;
export const MAX_SEMANTIC_FILL_ATTEMPT_BYTES =
  (SEMANTIC_ARTIFACT_MAX_BYTES * 8) + (64 * 1024);

export type SemanticReservationEvidence = Readonly<{
  writerGeneration: string;
  members: readonly Readonly<{
    semanticKey: string;
    capability: string;
    tokenSha256: string;
  }>[];
}>;

export type DurableSemanticTransportResponse =
  | Readonly<{
      kind: "raw";
      rawUtf8: string;
      rawSha256: string;
      rawBytes: number;
    }>
  | Readonly<{
      kind: "malformed_raw";
      reason: string;
      rawUtf8: string;
      rawSha256: string;
      rawBytes: number;
    }>
  | Readonly<{ kind: "failure"; reason: string }>
  | Readonly<{ kind: "size_failure"; reason: string }>;

export interface SemanticFillDurableAttemptEvidence {
  readonly schemaVersion: 1;
  readonly scopeIdentity: string;
  readonly ordinal: number;
  readonly pack: TransportPack;
  readonly requestSha256: string;
  readonly writerGeneration: string;
  readonly reservationHistory: readonly SemanticReservationEvidence[];
  readonly response?: DurableSemanticTransportResponse;
  readonly memberOutcomes: readonly SemanticFillAttempt[];
  readonly packComplete: boolean;
}

export function captureDurableSemanticResponse(
  result: SemanticFillTransportResult
): DurableSemanticTransportResponse {
  if (result.kind !== "raw") return Object.freeze({ kind: result.kind, reason: result.reason });
  const bytes = Buffer.from(result.rawJson, "utf8");
  const rawSha256 = digestBytes(bytes);
  const canonical = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (bytes.byteLength > SEMANTIC_ARTIFACT_MAX_BYTES || canonical !== result.rawJson) {
    const reason = bytes.byteLength > SEMANTIC_ARTIFACT_MAX_BYTES
      ? "raw artifact exceeds its size limit"
      : "raw artifact UTF-8 bytes are not canonical";
    return Object.freeze({
      kind: "malformed_raw",
      reason,
      rawUtf8: bytes.subarray(0, SEMANTIC_ARTIFACT_MAX_BYTES).toString("utf8"),
      rawSha256,
      rawBytes: bytes.byteLength
    });
  }
  return Object.freeze({
    kind: "raw", rawUtf8: result.rawJson, rawSha256, rawBytes: bytes.byteLength
  });
}

export function assertSemanticFillAttemptEvidence(
  record: SemanticFillDurableAttemptEvidence,
  scopeIdentity: string
): void {
  if (record.schemaVersion !== SEMANTIC_FILL_ATTEMPT_SCHEMA_VERSION ||
      record.scopeIdentity !== scopeIdentity || !Number.isSafeInteger(record.ordinal) ||
      record.ordinal < 1 || !isDigest(record.requestSha256) ||
      typeof record.writerGeneration !== "string" || record.writerGeneration.length === 0 ||
      !Array.isArray(record.reservationHistory) || record.reservationHistory.length === 0 ||
      !Array.isArray(record.memberOutcomes) || typeof record.packComplete !== "boolean" ||
      (record.packComplete && record.response === undefined)) {
    throw new Error("semantic fill durable attempt evidence is invalid");
  }
  assertDurableSemanticPack(record.pack);
  if (record.response !== undefined) assertResponse(record.response);
  for (const reservation of record.reservationHistory) {
    if (typeof reservation.writerGeneration !== "string" ||
        reservation.writerGeneration.length === 0 || !Array.isArray(reservation.members) ||
        reservation.members.some((member: SemanticReservationEvidence["members"][number]) =>
          !isDigest(member.semanticKey) || typeof member.capability !== "string" ||
          member.capability.length === 0 || !isDigest(member.tokenSha256))) {
      throw new Error("semantic fill durable reservation evidence is invalid");
    }
  }
  const initiallyReserved = new Set(record.reservationHistory[0]!.members.map(
    (member: SemanticReservationEvidence["members"][number]) =>
      `${member.semanticKey}\u0000${member.capability}`));
  const completed = new Set<string>();
  for (const outcome of record.memberOutcomes) {
    const memberIdentity = `${outcome.semanticKey}\u0000${outcome.capability}`;
    if (!isDigest(outcome.semanticKey) || typeof outcome.capability !== "string" ||
        outcome.capability.length === 0 || !initiallyReserved.has(memberIdentity) ||
        completed.has(memberIdentity) ||
        !["admitted", "unresolved", "skipped", "failed"].includes(outcome.outcome) ||
        ((outcome.outcome === "admitted" || outcome.outcome === "skipped")
          ? outcome.reason !== undefined
          : typeof outcome.reason !== "string" || outcome.reason.length === 0)) {
      throw new Error("semantic fill durable member outcome is invalid");
    }
    completed.add(memberIdentity);
  }
}

export function assertDurableSemanticPack(pack: TransportPack): void {
  if (!isDigest(pack.pack_id) ||
      !["reference_batch", "reference_batch_8", "token_aware"].includes(pack.policy_kind) ||
      !Array.isArray(pack.assertion_ids) || !Array.isArray(pack.semantic_keys) ||
      pack.assertion_ids.length !== pack.semantic_keys.length ||
      pack.assertion_ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      pack.semantic_keys.some((key) => !isDigest(key))) {
    throw new Error("semantic fill durable pack identity is invalid");
  }
}

export function freezeDurableSemanticPack(pack: TransportPack): TransportPack {
  return Object.freeze({
    pack_id: pack.pack_id,
    policy_kind: pack.policy_kind,
    assertion_ids: Object.freeze([...pack.assertion_ids]),
    semantic_keys: Object.freeze([...pack.semantic_keys])
  });
}

function assertResponse(response: DurableSemanticTransportResponse): void {
  if (response.kind === "failure" || response.kind === "size_failure") {
    if (typeof response.reason !== "string" || response.reason.length === 0) {
      throw new Error("semantic fill durable failure evidence is invalid");
    }
    return;
  }
  if (!isDigest(response.rawSha256) || !Number.isSafeInteger(response.rawBytes) ||
      response.rawBytes < 0 || typeof response.rawUtf8 !== "string" ||
      (response.kind === "malformed_raw" &&
        (typeof response.reason !== "string" || response.reason.length === 0))) {
    throw new Error("semantic fill durable raw evidence is invalid");
  }
  const bytes = Buffer.from(response.rawUtf8, "utf8");
  const completeRawWasPersisted = response.kind === "raw" ||
    response.rawBytes <= SEMANTIC_ARTIFACT_MAX_BYTES;
  if (completeRawWasPersisted && (bytes.byteLength !== response.rawBytes ||
      digestBytes(bytes) !== response.rawSha256)) {
    throw new Error("semantic fill durable raw evidence digest mismatch");
  }
  if (!completeRawWasPersisted && bytes.byteLength > SEMANTIC_ARTIFACT_MAX_BYTES) {
    throw new Error("semantic fill durable bounded raw evidence is oversized");
  }
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
