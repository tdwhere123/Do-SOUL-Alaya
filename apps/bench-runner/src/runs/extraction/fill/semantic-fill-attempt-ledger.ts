import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import type { TransportPack } from "@do-soul/alaya-soul";
import {
  boundedArtifactEntryExists,
  readBoundedCanonicalUtf8Artifact,
  withRootBoundDirectory
} from "../cache-audit/bounded-artifact-reader.js";
import { inspectSemanticArtifact } from
  "../cache/semantic-artifact/store.js";
import {
  semanticReplayIdentityDigest,
  unwrapSemanticReplayAuthority,
  type VerifiedSemanticReplayAuthority
} from "../cache/semantic-artifact/replay-authority.js";
import {
  fsyncDirectory,
  publishBytesExclusiveDurable,
  replaceBytesDurable
} from "./manifest/durable-exclusive-publication.js";
import type { ExtractionCacheWriteLease } from "./manifest/fill-root-guard.js";
import {
  captureSemanticRunSourceAuthority,
  substrateAuthorityIdentity
} from "./semantic-fill-authority.js";
import type {
  SemanticFillAttempt,
  SemanticFillEnvelope,
  SemanticFillTask,
  SemanticFillTransportResult
} from "./semantic-fill-executor.js";
import {
  MAX_SEMANTIC_FILL_ATTEMPT_BYTES,
  SEMANTIC_FILL_ATTEMPT_SCHEMA_VERSION,
  assertDurableSemanticPack,
  assertSemanticFillAttemptEvidence,
  captureDurableSemanticResponse,
  freezeDurableSemanticPack,
  type SemanticFillDurableAttemptEvidence,
  type SemanticReservationEvidence
} from "./semantic-fill-attempt-evidence.js";
export type { SemanticFillDurableAttemptEvidence } from
  "./semantic-fill-attempt-evidence.js";

const PRIVATE_ROOT = ".semantic-fill-private";
const ATTEMPT_ROOT = "attempts";
const MAX_META_BYTES = 4 * 1024 * 1024;

interface SemanticFillLedgerMeta {
  readonly schemaVersion: 1;
  readonly scopeIdentity: string;
  readonly replayIdentityDigest: string;
  readonly transportPolicyDigest: string;
  readonly sourceAuthorityIdentity: string;
  readonly startingCacheIdentity: string;
  readonly startingOverlayIdentity: string;
  readonly maxCalls: number;
  readonly maxFailures: number;
  readonly plans: readonly TransportPack[];
}

export interface SemanticFillAttemptLedgerSnapshot {
  readonly calls: number;
  readonly failures: number;
}

export interface SemanticFillAttemptLedger {
  readonly plans: readonly TransportPack[];
  readonly scopeIdentity: string;
  readonly startingCacheIdentity: string;
  readonly startingOverlayIdentity: string;
  snapshot(): SemanticFillAttemptLedgerSnapshot;
  attemptFor(pack: TransportPack): SemanticFillDurableAttemptEvidence | undefined;
  sealedResponse(pack: TransportPack, requestSha256: string):
    SemanticFillDurableAttemptEvidence | undefined;
  beginAttempt(input: {
    readonly pack: TransportPack;
    readonly requestSha256: string;
    readonly reservations: readonly Readonly<{
      task: SemanticFillTask;
      token: string;
    }>[];
  }): SemanticFillDurableAttemptEvidence;
  bindResumeReservations(
    attemptOrdinal: number,
    reservations: readonly Readonly<{ task: SemanticFillTask; token: string }>[]
  ): SemanticFillDurableAttemptEvidence;
  sealResponse(
    attemptOrdinal: number,
    result: SemanticFillTransportResult
  ): SemanticFillDurableAttemptEvidence;
  markMalformedRaw(attemptOrdinal: number, reason: string): void;
  recordMemberOutcome(attemptOrdinal: number, outcome: SemanticFillAttempt): void;
  completePack(attemptOrdinal: number): void;
}

export function openSemanticFillAttemptLedger(input: {
  readonly root: string;
  readonly tasks: readonly SemanticFillTask[];
  readonly envelope: SemanticFillEnvelope;
  readonly replayAuthority: VerifiedSemanticReplayAuthority;
  readonly plans: readonly TransportPack[];
  readonly lease: ExtractionCacheWriteLease;
  readonly startingCacheIdentity: string;
  readonly startingOverlayIdentity: string;
}): SemanticFillAttemptLedger {
  input.lease.assertOwned();
  input.lease.assertRoot(input.root);
  const expected = expectedMeta(input);
  assertSoleLedgerScope(input.root, expected.scopeIdentity);
  const opened = withLedgerDirectory(
    input.root, expected.scopeIdentity, true, (directory, temporary) => {
      const metaPath = `${directory}/ledger.json`;
      const meta = boundedArtifactEntryExists(metaPath)
        ? readMeta(metaPath)
        : publishMeta(metaPath, temporary, expected);
      assertMetaBound(meta, expected);
      return { meta, records: readAttemptRecords(directory, meta.scopeIdentity) };
    }
  );
  const persist = (record: SemanticFillDurableAttemptEvidence): void => {
    input.lease.assertOwned();
    input.lease.assertRoot(input.root);
    assertSemanticFillAttemptEvidence(record, opened.meta.scopeIdentity);
    withLedgerDirectory(input.root, opened.meta.scopeIdentity, false, (directory, temporary) => {
      replaceBytesDurable({
        destination: attemptPath(directory, record.ordinal),
        bytes: serialize(record),
        ownerIdentity: `${opened.meta.scopeIdentity}:${record.ordinal}:${input.lease.generation}`,
        temporaryDirectory: temporary
      });
    });
    opened.records.set(record.ordinal, record);
  };
  reconcileDurableAdmissions(input.root, opened.records, persist);
  return createLedgerHandle(input, opened.meta, opened.records, persist);
}

export function readSemanticFillAttemptEvidence(
  root: string
): readonly SemanticFillDurableAttemptEvidence[] {
  try {
    return withRootBoundDirectory({
      root, segments: [PRIVATE_ROOT, ATTEMPT_ROOT], label: "semantic fill private attempts"
    }, (attemptRoot) => {
      const records: SemanticFillDurableAttemptEvidence[] = [];
      for (const scope of readdirSync(attemptRoot, { withFileTypes: true })) {
        if (!scope.isDirectory() || scope.isSymbolicLink() || !isDigest(scope.name)) {
          throw new Error("semantic fill private attempt root contains a foreign entry");
        }
        withRootBoundDirectory({
          root: attemptRoot, segments: [scope.name], label: "semantic fill attempt scope"
        }, (directory) => records.push(...readAttemptRecords(directory, scope.name).values()));
      }
      return Object.freeze(records.sort((left, right) =>
        left.scopeIdentity.localeCompare(right.scopeIdentity) || left.ordinal - right.ordinal));
    });
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return [];
    throw cause;
  }
}

function createLedgerHandle(
  input: Parameters<typeof openSemanticFillAttemptLedger>[0],
  meta: SemanticFillLedgerMeta,
  records: Map<number, SemanticFillDurableAttemptEvidence>,
  persist: (record: SemanticFillDurableAttemptEvidence) => void
): SemanticFillAttemptLedger {
  const snapshot = (): SemanticFillAttemptLedgerSnapshot => ({
    calls: records.size,
    failures: [...records.values()].filter((attempt) =>
      attempt.response?.kind === "failure" || attempt.response?.kind === "malformed_raw").length
  });
  const handle: SemanticFillAttemptLedger = {
    plans: Object.freeze(meta.plans.map(freezeDurableSemanticPack)),
    scopeIdentity: meta.scopeIdentity,
    startingCacheIdentity: meta.startingCacheIdentity,
    startingOverlayIdentity: meta.startingOverlayIdentity,
    snapshot,
    attemptFor: (pack) => [...records.values()].reverse().find((attempt) =>
      attempt.pack.pack_id === pack.pack_id),
    sealedResponse: (pack, requestSha256) => {
      const sealed = [...records.values()].filter((attempt) =>
        attempt.pack.pack_id === pack.pack_id && attempt.response !== undefined);
      return sealed.find((attempt) => attempt.requestSha256 === requestSha256) ??
        sealed.at(-1);
    },
    beginAttempt: ({ pack, requestSha256, reservations }) => {
      if ([...records.values()].some((attempt) => attempt.pack.pack_id === pack.pack_id)) {
        throw new Error("semantic fill pack already has a durable attempt");
      }
      const totals = snapshot();
      if (totals.calls >= meta.maxCalls || totals.failures >= meta.maxFailures) {
        throw new Error("semantic fill durable stop-loss budget is exhausted");
      }
      const ordinal = records.size + 1;
      const record: SemanticFillDurableAttemptEvidence = {
        schemaVersion: SEMANTIC_FILL_ATTEMPT_SCHEMA_VERSION,
        scopeIdentity: meta.scopeIdentity,
        ordinal,
        pack: freezeDurableSemanticPack(pack),
        requestSha256,
        writerGeneration: input.lease.generation,
        reservationHistory: Object.freeze([
          reservationEvidence(input.lease.generation, reservations)
        ]),
        memberOutcomes: Object.freeze([]),
        packComplete: false
      };
      assertSemanticFillAttemptEvidence(record, meta.scopeIdentity);
      withLedgerDirectory(input.root, meta.scopeIdentity, false, (directory, temporary) => {
        publishBytesExclusiveDurable({
          destination: attemptPath(directory, ordinal),
          bytes: serialize(record),
          ownerIdentity: `${meta.scopeIdentity}:${ordinal}:${input.lease.generation}`,
          temporaryDirectory: temporary
        });
      });
      records.set(ordinal, record);
      return record;
    },
    bindResumeReservations: (ordinal, reservations) => {
      const current = requireRecord(records, ordinal);
      const next = {
        ...current,
        reservationHistory: Object.freeze([
          ...current.reservationHistory,
          reservationEvidence(input.lease.generation, reservations)
        ])
      };
      persist(next);
      return next;
    },
    sealResponse: (ordinal, result) => {
      const current = requireRecord(records, ordinal);
      if (current.response !== undefined) throw new Error("semantic transport response is already sealed");
      const next = { ...current, response: captureDurableSemanticResponse(result) };
      persist(next);
      return next;
    },
    markMalformedRaw: (ordinal, reason) => {
      const current = requireRecord(records, ordinal);
      if (current.response?.kind !== "raw") {
        throw new Error("only sealed raw evidence can be marked malformed");
      }
      persist({ ...current, response: { ...current.response, kind: "malformed_raw", reason } });
    },
    recordMemberOutcome: (ordinal, outcome) => {
      const current = requireRecord(records, ordinal);
      const existing = current.memberOutcomes.find((candidate) =>
        candidate.semanticKey === outcome.semanticKey && candidate.capability === outcome.capability);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(outcome)) {
          throw new Error("semantic attempt member outcome changed after durable completion");
        }
        return;
      }
      persist({
        ...current,
        memberOutcomes: Object.freeze([...current.memberOutcomes, Object.freeze({ ...outcome })])
      });
    },
    completePack: (ordinal) => {
      const current = requireRecord(records, ordinal);
      if (!current.packComplete) persist({ ...current, packComplete: true });
    }
  };
  return Object.freeze(handle);
}

function expectedMeta(
  input: Parameters<typeof openSemanticFillAttemptLedger>[0]
): SemanticFillLedgerMeta {
  const replayDigest = semanticReplayIdentityDigest(
    unwrapSemanticReplayAuthority(input.replayAuthority)
  );
  const policyDigest = digest(JSON.stringify(input.envelope.transportPolicy));
  const sourceAuthorityIdentity = substrateAuthorityIdentity(
    captureSemanticRunSourceAuthority(input.tasks).substrateManifest
  );
  // Procfd paths change per acquisition; durable scope is the leased directory.
  const scopeIdentity = digest([
    "alaya.semantic_fill_ledger_scope.v1",
    digest(`${input.lease.rootIdentity.device}:${input.lease.rootIdentity.inode}`),
    replayDigest,
    policyDigest,
    sourceAuthorityIdentity,
    String(input.envelope.maxCalls),
    String(input.envelope.maxFailures)
  ].join("\u0000"));
  return {
    schemaVersion: SEMANTIC_FILL_ATTEMPT_SCHEMA_VERSION,
    scopeIdentity,
    replayIdentityDigest: replayDigest,
    transportPolicyDigest: policyDigest,
    sourceAuthorityIdentity,
    startingCacheIdentity: input.startingCacheIdentity,
    startingOverlayIdentity: input.startingOverlayIdentity,
    maxCalls: input.envelope.maxCalls,
    maxFailures: input.envelope.maxFailures,
    plans: Object.freeze(input.plans.map(freezeDurableSemanticPack))
  };
}

function publishMeta(
  path: string,
  temporaryDirectory: string,
  meta: SemanticFillLedgerMeta
): SemanticFillLedgerMeta {
  publishBytesExclusiveDurable({
    destination: path,
    bytes: serialize(meta),
    ownerIdentity: meta.scopeIdentity,
    temporaryDirectory
  });
  return readMeta(path);
}

function readMeta(path: string): SemanticFillLedgerMeta {
  const parsed = JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: MAX_META_BYTES, label: "semantic fill attempt ledger metadata"
  })) as SemanticFillLedgerMeta;
  assertMeta(parsed);
  return parsed;
}

function readAttemptRecords(
  directory: string,
  scopeIdentity: string
): Map<number, SemanticFillDurableAttemptEvidence> {
  const records = new Map<number, SemanticFillDurableAttemptEvidence>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "ledger.json") continue;
    const matched = /^attempt-(\d{12})\.json$/u.exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || matched === null) {
      throw new Error("semantic fill attempt scope contains a foreign entry");
    }
    const parsed = JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: `${directory}/${entry.name}`,
      maxBytes: MAX_SEMANTIC_FILL_ATTEMPT_BYTES,
      label: "semantic fill durable attempt evidence"
    })) as SemanticFillDurableAttemptEvidence;
    assertSemanticFillAttemptEvidence(parsed, scopeIdentity);
    if (Number(matched[1]) !== parsed.ordinal || records.has(parsed.ordinal)) {
      throw new Error("semantic fill attempt ordinal path mismatch");
    }
    records.set(parsed.ordinal, parsed);
  }
  const ordinals = [...records.keys()].sort((left, right) => left - right);
  if (ordinals.some((ordinal, index) => ordinal !== index + 1)) {
    throw new Error("semantic fill durable attempt ordinals are not contiguous");
  }
  return new Map(ordinals.map((ordinal) => [ordinal, records.get(ordinal)!]));
}

function reconcileDurableAdmissions(
  root: string,
  records: Map<number, SemanticFillDurableAttemptEvidence>,
  persist: (record: SemanticFillDurableAttemptEvidence) => void
): void {
  for (const record of records.values()) {
    if (record.response?.kind !== "raw") continue;
    let current = record;
    for (const reservation of record.reservationHistory[0]?.members ?? []) {
      if (current.memberOutcomes.some((outcome) => outcome.semanticKey === reservation.semanticKey &&
          outcome.capability === reservation.capability)) continue;
      const artifact = inspectSemanticArtifact(root, reservation.semanticKey, reservation.capability);
      let recovered: SemanticFillAttempt | undefined;
      if (artifact.status === "provider_backed") {
        recovered = {
          semanticKey: reservation.semanticKey,
          capability: reservation.capability,
          outcome: "admitted"
        };
      } else if (artifact.status === "quarantined") {
        recovered = {
          semanticKey: reservation.semanticKey,
          capability: reservation.capability,
          outcome: "unresolved",
          reason: artifact.reason ?? "quarantined provider result"
        };
      }
      if (recovered !== undefined) {
        current = {
          ...current,
          memberOutcomes: Object.freeze([...current.memberOutcomes, Object.freeze(recovered)])
        };
        persist(current);
      }
    }
    const expectedMembers = record.reservationHistory[0]?.members.length ?? 0;
    if (!current.packComplete && current.memberOutcomes.length === expectedMembers) {
      persist({ ...current, packComplete: true });
    }
  }
}

function reservationEvidence(
  writerGeneration: string,
  reservations: readonly Readonly<{ task: SemanticFillTask; token: string }>[]
): SemanticReservationEvidence {
  return Object.freeze({
    writerGeneration,
    members: Object.freeze(reservations.map((held) => Object.freeze({
      semanticKey: held.task.semanticKey,
      capability: held.task.capability,
      tokenSha256: digest(held.token)
    })))
  });
}

function assertMetaBound(meta: SemanticFillLedgerMeta, expected: SemanticFillLedgerMeta): void {
  assertMeta(meta);
  if (meta.scopeIdentity !== expected.scopeIdentity ||
      meta.replayIdentityDigest !== expected.replayIdentityDigest ||
      meta.transportPolicyDigest !== expected.transportPolicyDigest ||
      meta.sourceAuthorityIdentity !== expected.sourceAuthorityIdentity ||
      meta.maxCalls !== expected.maxCalls || meta.maxFailures !== expected.maxFailures) {
    throw new Error("semantic fill durable budget or execution scope cannot widen or reset");
  }
}

function assertMeta(meta: SemanticFillLedgerMeta): void {
  if (meta.schemaVersion !== SEMANTIC_FILL_ATTEMPT_SCHEMA_VERSION || !isDigest(meta.scopeIdentity) ||
      !isDigest(meta.replayIdentityDigest) ||
      !isDigest(meta.transportPolicyDigest) || !isDigest(meta.sourceAuthorityIdentity) ||
      !isDigest(meta.startingCacheIdentity) || !isDigest(meta.startingOverlayIdentity) ||
      !isBudget(meta.maxCalls) ||
      !isBudget(meta.maxFailures) || !Array.isArray(meta.plans)) {
    throw new Error("semantic fill attempt ledger metadata is invalid");
  }
  for (const pack of meta.plans) assertDurableSemanticPack(pack);
}

function assertSoleLedgerScope(root: string, scopeIdentity: string): void {
  try {
    withRootBoundDirectory({
      root, segments: [PRIVATE_ROOT, ATTEMPT_ROOT], label: "semantic fill private attempts"
    }, (attemptRoot) => {
      for (const entry of readdirSync(attemptRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !isDigest(entry.name)) {
          throw new Error("semantic fill private attempt root contains a foreign entry");
        }
        if (entry.name !== scopeIdentity) {
          throw new Error("semantic fill durable budget or execution scope cannot widen or reset");
        }
      }
    });
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return;
    throw cause;
  }
}

function withLedgerDirectory<T>(
  root: string,
  scopeIdentity: string,
  create: boolean,
  operation: (directory: string, temporaryDirectory: string) => T
): T {
  const label = "semantic fill private attempt scope";
  return withRootBoundDirectory({ root, label }, (stableRoot) =>
    withRootBoundDirectory({
      root: stableRoot, segments: [PRIVATE_ROOT], createSegments: create, label
    }, (privateRoot) => withRootBoundDirectory({
      root: privateRoot, segments: [ATTEMPT_ROOT], createSegments: create, label
    }, (attemptRoot) => withRootBoundDirectory({
      root: attemptRoot, segments: [scopeIdentity], createSegments: create, label
    }, (directory) => withRootBoundDirectory({
      root: stableRoot, segments: [".tmp"], createSegments: true,
      label: "semantic fill private attempt publication"
    }, (temporary) => {
      const result = operation(directory, temporary);
      if (create) {
        for (const durableDirectory of [directory, attemptRoot, privateRoot, stableRoot]) {
          fsyncDirectory(durableDirectory);
        }
      }
      return result;
    })))));
}

function requireRecord(
  records: ReadonlyMap<number, SemanticFillDurableAttemptEvidence>,
  ordinal: number
): SemanticFillDurableAttemptEvidence {
  const record = records.get(ordinal);
  if (record === undefined) throw new Error("semantic fill durable attempt is missing");
  return record;
}

function attemptPath(directory: string, ordinal: number): string {
  return `${directory}/attempt-${String(ordinal).padStart(12, "0")}.json`;
}

function serialize(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function isBudget(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function hasCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}
