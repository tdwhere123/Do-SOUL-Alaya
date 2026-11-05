import { createHash } from "node:crypto";
import {
  AlayaError, HostSessionCaptureRequestSchema, hostSessionContainerKey, hostSessionRoundSource, pairHostSessionRounds,
  hashContentDigest, hashSourceRecordId, canonicalJson,
  type HostScopedReference, type HostSessionCaptureResponse, type HostSessionMessage, type SourceAdmissionContext,
  type SourceAdmissionPort, type SourceAdmissionRequest, type SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import {
  appendSourceRecordAdmitted, createSourceAdmissionPort, deriveAddressableSpanViews, fieldContractSha256,
  retainedSourceSpeaker, type FieldFormationStores
} from "@do-soul/alaya-core";
import type { HostSessionLedger, HostSessionLedgerMessage, SqliteEventLogRepo, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import {
  STATEMENT_SESSION_IDLE_MS, closeStatementSessionChunks, type StatementSessionClosurePort
} from "../statement-session/statement-session-closure.js";

/** Who asserts a container's host facts. The composition supplies it; request JSON never does. */
export type HostSessionIssuer = Readonly<{
  producer: string;
  binding: NonNullable<SourceAdmissionContext["hostCapture"]>;
}>;

export const MCP_HOST_SESSION_ISSUER: HostSessionIssuer = Object.freeze({
  producer: "mcp-host-session",
  binding: (request: SourceAdmissionRequest) => ({ namespace: "alaya", workspace_id: request.workspace_id,
    producer: "mcp-host-session", basis: "host_session" as const })
});

export type HostSessionCapturePorts = Readonly<{
  /** Receipt-first admission with exact-replay recovery and no fixed issuer. */
  admission: SourceAdmissionPort;
  ledger: HostSessionLedger;
  statementSessions: StatementSessionClosurePort;
  now: () => string;
  warn: (message: string, meta: Record<string, unknown>) => void;
}>;

export type HostSessionCapture = Readonly<{
  capture(input: Readonly<{ workspaceId: string; runId: string; request: unknown; issuer: HostSessionIssuer }>):
    Promise<HostSessionCaptureResponse>;
  /** Closes pending rounds of the issuer's idle containers, then every idle container's statement tail. */
  sweepIdle(issuer: HostSessionIssuer): Promise<void>;
}>;

/** Daemon composition: receipt-first admission over the field stores, the garden ledger and closure. */
export function createDaemonHostSessionCapture(input: Readonly<{
  stores: FieldFormationStores;
  eventLogRepo: SqliteEventLogRepo;
  runtimeNotifier: Parameters<typeof appendSourceRecordAdmitted>[2];
  gardenTaskRepo: SqliteGardenTaskRepo;
  now: () => string;
  warn: (message: string, meta: Record<string, unknown>) => void;
}>): HostSessionCapture {
  return createHostSessionCapture({
    admission: createSourceAdmissionPort({ sha256: fieldContractSha256, stores: input.stores,
      audit: createHostSessionSourceAudit(input.eventLogRepo, input.runtimeNotifier) }),
    ledger: input.gardenTaskRepo.hostSessions, statementSessions: input.gardenTaskRepo, now: input.now, warn: input.warn
  });
}

/** Ensure replay after an uncertain append or competing capture cannot append the same audit twice. */
export function createHostSessionSourceAudit(eventLogRepo: SqliteEventLogRepo,
  notifier: Parameters<typeof appendSourceRecordAdmitted>[2]): NonNullable<SourceAdmissionPort["audit"]> {
  return (record, options) => appendSourceRecordAdmitted({ append: event => eventLogRepo.transactional(() => {
    const existing = eventLogRepo.queryByEntityInCurrentTransaction(event.entity_type, event.entity_id)
      .find(row => row.workspace_id === event.workspace_id && row.event_type === event.event_type);
    if (existing !== undefined) {
      if (canonicalJson(existing.payload_json) !== canonicalJson(event.payload_json)) {
        throw new AlayaError("CONFLICT", "host session source audit differs from its retained receipt");
      }
      return existing;
    }
    const appended = eventLogRepo.append(event);
    if (appended instanceof Promise) throw new AlayaError("UNAVAILABLE", "transactional source audit must be synchronous");
    return appended;
  }) }, record, { notifyEntry: entry => {
    if (options?.notify === false || eventLogRepo.getStorageConnectionIdentity().connection.prepare(`SELECT 1
      FROM projection_erase_barriers WHERE workspace_id = ? AND subject_kind = 'source_record' AND subject_id = ?`)
      .get(record.workspace_id, record.identity) !== undefined) return;
    return notifier.notifyEntry(entry);
  } });
}

const SWEEP_CONTAINERS_PER_PASS = 32;
const SWEEP_RETRY_MS = 1000;
const RECOVERY_ROUNDS_PER_PASS = 16;

export function createHostSessionCapture(ports: HostSessionCapturePorts): HostSessionCapture {
  if (ports.admission.audit === undefined || ports.admission.findRetained === undefined || ports.admission.findReceipt === undefined) {
    throw new AlayaError("UNAVAILABLE", "host session capture requires receipt-first audited admission with replay recovery");
  }
  return {
    async capture(input) {
      const request = HostSessionCaptureRequestSchema.parse(input.request);
      const key = hostSessionContainerKey(request.container, fieldContractSha256);
      const closesTail = request.closes_tail === true;
      const counts = admitMessages(ports, { ...input, key, container: request.container, messages: request.messages, closesTail });
      const rounds = await formRounds(ports, { workspaceId: input.workspaceId, key, issuer: input.issuer });
      closeStatementChunks(ports, input.workspaceId, key);
      return { container_key: key, admitted_message_count: counts.admitted, replayed_message_count: counts.replayed,
        pending_message_count: ports.ledger.openTail(input.workspaceId, key).length, admitted_round_count: rounds,
        pending_round_count: ports.ledger.pendingRoundCount(input.workspaceId, key) };
    },
    async sweepIdle(issuer) {
      const nowMs = Date.parse(ports.now());
      const idle = ports.ledger.idleContainers(new Date(nowMs - STATEMENT_SESSION_IDLE_MS).toISOString(),
        ports.now(), issuer.producer, SWEEP_CONTAINERS_PER_PASS);
      for (const container of idle) {
        try {
          // Another producer's pending round needs that producer's own issuer capability.
          const owns = ports.ledger.producer(container.workspace_id, container.container_key) === issuer.producer;
          ports.ledger.transaction(() => {
            if (owns) reserveRounds(ports, container.workspace_id, container.container_key, true);
            ports.ledger.reserveTailBoundary(container.workspace_id, container.container_key, owns);
          });
          if (owns) await formRounds(ports, { workspaceId: container.workspace_id, key: container.container_key, issuer });
          if (owns && ports.ledger.pendingRoundCount(container.workspace_id, container.container_key) > 0) {
            ports.ledger.retrySweep(container.workspace_id, container.container_key, issuer.producer,
              new Date(nowMs + SWEEP_RETRY_MS).toISOString());
            continue;
          }
          const closure = closeStatementSessionChunks(ports.statementSessions, { workspaceId: container.workspace_id,
            containerKey: container.container_key, closeTail: false, now: ports.now });
          if (closure.more) ports.ledger.retrySweep(container.workspace_id, container.container_key, issuer.producer,
            closure.blocked ? new Date(nowMs + SWEEP_RETRY_MS).toISOString() : ports.now());
          else ports.ledger.markSwept(container.workspace_id, container.container_key, issuer.producer, container.newest_message);
        } catch (error) {
          // A failed container keeps its obligation but yields the pass to other containers.
          ports.ledger.retrySweep(container.workspace_id, container.container_key, issuer.producer,
            new Date(nowMs + SWEEP_RETRY_MS).toISOString());
          ports.warn("host session tail closure failed", { workspace_id: container.workspace_id,
            container_key: container.container_key, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  };
}

/** Validates the whole request against the ledger, then records new messages; any conflict admits nothing. */
function admitMessages(ports: HostSessionCapturePorts, input: Readonly<{
  workspaceId: string; runId: string; key: string; container: HostScopedReference;
  messages: readonly HostSessionMessage[]; issuer: HostSessionIssuer; closesTail: boolean;
}>): Readonly<{ admitted: number; replayed: number }> {
  const admittedAt = ports.now();
  return ports.ledger.transaction(() => {
    let admitted = 0, replayed = 0;
    let highest = ports.ledger.highestPosition(input.workspaceId, input.key);
    const producer = ports.ledger.producer(input.workspaceId, input.key);
    if (producer !== null && producer !== input.issuer.producer) {
      throw new AlayaError("CONFLICT", "host session container belongs to another capture producer");
    }
    for (const message of input.messages) {
      const digest = contentDigest(message.content);
      const existing = ports.ledger.find(input.workspaceId, input.key, message.message_id);
      if (existing !== null) {
        if (!sameMessage(existing, message, digest)) {
          throw new AlayaError("CONFLICT", "host message differs from the message already captured under its id");
        }
        replayed += 1;
        continue;
      }
      if (ports.ledger.atPosition(input.workspaceId, input.key, message.position) !== null) {
        throw new AlayaError("CONFLICT", "another host message already occupies this position");
      }
      // Closed rounds never change, so a message cannot be inserted before captured ones.
      if (highest !== null && message.position < highest) {
        throw new AlayaError("CONFLICT", "host message position precedes messages already captured");
      }
      ports.ledger.insert({ workspace_id: input.workspaceId, container_key: input.key, message_id: message.message_id,
        position: message.position, container_scope: input.container.scope, container_id: input.container.id,
        role: message.role, completeness: message.completeness, fidelity: message.fidelity,
        host_reported_at: message.host_reported_at ?? null, content_digest: digest, run_id: input.runId,
        producer: input.issuer.producer, admitted_at: admittedAt, pending_body: message.content });
      highest = message.position;
      admitted += 1;
    }
    reserveRounds(ports, input.workspaceId, input.key, input.closesTail);
    if (input.closesTail) ports.ledger.reserveTailBoundary(input.workspaceId, input.key, true);
    return { admitted, replayed };
  });
}

/** Reserve identities and exact members under the same write lock as message admission. */
function reserveRounds(ports: HostSessionCapturePorts, workspaceId: string, key: string, closesTail: boolean): void {
  const tail = ports.ledger.openTail(workspaceId, key);
  const { rounds } = pairHostSessionRounds(tail, closesTail);
  let roundIndex = ports.ledger.nextRoundIndex(workspaceId, key);
  for (const indices of rounds) {
    const members = indices.map(index => tail[index]!);
    const first = members[0]!;
    const source = hostSessionRoundSource({ scope: first.container_scope, id: first.container_id }, key, roundIndex,
      members.map(ledgerMessage));
    const rootId = sourceRootId(source);
    ports.ledger.reserveRound(workspaceId, key, roundIndex, rootId, members.map(member => member.message_id));
    roundIndex++;
  }
}

/** Resume only previously reserved membership, including after restart or a competing capture. */
async function formRounds(ports: HostSessionCapturePorts, input: Readonly<{
  workspaceId: string; key: string; issuer: HostSessionIssuer;
}>): Promise<number> {
  let completed = 0;
  for (const intent of ports.ledger.pendingRoundPage(input.workspaceId, input.key, RECOVERY_ROUNDS_PER_PASS)) {
    if (intent.members.length === 0 || intent.members.some(member => member.producer !== input.issuer.producer)) {
      throw new AlayaError("CONFLICT", "host session round intent has invalid members or producer");
    }
    if (intent.state === "erased_pending") {
      const record = ports.admission.findReceipt!(input.workspaceId, intent.root_id, { workspaceId: input.workspaceId });
      if (record === null) throw new AlayaError("CONFLICT", "erased host session audit receipt is unavailable");
      await ports.admission.audit!(record, { notify: false });
    } else {
      const record = await admitRoundRoot(ports, input.workspaceId, intent.round_index, intent.root_id, intent.members, input.issuer);
      if (record.identity !== intent.root_id) throw new AlayaError("CONFLICT", "host session round identity changed");
    }
    if (ports.ledger.completeRound(input.workspaceId, input.key, intent.round_index, intent.root_id) === "done") completed++;
  }
  return completed;
}

async function admitRoundRoot(ports: HostSessionCapturePorts, workspaceId: string, roundIndex: number, rootId: string,
  members: readonly HostSessionLedgerMessage[], issuer: HostSessionIssuer): Promise<SourceRecordIdentity> {
  const first = members[0]!;
  const source = hostSessionRoundSource({ scope: first.container_scope, id: first.container_id }, first.container_key, roundIndex,
    members.map(ledgerMessage));
  if (sourceRootId(source) !== rootId) throw new AlayaError("CONFLICT", "host session round intent differs from its members");
  const speaker = retainedSourceSpeaker(members.map(member => member.role));
  const request: SourceAdmissionRequest = {
    workspace_id: workspaceId, source_id: source.source_id, source_version: source.source_version,
    content_bytes: source.content, evidence_object_id: null, recorded_at: ports.now(), event_time: source.event_time,
    valid_from: null, valid_to: null, ...(speaker === undefined ? {} : { speaker }), scope_class: "project",
    spans: deriveAddressableSpanViews(source.content), host_occurrences: source.occurrences
  };
  const context = { workspaceId, hostCapture: issuer.binding };
  // The durable intent fixes members before admission; recover the exact retained receipt.
  const retained = ports.admission.findRetained!(request, context);
  const record = ports.admission.admit(retained === null ? request
    : { ...request, recorded_at: retained.recorded_at, attribution_context: retained.attribution_context ?? null }, context).record;
  await ports.admission.audit!(record);
  return record;
}

function closeStatementChunks(ports: HostSessionCapturePorts, workspaceId: string, containerKey: string): void {
  try {
    closeStatementSessionChunks(ports.statementSessions, { workspaceId, containerKey, closeTail: false, now: ports.now });
  } catch (error) {
    // The messages are already captured; a closure failure leaves the container to the idle sweep.
    ports.warn("statement session chunk closure failed", { workspace_id: workspaceId, container_key: containerKey,
      error: error instanceof Error ? error.message : String(error) });
  }
}

function ledgerMessage(row: HostSessionLedgerMessage): HostSessionMessage {
  if (row.pending_body === null) throw new AlayaError("CONFLICT", "host session round member lost its pending body");
  return { message_id: row.message_id, position: row.position, role: row.role, content: row.pending_body,
    completeness: row.completeness, fidelity: row.fidelity,
    ...(row.host_reported_at === null ? {} : { host_reported_at: row.host_reported_at }) };
}

function sameMessage(row: HostSessionLedgerMessage, message: HostSessionMessage, digest: string): boolean {
  return row.position === message.position && row.role === message.role && row.completeness === message.completeness &&
    row.fidelity === message.fidelity && row.host_reported_at === (message.host_reported_at ?? null) &&
    row.content_digest === digest;
}

function sourceRootId(source: ReturnType<typeof hostSessionRoundSource>): string {
  return hashSourceRecordId({ source_id: source.source_id, source_version: source.source_version,
    content_digest: hashContentDigest(source.content, fieldContractSha256) }, fieldContractSha256);
}

function contentDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
