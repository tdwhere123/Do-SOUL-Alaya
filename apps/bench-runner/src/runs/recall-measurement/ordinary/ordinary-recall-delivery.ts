import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";
import { StorageDatabase } from "@do-soul/alaya-storage";
import { authorizeSemanticScope, fieldContractSha256, projectSourceDisclosure, resolveCurrentSource } from "@do-soul/alaya-core";
import { AlayaError, encodeSourceDisclosure, sourceDisclosure, canonicalJson, sameSourceEvidenceRoot, sourceRecallTarget,
  type SoulMemorySearchResponse, type SourceRecordIdentity, type SourceEvidenceTarget } from "@do-soul/alaya-protocol";
import { sourceLookupStores } from "../../snapshot/source-records/publish.js";
import { withCachedSqliteSnapshot } from "../../snapshot/bound-file.js";
import { admitEmittedSourcePreview } from "../replay.js";
import { exposureSlots, firstExposureMismatch, type FirstExposurePage } from "../../measurement/first-exposure-session.js";
import { OrdinaryRecallObservationSchema, RepresentationAwareRecallProtocolVersionSchema,
  type OrdinaryRecallArchiveConfig, type OrdinaryRecallCaptureConfig } from "./ordinary-recall-contract.js";
import type { CapturedOrdinaryRecallCall } from "./ordinary-recall.js";

type Observation = z.infer<typeof OrdinaryRecallObservationSchema>;
type ResponseIndex = NonNullable<SoulMemorySearchResponse["index"]>;
const TERMINAL = new Set(["unavailable", "resource_rejected", "interrupted", "invalidated", "cancelled"]);

/** Source reads validate emitted spans only; the body and all private metadata stay outside the consumer request. */
export function verifyOrdinaryRecallDelivery(config: OrdinaryRecallCaptureConfig,
  calls: readonly CapturedOrdinaryRecallCall[], observation: Observation | undefined) {
  return withCachedSqliteSnapshot({ filePath: config.snapshot_path, expectedSha256: config.snapshot_sha256,
    operation: databasePath => {
      const connection = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
      try {
        connection.pragma("query_only = ON");
        const stores = sourceLookupStores(new StorageDatabase(databasePath, connection));
        const source = resolveCapturedSource(config, config.expected_target, stores);
        if (Buffer.byteLength(source.content_bytes) !== config.expected_source_bytes) conflict("complete source length differs from the capture");
        const disclosure = capturedSourceDisclosure(config, source.record);
        return verifySequence(config, calls, observation, source.content_bytes, disclosure);
      } finally { connection.close(); }
    } });
}

/** Both archive versions bind each emitted root to the same sealed current-source authority. */
export function resolveCapturedSource(config: OrdinaryRecallArchiveConfig, target: SourceEvidenceTarget,
  stores: ReturnType<typeof sourceLookupStores>) {
  if (target.workspace_id !== config.workspace_id || target.root_kind !== "source_record") conflict("public source escaped its sealed workspace or root kind");
  const retained = stores.getStoredRecord(config.workspace_id, target.root_id);
  if (retained === null) conflict("expected source is absent from the sealed snapshot");
  const source = resolveCurrentSource(stores, config.workspace_id, { artifact_key: retained.record.source_id,
    source_corpus_digest: target.content_digest.replace(/^sha256:/u, "") }, fieldContractSha256);
  const { span: _span, ...root } = target;
  same(root, sourceRecallTarget({ workspace_id: source.record.workspace_id, root_kind: "source_record",
    root_id: source.record.identity, source_version: source.record.source_version,
    content_digest: source.record.content_digest, evidence_object_id: source.record.evidence_object_id }), "expected source identity changed");
  authorizeSemanticScope(source.record.scope_class, ["project"]);
  return source;
}

/** Offline compatibility for admitted 14.1–17 captures; remove when those producer formats retire. */
export function capturedSourceDisclosure(config: OrdinaryRecallArchiveConfig, source: SourceRecordIdentity) {
  const disclosure = projectSourceDisclosure({ material_kind: "original_body",
    evaluated_as_of: config.first_request.source_observed_at!, source });
  if (RepresentationAwareRecallProtocolVersionSchema.safeParse(config.protocol_package_version).success) return disclosure;
  if (source.source_representation !== undefined) conflict("historical capture contains later source representation metadata");
  // Prior producers called every retained source-record body original; never rewrite their archived output.
  return encodeSourceDisclosure({ ...sourceDisclosure(disclosure), material_kind: "original_body" });
}

function verifySequence(config: OrdinaryRecallCaptureConfig, calls: readonly CapturedOrdinaryRecallCall[],
  observation: Observation | undefined, source: string, disclosure: ReturnType<typeof projectSourceDisclosure>) {
  let previous: CapturedOrdinaryRecallCall | undefined, firstExposure: FirstExposurePage | null = null;
  let identity: unknown[] | null = null, end = 0, complete = false, successfulExposures = 0;
  let firstSource: unknown = null, membership = 0, payload = 0;
  const pages: unknown[] = [], requests = new Set<string>();
  for (const call of calls) {
    if (complete) conflict("capture continued after complete public delivery");
    verifyCallRequest(config, call, previous, end, requests);
    if (call.request.phase === "membership") membership += 1; else payload += 1;
    if (call.contexts.length > 1 || call.envelope !== null && call.contexts.length !== 1) {
      conflict("public response lacks its unique trusted context");
    }
    for (const context of call.contexts) {
      if (context.workspaceId !== config.workspace_id || context.runId !== config.run_id) conflict("trusted workspace or run changed");
      if (previous?.contexts[0] !== undefined) same(context, previous.contexts[0], "trusted principal changed between calls");
    }
    const output = call.output;
    if (output !== null) {
      const index = output.index;
      if (index === undefined || index.interpretation_id === undefined || index.as_of !== config.first_request.source_observed_at) {
        conflict("public source output lacks its bound query identity and clock");
      }
      const nextIdentity = [index.query_id, index.snapshot_id, index.result_version, index.interpretation_id, index.as_of];
      if (identity === null) identity = nextIdentity; else same(nextIdentity, identity, "public query or snapshot identity changed");
      verifyExposure(call, index, firstExposure);
      firstExposure ??= call.firstExposure;
      verifySourcePage(config, output, source, disclosure);
      const row = output.results[0], span = row?.target.kind === "source_evidence" ? row.target.span : undefined;
      const usable = !terminal(index) && span !== undefined && row?.content_preview !== "[payload omitted]";
      const accepted = usable && span.content_end > end;
      pages.push({ ordinal: call.request.ordinal, phase: call.request.phase, delivery_id: output.delivery_id,
        completeness: index.completeness, continuation: index.continuation, span: span ?? null,
        preview_bytes: row === undefined ? 0 : Buffer.byteLength(row.content_preview), accepted_contiguous_span: accepted });
      if (accepted) {
        if (span.content_start !== end || span.content_end > config.expected_source_bytes) conflict("public payload is not a contiguous delivered span");
        successfulExposures += 1;
        end = span.content_end;
        if (accepted) firstSource ??= { ordinal: call.request.ordinal, delivery_id: output.delivery_id, span };
        complete = span.content_complete && end === config.expected_source_bytes;
      }
    }
    previous = call;
  }
  if (membership > config.bounds.membership_calls || payload > config.bounds.payload_expansion_calls) conflict("capture exceeded a phase call bound");
  if (observation !== undefined) {
    same({ calls: observation.calls, membership: observation.membership_calls, payload: observation.payload_expansion_calls },
      { calls: calls.length, membership, payload }, "observation call counts differ from reservations");
    same(observation.query_identity, identity, "observation query identity differs from public output");
    same(observation.first_source_exposure, firstSource, "first source exposure differs from public output");
    same(observation.pages, pages, "observation page summary differs from public output");
    // A throwing public call can retain handler context before the outer observation assigns its principal.
    same(observation.trusted_principal, calls.find(call => call.envelope !== null)?.contexts[0] ?? null,
      "observation trusted principal differs from handler context");
    if (observation.contiguous_delivered_bytes !== end || observation.source_complete !== complete ||
        observation.remaining_tail_bytes !== config.expected_source_bytes - end ||
        (observation.stop_reason === "complete_public_body") !== complete) conflict("observation completeness differs from public delivery");
  }
  return { complete, successfulExposures, firstExposure };
}

function verifyCallRequest(config: OrdinaryRecallCaptureConfig, call: CapturedOrdinaryRecallCall,
  previous: CapturedOrdinaryRecallCall | undefined, end: number, requests: Set<string>): void {
  const { continuation, payload_continuation, ...initial } = call.request.arguments;
  same(initial, config.first_request, "public request changed the original question or filters");
  const key = canonicalJson(call.request.arguments);
  if (requests.has(key)) conflict("the capture repeated a public request");
  requests.add(key);
  if (previous === undefined) {
    if (continuation != null || payload_continuation != null || call.request.phase !== "membership") conflict("first call is not the frozen root request");
    return;
  }
  const index = previous.output?.index;
  if (index === undefined || index.continuation == null || terminal(index) || previous.responseState !== "success") {
    conflict("later call has no live issued continuation in the previous public output");
  }
  same(continuation, index.continuation, "later call did not use the issued public continuation");
  if (call.responseState === "success" && Date.parse(continuation!.expires_at) <= Date.parse(call.request.reserved_at)) {
    conflict("successful public call used an expired continuation");
  }
  if (payload_continuation === undefined) {
    if (call.request.phase !== "membership" || previous.output!.results.length !== 0) conflict("membership continuation replaced a delivered source");
  } else {
    const entry = index.entries.find(row => row.target.kind === "source_evidence" && sameSourceEvidenceRoot(row.target, config.expected_target));
    if (call.request.phase !== "payload" || entry === undefined || end === 0) conflict("payload request lacks a delivered source member");
    same(payload_continuation, { schema_version: 1, purpose: "payload_expansion", target: entry.target,
      start_offset: end, byte_budget: config.bounds.payload_byte_budget }, "payload request changed its issued target or offset");
  }
}

export function verifyExposure(call: CapturedOrdinaryRecallCall, index: ResponseIndex, first: FirstExposurePage | null): void {
  const page = call.firstExposure;
  if (page === null || firstExposureMismatch(page, { query_id: index.query_id, snapshot_id: index.snapshot_id,
    interpretation_id: index.interpretation_id!, as_of: index.as_of! }, exposureSlots(call.output!), call.output!.delivery_id)) {
    conflict("public page lacks its retained first-exposure receipt");
  }
  same(page.request_continuation, call.request.arguments.continuation ?? null, "first-exposure request binding changed");
  if (page.page_purpose !== (index.page_purpose ?? "membership")) conflict("first-exposure page purpose changed");
  if (first !== null) same(page.initial, first.initial, "later page replaced the initial exposure");
}

function verifySourcePage(config: OrdinaryRecallCaptureConfig, output: SoulMemorySearchResponse,
  source: string, disclosure: ReturnType<typeof projectSourceDisclosure>): void {
  const entries = output.index!.entries;
  if (entries.length !== output.results.length || entries.length > 1) conflict("public output changed the selected source population");
  for (const [position, row] of output.results.entries()) {
    const target = entries[position]!.target;
    if (target.kind !== "source_evidence" || !sameSourceEvidenceRoot(target, config.expected_target)) conflict("public target differs from the sealed source");
    verifyCapturedSourceResult(config, target, row, source, disclosure);
  }
}

export function verifyCapturedSourceResult(config: OrdinaryRecallArchiveConfig, target: SourceEvidenceTarget,
  row: SoulMemorySearchResponse["results"][number], source: string, disclosure: ReturnType<typeof projectSourceDisclosure>): void {
  admitEmittedSourcePreview(target.span, row, undefined, target, source, false);
  if (target.span !== undefined && row.content_preview !== "[payload omitted]") {
    const deliveredBytes = row.content_preview === "[empty source]" ? 0 : Buffer.byteLength(row.content_preview);
    if (target.span.content_end - target.span.content_start !== deliveredBytes ||
        target.span.content_complete && target.span.content_end !== Buffer.byteLength(source)) {
      conflict("public source extent overstates delivered bytes or completeness");
    }
    if (RepresentationAwareRecallProtocolVersionSchema.safeParse(config.protocol_package_version).success &&
        target.span.original_complete !== (sourceDisclosure(disclosure).material_kind === "original_body")) {
      conflict("public original completeness differs from source representation");
    }
  }
  same(row.source_disclosure, disclosure, "public source qualifications differ from sealed metadata");
}

export function terminal(index: ResponseIndex): boolean {
  return TERMINAL.has(index.completeness.logical_index) || TERMINAL.has(index.completeness.payload);
}
function same(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) conflict(message);
}
function conflict(message: string): never { throw new AlayaError("CONFLICT", `ordinary Recall delivery: ${message}`); }
