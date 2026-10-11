import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson, SoulMemorySearchResponseSchema, type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { chainIdentity } from "../contract.js";
import { canonicalPath, isContainedPath } from "../../fs/opened-contained-path.js";
import { boundedArtifactEntryExists, decodeCanonicalUtf8Artifact, readBoundedStableRegularFile } from
  "../../extraction/cache-audit/bounded-artifact-reader.js";
import { readCurrentExtractionAuthorityRevision } from "../../extraction/authority/inspection.js";
import { hashRegularFileNoFollow } from "../../snapshot/bound-file.js";
import { FirstExposurePageSchema, type FirstExposurePage } from "../../measurement/first-exposure-session.js";
import { ConditionalFieldExecutionReceiptSchema, executionBindingMismatch } from "../../measurement/conditional-field-request-binding.js";
import {
  OrdinaryRecallCaptureConfigSchema, OrdinaryRecallContextSchema, OrdinaryRecallEnvelopeSchema,
  OrdinaryRecallObservationSchema, OrdinaryRecallPreparationSchema, OrdinaryRecallProcessResultSchema,
  OrdinaryRecallRequestRecordSchema, OrdinaryRecallReservationSchema, OrdinaryRecallShutdownSchema,
  OrdinaryRecallWireRecordSchema, ordinaryRecallReaderProtocolVersion, type OrdinaryRecallCaptureConfig, type OrdinaryRecallContext,
  type OrdinaryRecallEnvelope, type OrdinaryRecallRequestRecord, type OrdinaryRecallWireRecord
} from "./ordinary-recall-contract.js";
import { verifyOrdinaryRecallDelivery } from "./ordinary-recall-delivery.js";

export type CapturedOrdinaryRecallCall = Readonly<{
  request: OrdinaryRecallRequestRecord; envelope: OrdinaryRecallEnvelope | null;
  output: SoulMemorySearchResponse | null; firstExposure: FirstExposurePage | null;
  contexts: readonly OrdinaryRecallContext[]; transportError: unknown;
  responseState: "success" | "public_error" | "transport_error" | "unknown";
}>;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

/** The caller selects a trusted local operator archive; this is not a public arbitrary-JSON admission API. */
export function inspectOrdinaryRecallObservation(observationRoot: string) {
  const archive = new CaptureArchive(observationRoot);
  const config = OrdinaryRecallCaptureConfigSchema.parse(archive.json("config.json"));
  const preparation = OrdinaryRecallPreparationSchema.parse(archive.json("preparation.json"));
  const reservationValue = archive.json("execution/reservation.json", true);
  const reservation = reservationValue === undefined ? undefined : OrdinaryRecallReservationSchema.parse(reservationValue);
  const operator = archive.bytes("operator.mjs")!;
  verifyProducer(config, preparation, reservation, operator.sha256);
  const snapshot = canonicalPath(config.snapshot_path);
  archive.protect(snapshot);
  archive.protect(`${snapshot}-wal`); archive.protect(`${snapshot}-shm`);
  if (hashRegularFileNoFollow(config.snapshot_path) !== config.snapshot_sha256) conflict("sealed source snapshot changed");
  const wire = readWire(archive);
  const calls = readCalls(archive, config, wire, reservation?.reserved_at);
  const observationValue = archive.json("execution/observation-final-state.json", true);
  const observation = observationValue === undefined ? undefined : OrdinaryRecallObservationSchema.parse(observationValue);
  const returned = archive.json("execution/observation.json", true);
  if (returned !== undefined) same(returned, observation, "returned observation differs from its final state");
  const closure = readClosure(archive, config);
  if (reservation === undefined && calls.length !== 0) conflict("public calls lack their episode reservation");
  const delivery = verifyOrdinaryRecallDelivery(config, calls, observation);
  const closed = reservation !== undefined && observation !== undefined && closure;
  const state = !closed || calls.some(call => call.responseState === "unknown") ? "unknown" as const
    : delivery.complete ? "complete" as const
      : delivery.successfulExposures > 0 ? "partial" as const
        : calls.some(call => call.responseState !== "success") ? "failed" as const : "empty" as const;
  const evidence = { contract: "ordinary-recall-public-observation-v1" as const,
    calls: calls.map(call => ({ request: call.request.arguments, envelope: call.envelope,
      response_state: call.responseState, transport_error: call.transportError })),
    state, stop_reason: observation?.stop_reason ?? "capture_incomplete" };
  return { config, state, closed, evidence, successfulExposures: delivery.successfulExposures,
    firstExposure: delivery.firstExposure, protectedPaths: archive.protectedPaths,
    binding: { observation_identity: chainIdentity(archive.identities),
      producer_revision: config.implementation_revision, producer_candidate: config.candidate,
      capture_contract: config.capture_contract, public_semantics: config.public_semantics,
      protocol_package_version: config.protocol_package_version,
      reader_protocol_package_version: ordinaryRecallReaderProtocolVersion(),
      verification_revision: readCurrentExtractionAuthorityRevision() } };
}

export function admitOrdinaryRecallObservation(observationRoot: string) {
  const observation = inspectOrdinaryRecallObservation(observationRoot);
  if (!observation.closed || observation.successfulExposures === 0 || observation.firstExposure === null) {
    conflict("consumer requires a closed ordinary Recall capture with successful public source exposure");
  }
  return observation;
}

function verifyProducer(config: OrdinaryRecallCaptureConfig, preparation: z.infer<typeof OrdinaryRecallPreparationSchema>,
  reservation: z.infer<typeof OrdinaryRecallReservationSchema> | undefined, operatorDigest: string): void {
  if (preparation.candidate !== config.candidate || preparation.tree !== config.tree ||
      preparation.native_implementation_revision !== config.implementation_revision ||
      preparation.config_identity !== chainIdentity(config) || preparation.operator_sha256 !== operatorDigest) {
    conflict("producer preparation does not bind its captured configuration and operator");
  }
  if (reservation !== undefined && (reservation.candidate !== config.candidate || reservation.tree !== config.tree ||
      reservation.config_identity !== preparation.config_identity || reservation.operator_sha256 !== operatorDigest ||
      Date.parse(reservation.reserved_at) < Date.parse(preparation.prepared_at))) {
    conflict("episode reservation differs from its prepared producer");
  }
}

function readClosure(archive: CaptureArchive, config: OrdinaryRecallCaptureConfig): boolean {
  const resultValue = archive.json("execution/process-result.json", true);
  const shutdownValue = archive.json("execution/shutdown.json", true);
  if (resultValue === undefined || shutdownValue === undefined) return false;
  const result = OrdinaryRecallProcessResultSchema.parse(resultValue);
  const shutdown = OrdinaryRecallShutdownSchema.parse(shutdownValue);
  if (shutdown.snapshot_sha256 !== config.snapshot_sha256) conflict("shutdown changed the sealed snapshot binding");
  // A forced process cannot certify that all observer buffers and public replies were retained.
  return !result.forced && result.close.signal === null;
}

function readWire(archive: CaptureArchive): OrdinaryRecallWireRecord[] {
  const file = archive.bytes("execution/public-mcp-messages.jsonl", true);
  if (file === undefined) return [];
  const text = decodeCanonicalUtf8Artifact(file.bytes, "ordinary Recall MCP transcript");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const records = lines.map(line => OrdinaryRecallWireRecordSchema.parse(JSON.parse(line)));
  for (const [index, row] of records.entries()) {
    if (row.ordinal !== index + 1 || index > 0 && Date.parse(row.at) < Date.parse(records[index - 1]!.at)) {
      conflict("public MCP transcript order changed");
    }
  }
  return records;
}

function readCalls(archive: CaptureArchive, config: OrdinaryRecallCaptureConfig,
  wire: readonly OrdinaryRecallWireRecord[], reservedAt: string | undefined): CapturedOrdinaryRecallCall[] {
  const execution = join(archive.root, "execution");
  const names = boundedArtifactEntryExists(execution) ? readdirSync(execution).filter(name => /^\d+-request\.json$/u.test(name)).sort() : [];
  if (names.length > config.bounds.total_recall_calls) conflict("capture exceeds its public call allowance");
  const requests = wire.filter(row => row.direction === "client_to_server" && row.message.method === "tools/call");
  if (requests.length > names.length) conflict("MCP transcript contains an unreserved call");
  if (wire.some(row => row.direction === "server_to_client" && row.message.id !== undefined &&
      !requests.some(request => request.message.id === row.message.id))) conflict("MCP transcript contains an unbound reply");
  const seen = new Set<string | number>();
  let lastReply = 0;
  return names.map((name, index) => {
    const ordinal = index + 1, stem = String(ordinal).padStart(2, "0");
    if (name !== `${stem}-request.json`) conflict("capture request ordinals are not contiguous");
    const request = OrdinaryRecallRequestRecordSchema.parse(archive.json(`execution/${name}`));
    if (request.ordinal !== ordinal || reservedAt === undefined || Date.parse(request.reserved_at) < Date.parse(reservedAt)) {
      conflict("call does not bind its preceding episode reservation");
    }
    const envelopeValue = archive.json(`execution/${stem}-public-envelope.json`, true);
    const envelope = envelopeValue === undefined ? null : OrdinaryRecallEnvelopeSchema.parse(envelopeValue);
    const sent = requests[index];
    if (sent !== undefined && sent.ordinal <= lastReply) conflict("public calls overlapped instead of consuming the preceding reply");
    const reply = verifyWireCall(wire, sent, request, seen, envelope);
    if (reply !== undefined) lastReply = reply.ordinal;
    const contextsValue = archive.json(`execution/${stem}-trusted-contexts.json`, true);
    const contexts = contextsValue === undefined ? [] : z.array(OrdinaryRecallContextSchema).parse(contextsValue);
    const exposureValue = archive.json(`execution/${stem}-first-exposure.json`, true);
    const firstExposure = exposureValue === undefined ? null : FirstExposurePageSchema.parse(exposureValue);
    // Diagnostic absence is retained in the identity, never substituted for a public response.
    const diagnostics = archive.json(`execution/${stem}-execution-receipts.json`, true);
    const decoded = decodeEnvelope(envelope, reply?.message.error);
    verifyNativeDiagnostics(diagnostics, config, decoded.output);
    if (envelope !== null && Buffer.byteLength(JSON.stringify(envelope)) > config.bounds.public_envelope_observation_bytes) {
      conflict("public envelope exceeds the selected consumer observation bound");
    }
    return { request, envelope, contexts, firstExposure, ...decoded };
  });
}

function verifyNativeDiagnostics(value: unknown, config: OrdinaryRecallCaptureConfig, output: SoulMemorySearchResponse | null): void {
  if (value === undefined) return;
  const diagnostics = z.object({ receipts: z.array(z.unknown()).max(1) }).passthrough().parse(value);
  for (const retained of diagnostics.receipts) {
    if (retained === null) continue;
    const receipt = ConditionalFieldExecutionReceiptSchema.parse(retained);
    if (executionBindingMismatch(receipt, { queryText: config.first_request.query, workspaceId: config.workspace_id,
      referenceTime: config.first_request.source_observed_at, requestBudget: config.bounds.default_native_request,
      expectedIndexSnapshotId: output?.index?.snapshot_id }) !== null ||
        output?.index !== undefined && (output.index.query_id !== receipt.query_id ||
          output.index.interpretation_id !== receipt.interpretation_id || output.index.as_of !== receipt.interpretation_clock)) {
      conflict("retained native diagnostics contradict the public call");
    }
  }
}

function verifyWireCall(wire: readonly OrdinaryRecallWireRecord[], sent: OrdinaryRecallWireRecord | undefined,
  request: OrdinaryRecallRequestRecord, seen: Set<string | number>, envelope: OrdinaryRecallEnvelope | null) {
  if (sent === undefined) {
    if (envelope !== null) conflict("public envelope has no captured MCP request");
    return undefined;
  }
  const id = sent.message.id;
  if (id === undefined || seen.has(id) || Date.parse(sent.at) < Date.parse(request.reserved_at)) {
    conflict("public MCP request identity or reservation changed");
  }
  seen.add(id);
  same(sent.message.params, { name: "soul.recall", arguments: request.arguments }, "MCP request differs from its reservation");
  const replies = wire.filter(row => row.direction === "server_to_client" && row.message.id === id);
  if (replies.length > 1 || replies[0] !== undefined && replies[0].ordinal <= sent.ordinal) {
    conflict("public MCP reply identity or ordering changed");
  }
  const reply = replies[0];
  if (envelope !== null) {
    if (reply === undefined || reply.message.error !== undefined) conflict("public envelope lacks its successful MCP reply capture");
    same(reply.message.result, envelope, "public envelope differs from the physical MCP reply");
  } else if (reply?.message.result !== undefined) conflict("captured MCP response is missing its public envelope");
  return reply;
}

function decodeEnvelope(envelope: OrdinaryRecallEnvelope | null, transportError: unknown) {
  if (envelope === null) return { responseState: transportError === undefined ? "unknown" as const : "transport_error" as const,
    output: null, transportError: transportError ?? null };
  const text = envelope.content.filter(block => block.type === "text");
  if (text.length !== 1 || typeof text[0]!.text !== "string") conflict("public envelope lacks its exact text payload");
  const payload = z.object({ ok: z.boolean(), output: z.unknown().optional(), error: z.unknown().optional() })
    .passthrough().parse(JSON.parse(text[0]!.text as string));
  if (envelope.structuredContent !== undefined) same(envelope.structuredContent, payload, "public payload representations differ");
  if (envelope.isError === true || !payload.ok) return { responseState: "public_error" as const, output: null, transportError: null };
  const output = SoulMemorySearchResponseSchema.parse(payload.output);
  same(output, payload.output, "public output cannot be normalized during historical admission");
  return { responseState: "success" as const, output, transportError: null };
}

class CaptureArchive {
  readonly root: string;
  readonly protectedPaths: string[];
  readonly identities: { path: string; sha256: string | null }[] = [];
  private readBytes = 0;
  constructor(root: string) { this.root = canonicalPath(root); this.protectedPaths = [this.root]; }
  protect(path: string): void { this.protectedPaths.push(path); }
  bytes(name: string, optional = false) {
    const path = join(this.root, name);
    this.protect(path);
    if (!isContainedPath(this.root, canonicalPath(path))) conflict("capture input escapes its selected root");
    if (optional && !boundedArtifactEntryExists(path)) {
      this.identities.push({ path: name, sha256: null });
      return undefined;
    }
    const file = readBoundedStableRegularFile({ path, maxBytes: MAX_ARCHIVE_BYTES - this.readBytes,
      label: "ordinary Recall capture" });
    this.readBytes += file.bytes.byteLength;
    this.identities.push({ path: name, sha256: file.identity.sha256 });
    return { bytes: file.bytes, sha256: file.identity.sha256 };
  }
  json(name: string, optional = false): unknown {
    const file = this.bytes(name, optional);
    return file === undefined ? undefined : JSON.parse(decodeCanonicalUtf8Artifact(file.bytes, "ordinary Recall capture"));
  }
}

function same(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) conflict(message);
}
function conflict(message: string): never { throw new AlayaError("CONFLICT", `ordinary Recall observation: ${message}`); }
