import { createHash } from "node:crypto";
import {
  AlayaError, HostSessionCaptureRequestSchema, hostSessionContainerKey, hostSessionRoundSource, pairHostSessionRounds,
  type HostScopedReference, type HostSessionCaptureResponse, type HostSessionMessage, type SourceAdmissionContext,
  type SourceAdmissionPort, type SourceAdmissionRequest, type SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import {
  appendSourceRecordAdmitted, createSourceAdmissionPort, deriveAddressableSpanViews, fieldContractSha256,
  retainedSourceSpeaker, type FieldFormationStores
} from "@do-soul/alaya-core";
import type { HostSessionLedger, HostSessionLedgerMessage, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
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
  eventLogRepo: Parameters<typeof appendSourceRecordAdmitted>[0];
  runtimeNotifier: Parameters<typeof appendSourceRecordAdmitted>[2];
  gardenTaskRepo: SqliteGardenTaskRepo;
  now: () => string;
  warn: (message: string, meta: Record<string, unknown>) => void;
}>): HostSessionCapture {
  return createHostSessionCapture({
    admission: createSourceAdmissionPort({ sha256: fieldContractSha256, stores: input.stores,
      audit: record => appendSourceRecordAdmitted(input.eventLogRepo, record, input.runtimeNotifier) }),
    ledger: input.gardenTaskRepo.hostSessions, statementSessions: input.gardenTaskRepo, now: input.now, warn: input.warn
  });
}

const SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_CONTAINERS_PER_PASS = 32;

export function createHostSessionCapture(ports: HostSessionCapturePorts): HostSessionCapture {
  if (ports.admission.audit === undefined || ports.admission.findRetained === undefined) {
    throw new AlayaError("UNAVAILABLE", "host session capture requires receipt-first audited admission with replay recovery");
  }
  return {
    async capture(input) {
      const request = HostSessionCaptureRequestSchema.parse(input.request);
      const key = hostSessionContainerKey(request.container, fieldContractSha256);
      const counts = admitMessages(ports, { ...input, key, container: request.container, messages: request.messages });
      const closesTail = request.closes_tail === true;
      const rounds = await formRounds(ports, { workspaceId: input.workspaceId, key, closesTail, issuer: input.issuer });
      closeStatementChunks(ports, input.workspaceId, key, closesTail);
      return { container_key: key, admitted_message_count: counts.admitted, replayed_message_count: counts.replayed,
        pending_message_count: ports.ledger.openTail(input.workspaceId, key).length, admitted_round_count: rounds };
    },
    async sweepIdle(issuer) {
      const nowMs = Date.parse(ports.now());
      const idle = ports.ledger.idleContainers(new Date(nowMs - STATEMENT_SESSION_IDLE_MS).toISOString(),
        new Date(nowMs - SWEEP_WINDOW_MS).toISOString(), SWEEP_CONTAINERS_PER_PASS);
      for (const container of idle) {
        try {
          const tail = ports.ledger.openTail(container.workspace_id, container.container_key);
          // Another producer's pending round needs that producer's own issuer capability.
          if (tail.every(message => message.producer === issuer.producer)) {
            await formRounds(ports, { workspaceId: container.workspace_id, key: container.container_key, closesTail: true, issuer });
          }
          closeStatementSessionChunks(ports.statementSessions, { workspaceId: container.workspace_id,
            containerKey: container.container_key, closeTail: true, now: ports.now });
        } catch (error) {
          // One container's failure must not stop other idle containers from closing.
          ports.warn("host session tail closure failed", { workspace_id: container.workspace_id,
            container_key: container.container_key, error: error instanceof Error ? error.message : String(error) });
        }
        // A tail with nothing to close stops qualifying until a newer message arrives.
        ports.ledger.markSwept(container.workspace_id, container.container_key, container.newest_message);
      }
    }
  };
}

/** Validates the whole request against the ledger, then records new messages; any conflict admits nothing. */
function admitMessages(ports: HostSessionCapturePorts, input: Readonly<{
  workspaceId: string; runId: string; key: string; container: HostScopedReference;
  messages: readonly HostSessionMessage[]; issuer: HostSessionIssuer;
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
    return { admitted, replayed };
  });
}

/** Admits every closed round of the open tail in order, then binds its messages to the admitted root. */
async function formRounds(ports: HostSessionCapturePorts, input: Readonly<{
  workspaceId: string; key: string; closesTail: boolean; issuer: HostSessionIssuer;
}>): Promise<number> {
  const tail = ports.ledger.openTail(input.workspaceId, input.key);
  const { rounds } = pairHostSessionRounds(tail, input.closesTail);
  let roundIndex = ports.ledger.nextRoundIndex(input.workspaceId, input.key);
  for (const indices of rounds) {
    const members = indices.map(index => tail[index]!);
    const record = await admitRoundRoot(ports, input.workspaceId, roundIndex, members, input.issuer);
    ports.ledger.bindRound(input.workspaceId, input.key, members.map(member => member.message_id), roundIndex, record.identity);
    roundIndex += 1;
  }
  return rounds.length;
}

async function admitRoundRoot(ports: HostSessionCapturePorts, workspaceId: string, roundIndex: number,
  members: readonly HostSessionLedgerMessage[], issuer: HostSessionIssuer): Promise<SourceRecordIdentity> {
  const first = members[0]!;
  const source = hostSessionRoundSource({ scope: first.container_scope, id: first.container_id }, first.container_key, roundIndex,
    members.map(ledgerMessage));
  const speaker = retainedSourceSpeaker(members.map(member => member.role));
  const request: SourceAdmissionRequest = {
    workspace_id: workspaceId, source_id: source.source_id, source_version: source.source_version,
    content_bytes: source.content, evidence_object_id: null, recorded_at: ports.now(), event_time: source.event_time,
    valid_from: null, valid_to: null, ...(speaker === undefined ? {} : { speaker }), scope_class: "project",
    spans: deriveAddressableSpanViews(source.content), host_occurrences: source.occurrences
  };
  const context = { workspaceId, hostCapture: issuer.binding };
  // Recovery after a crash between admission and binding replays the exact retained receipt.
  const retained = ports.admission.findRetained!(request, context);
  const record = ports.admission.admit(retained === null ? request
    : { ...request, recorded_at: retained.recorded_at, attribution_context: retained.attribution_context ?? null }, context).record;
  await ports.admission.audit!(record);
  return record;
}

function closeStatementChunks(ports: HostSessionCapturePorts, workspaceId: string, containerKey: string, closeTail: boolean): void {
  try {
    closeStatementSessionChunks(ports.statementSessions, { workspaceId, containerKey, closeTail, now: ports.now });
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

function contentDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
