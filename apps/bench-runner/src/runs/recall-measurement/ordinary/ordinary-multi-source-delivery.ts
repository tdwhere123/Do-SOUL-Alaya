import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";
import { StorageDatabase } from "@do-soul/alaya-storage";
import { AlayaError, canonicalJson, sourceEvidenceRootTarget, type SoulMemorySearchResponse,
  type SourceEvidenceTarget } from "@do-soul/alaya-protocol";
import { sourceLookupStores } from "../../snapshot/source-records/publish.js";
import { withCachedSqliteSnapshot } from "../../snapshot/bound-file.js";
import type { FirstExposurePage } from "../../measurement/first-exposure-session.js";
import { OrdinaryRecallMultiSourceObservationSchema, OrdinaryRecallSourceStateSchema,
  type OrdinaryRecallMultiSourceConfig } from "./ordinary-recall-contract.js";
import { capturedSourceDisclosure, resolveCapturedSource, terminal, verifyCapturedSourceResult, verifyExposure } from "./ordinary-recall-delivery.js";
import type { CapturedOrdinaryRecallCall } from "./ordinary-recall.js";
import { hasDeliveredSourcePayload } from "../../measurement/source-delivery-visibility.js";

type Observation = z.infer<typeof OrdinaryRecallMultiSourceObservationSchema>;
type SourceState = z.infer<typeof OrdinaryRecallSourceStateSchema>;
type Source = ReturnType<typeof resolveCapturedSource>;
type Index = NonNullable<SoulMemorySearchResponse["index"]>;

/** The sealed snapshot checks only roots actually emitted by this public query. */
export function verifyOrdinaryMultiSourceDelivery(config: OrdinaryRecallMultiSourceConfig,
  calls: readonly CapturedOrdinaryRecallCall[], observation: Observation | undefined) {
  return withCachedSqliteSnapshot({ filePath: config.snapshot_path, expectedSha256: config.snapshot_sha256,
    operation: databasePath => {
      const connection = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
      try {
        connection.pragma("query_only = ON");
        const sequence = new MultiSourceDelivery(config, sourceLookupStores(new StorageDatabase(databasePath, connection)));
        for (const call of calls) sequence.accept(call);
        return sequence.finish(observation);
      } finally { connection.close(); }
    } });
}

/** A single query owns its membership, all source offsets, and shared call allowances. */
class MultiSourceDelivery {
  private readonly states = new Map<string, SourceState>();
  private readonly sources = new Map<string, Source>();
  private readonly issuedTargets = new Set<string>();
  private readonly requests = new Set<string>();
  private readonly pages: unknown[] = [];
  private previous: CapturedOrdinaryRecallCall | undefined;
  private firstExposure: FirstExposurePage | null = null;
  private firstSource: unknown = null;
  private principal: unknown = null;
  private identity: unknown[] | null = null;
  private membership = 0;
  private payload = 0;
  private membershipComplete = false;
  private successfulExposures = 0;

  constructor(private readonly config: OrdinaryRecallMultiSourceConfig, private readonly stores: ReturnType<typeof sourceLookupStores>) {}

  accept(call: CapturedOrdinaryRecallCall): void {
    if (this.complete()) conflict("capture continued after complete public delivery");
    this.verifyRequest(call);
    if (call.request.phase === "membership") this.membership += 1; else this.payload += 1;
    if (this.membership > this.config.bounds.membership_calls || this.payload > this.config.bounds.payload_expansion_calls ||
        this.membership + this.payload > this.config.bounds.total_recall_calls) conflict("capture exceeded a shared call bound");
    this.verifyContext(call);
    if (call.output !== null) this.acceptOutput(call, call.output);
    this.previous = call;
  }

  private verifyContext(call: CapturedOrdinaryRecallCall): void {
    if (call.contexts.length > 1 || call.envelope !== null && call.contexts.length !== 1) conflict("public response lacks its unique trusted context");
    for (const context of call.contexts) {
      if (context.workspaceId !== this.config.workspace_id || context.runId !== this.config.run_id) conflict("trusted workspace or run changed");
      if (this.previous?.contexts[0] !== undefined) same(context, this.previous.contexts[0], "trusted principal changed between calls");
    }
    if (call.envelope !== null) this.principal ??= call.contexts[0] ?? null;
  }

  private verifyRequest(call: CapturedOrdinaryRecallCall): void {
    const { continuation, payload_continuation, ...initial } = call.request.arguments;
    same(initial, this.config.first_request, "public request changed the original question or filters");
    const key = canonicalJson(call.request.arguments);
    if (this.requests.has(key)) conflict("the capture repeated a public request");
    this.requests.add(key);
    if (this.previous === undefined) {
      if (continuation != null || payload_continuation != null || call.request.phase !== "membership") conflict("first call is not the frozen root request");
      return;
    }
    const index = this.previous.output?.index;
    if (index === undefined || index.continuation == null || terminal(index) || this.previous.responseState !== "success") {
      conflict("later call has no live issued continuation in the previous public output");
    }
    same(continuation, index.continuation, "later call did not use the issued public continuation");
    if (call.responseState === "success" && Date.parse(continuation!.expires_at) <= Date.parse(call.request.reserved_at)) conflict("successful public call used an expired continuation");
    if (payload_continuation === undefined) {
      if (call.request.phase !== "membership" || this.membershipComplete) conflict("membership continued after its complete public page");
      return;
    }
    const target = payload_continuation.target;
    if (target.kind !== "source_evidence" || !this.issuedTargets.has(canonicalJson(target))) conflict("payload request lacks a public issued source target");
    const state = this.states.get(target.root_id);
    if (call.request.phase !== "payload" || state === undefined || state.source_complete) conflict("payload request lacks an incomplete delivered source member");
    same(payload_continuation, { schema_version: 1, purpose: "payload_expansion", target,
      start_offset: state.contiguous_delivered_bytes, byte_budget: this.config.bounds.payload_byte_budget }, "payload request changed its issued offset or byte allowance");
  }

  private acceptOutput(call: CapturedOrdinaryRecallCall, output: SoulMemorySearchResponse): void {
    const index = output.index;
    if (index === undefined || index.interpretation_id === undefined || index.as_of !== this.config.first_request.source_observed_at) conflict("public source output lacks its bound query identity and clock");
    const identity = [index.query_id, index.snapshot_id, index.result_version, index.interpretation_id, index.as_of];
    if (this.identity === null) this.identity = identity; else same(identity, this.identity, "public query or snapshot identity changed");
    verifyExposure(call, index, this.firstExposure); this.firstExposure ??= call.firstExposure;
    if (!(terminal(index) && index.page_purpose === undefined) &&
        (index.page_purpose ?? "membership") !== call.request.phase) conflict("public page purpose differs from its reserved request");
    if (call.request.phase === "membership") this.membershipComplete = !terminal(index) &&
      index.completeness.logical_index === "complete" && index.completeness.transport === "complete";
    const requested = call.request.arguments.payload_continuation?.target;
    if (requested !== undefined && !terminal(index) && !index.entries.some(entry => entry.target.kind === "source_evidence" &&
        requested.kind === "source_evidence" && entry.target.root_id === requested.root_id)) conflict("payload response omitted its requested source member");
    let resultPosition = 0;
    const entries = index.entries.map(entry => {
      const target = entry.target, next = output.results[resultPosition];
      if (target.kind !== "source_evidence") conflict("public page contains a non-source target");
      // Compatibility rows can be omitted by the encoder. They remain an ordered subsequence of the authoritative index.
      const row = next !== undefined && canonicalJson(next.target) === canonicalJson(target) ? next : undefined;
      if (row !== undefined) resultPosition += 1;
      if (call.request.phase === "payload" && !this.states.has(target.root_id)) conflict("payload expansion introduced an unexposed source member");
      return this.acceptSource(call, output, index, row, target);
    });
    if (resultPosition !== output.results.length) conflict("a compatibility source result has no matching issued index entry");
    this.pages.push({ ordinal: call.request.ordinal, phase: call.request.phase, delivery_id: output.delivery_id,
      completeness: index.completeness, continuation: index.continuation, entries });
  }

  private acceptSource(call: CapturedOrdinaryRecallCall, output: SoulMemorySearchResponse, index: Index,
    row: SoulMemorySearchResponse["results"][number] | undefined, target: SourceEvidenceTarget) {
    const source = this.sources.get(target.root_id) ?? resolveCapturedSource(this.config, target, this.stores);
    this.sources.set(target.root_id, source);
    const root = sourceEvidenceRootTarget(target), size = Buffer.byteLength(source.content_bytes);
    const state = this.states.get(target.root_id) ?? { target: root, contiguous_delivered_bytes: 0, source_complete: false, remaining_tail_bytes: size };
    same(root, state.target, "a public source root changed its identity");
    if (row !== undefined) verifyCapturedSourceResult(this.config, target, row, source.content_bytes, capturedSourceDisclosure(this.config, source.record));
    this.issuedTargets.add(canonicalJson(target));
    const span = row === undefined ? undefined : target.span;
    const usable = !terminal(index) && span !== undefined && row !== undefined && hasDeliveredSourcePayload(row);
    const accepted = usable && (span.content_end > state.contiguous_delivered_bytes || size === 0 && !state.source_complete);
    const requested = call.request.arguments.payload_continuation;
    if (usable && requested?.target.kind === "source_evidence" && requested.target.root_id === target.root_id &&
        (span.content_start !== state.contiguous_delivered_bytes || span.content_end - span.content_start > this.config.bounds.payload_byte_budget)) {
      conflict("targeted payload did not honor its requested offset or byte allowance");
    }
    if (accepted) {
      if (span.content_start > state.contiguous_delivered_bytes || span.content_end > size) conflict("public source bytes leave a gap or exceed the sealed body");
      this.successfulExposures += 1;
      state.contiguous_delivered_bytes = span.content_end;
      state.source_complete = span.content_complete && span.content_end === size;
      state.remaining_tail_bytes = size - span.content_end;
      this.firstSource ??= { ordinal: call.request.ordinal, delivery_id: output.delivery_id, target: root, span };
    }
    this.states.set(target.root_id, state);
    return { target: root, span: span ?? null, preview_present: row !== undefined,
      preview_bytes: row === undefined ? 0 : Buffer.byteLength(row.content_preview), accepted_contiguous_span: accepted };
  }

  private complete(): boolean { return this.membershipComplete && this.states.size > 0 && [...this.states.values()].every(state => state.source_complete); }

  finish(observation: Observation | undefined) {
    const sources = [...this.states.values()], complete = this.complete();
    if (observation !== undefined) {
      same({ calls: observation.calls, membership: observation.membership_calls, payload: observation.payload_expansion_calls },
        { calls: this.membership + this.payload, membership: this.membership, payload: this.payload }, "observation call counts differ from reservations");
      same(observation.query_identity, this.identity, "observation query identity differs from public output");
      same(observation.first_source_exposure, this.firstSource, "first source exposure differs from public output");
      same(observation.pages, this.pages, "observation page summary differs from public output");
      same(observation.trusted_principal, this.principal, "observation trusted principal differs from handler context");
      same(observation.source_states, sources, "per-source completeness differs from public delivery");
      if (observation.membership_complete !== this.membershipComplete || observation.source_complete !== complete ||
          (observation.stop_reason === "complete_public_body") !== complete) conflict("observation completeness differs from public delivery");
    }
    return { complete, successfulExposures: this.successfulExposures, firstExposure: this.firstExposure, sources,
      membershipComplete: this.membershipComplete };
  }
}

function same(actual: unknown, expected: unknown, message: string): void { if (canonicalJson(actual) !== canonicalJson(expected)) conflict(message); }
function conflict(message: string): never { throw new AlayaError("CONFLICT", `ordinary multi-source Recall delivery: ${message}`); }
