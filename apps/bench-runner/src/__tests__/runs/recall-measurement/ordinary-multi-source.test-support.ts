import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { StorageDatabase } from "@do-soul/alaya-storage";
import { canonicalJson, sourceEvidenceRootTarget, SoulMemorySearchRequestSchema, SoulMemorySearchResponseSchema,
  type SoulMemorySearchRequest, type SourceEvidenceTarget } from "@do-soul/alaya-protocol";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { chainIdentity } from "../../../runs/recall-measurement/contract.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { sourceLookupStores } from "../../../runs/snapshot/source-records/publish.js";
import { restoreSnapshotToDataDir } from "../../../runs/snapshot/materialize.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { FirstExposureSession, FirstExposurePageSchema } from "../../../runs/measurement/first-exposure-session.js";
import { OrdinaryRecallContextSchema, OrdinaryRecallRequestRecordSchema, OrdinaryRecallEnvelopeSchema,
  installedRecallProtocolVersion } from "../../../runs/recall-measurement/ordinary/ordinary-recall-contract.js";
import type { ordinaryIndexedSnapshot } from "./ordinary-indexed-snapshot.test-support.js";
import { observeTransport, readJson, writeJson, type RecallResponseCase } from "./ordinary-capture.test-support.js";

type Mode = "complete" | "prefix" | "prefix_error";
type SourceState = { target: SourceEvidenceTarget; contiguous_delivered_bytes: number;
  source_complete: boolean; remaining_tail_bytes: number };

/** The operator follows actual returned membership and spans; it never preselects an expected source. */
export async function captureMultipleSources(base: Awaited<ReturnType<typeof ordinaryIndexedSnapshot>>, mode: Mode,
  responseCase?: RecallResponseCase) {
  const root = join(base.root, `multi-${responseCase ?? mode}`), execution = join(root, "execution");
  mkdirSync(execution, { recursive: true });
  const plan = base.config;
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const config = { capture_contract: "ordinary-recall-local-capture-v2", public_semantics: "ordinary-native-field.v6",
    protocol_package_version: installedRecallProtocolVersion(), candidate, tree,
    implementation_revision: readCurrentExtractionAuthorityRevision(), snapshot_path: plan.snapshot_path,
    snapshot_sha256: plan.snapshot_sha256, workspace_id: plan.workspace_id, run_id: plan.run_id,
    first_request: { query: "project", scope_class: "project", dimension: null,
      domain_tags: null, max_results: 8, source_observed_at: plan.interpretation_clock,
      enumeration_policy: "native_query", result_kind_view: "source_only", protocol_version: 1,
      supports_source_evidence: true } satisfies SoulMemorySearchRequest,
    bounds: { membership_calls: 2, payload_expansion_calls: 8, total_recall_calls: 10,
      payload_byte_budget: 4096, public_envelope_observation_bytes: 1048576,
      default_native_request: { schema_version: 1, work_units: 10000, memory_bytes: 1000000,
        page_budget: 8, finalization_reserve: 100, min_envelope: 10 } }, provider_calls: 0, consumer_calls: 0 };
  copyFileSync(fileURLToPath(import.meta.url), join(root, "operator.mjs"));
  const operator_sha256 = hashRegularFileNoFollow(join(root, "operator.mjs"));
  writeJson(join(root, "config.json"), config);
  writeJson(join(root, "preparation.json"), { status: "prepared_not_executed", prepared_at: new Date().toISOString(),
    candidate, tree, native_implementation_revision: config.implementation_revision, config_identity: chainIdentity(config), operator_sha256 });
  writeJson(join(execution, "reservation.json"), { candidate, tree, lane: "native-test", reserved_at: new Date().toISOString(),
    config_identity: chainIdentity(config), operator_sha256, retry: false });
  const working = join(root, "working");
  restoreSnapshotToDataDir({ snapshotDbPath: config.snapshot_path, expectedSha256: config.snapshot_sha256, dataDirRoot: working });
  const connection = new BetterSqlite3(config.snapshot_path, { readonly: true });
  const stores = sourceLookupStores(new StorageDatabase(config.snapshot_path, connection));
  const daemon = await startBenchDaemon({ dataDirRoot: working, workspaceId: config.workspace_id, runId: config.run_id,
    embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  const contexts: unknown[] = [], tap = observeTransport(daemon, execution, contexts, mode, responseCase);
  const exposures = new FirstExposureSession(), pages: unknown[] = [], states = new Map<string, SourceState>();
  const delivered = new Map<string, string>(), bodies = new Map<string, string>();
  const issuedTargets = new Map<string, SourceEvidenceTarget>();
  let request = SoulMemorySearchRequestSchema.parse(config.first_request);
  let ordinal = 0, membership = 0, payloadCalls = 0, membershipComplete = false;
  let firstSource: unknown = null, identity: unknown = null, principal: unknown = null, stop = "total_call_cap";
  try {
    while (++ordinal <= config.bounds.total_recall_calls) {
      const phase = request.payload_continuation === undefined ? "membership" : "payload", stem = String(ordinal).padStart(2, "0");
      if (phase === "membership") membership += 1; else payloadCalls += 1;
      contexts.length = 0;
      writeJson(join(execution, `${stem}-request.json`), { ordinal, phase, tool: "soul.recall", arguments: request,
        reserved_at: new Date().toISOString(), retry: false });
      const envelope = OrdinaryRecallEnvelopeSchema.parse(await daemon.mcpClient.callTool({ name: "soul.recall", arguments: request }));
      writeJson(join(execution, `${stem}-public-envelope.json`), envelope);
      writeJson(join(execution, `${stem}-trusted-contexts.json`), contexts);
      principal ??= contexts[0];
      const block = envelope.content.find(item => item.type === "text"); assert(typeof block?.text === "string");
      const decoded = JSON.parse(block.text);
      if (decoded.ok !== true) { stop = "public_error"; break; }
      const output = SoulMemorySearchResponseSchema.parse(decoded.output), index = output.index; assert(index);
      writeJson(join(execution, `${stem}-first-exposure.json`), exposures.record(output, request.continuation));
      identity ??= [index.query_id, index.snapshot_id, index.result_version, index.interpretation_id, index.as_of];
      if (phase === "membership") membershipComplete = index.completeness.logical_index === "complete" && index.completeness.transport === "complete";
      const entries: unknown[] = [];
      for (const entry of index.entries) {
        assert(entry.target.kind === "source_evidence");
        const row = output.results.find(result => canonicalJson(result.target) === canonicalJson(entry.target));
        const target = sourceEvidenceRootTarget(entry.target), span = row?.target.kind === "source_evidence" ? row.target.span : undefined;
        issuedTargets.set(target.root_id, entry.target);
        const stored = stores.getStoredRecord(config.workspace_id, target.root_id); assert(stored);
        const size = Buffer.byteLength(stored.content_bytes);
        bodies.set(target.root_id, stored.content_bytes);
        const state = states.get(target.root_id) ?? { target, contiguous_delivered_bytes: 0, source_complete: false, remaining_tail_bytes: size };
        const usable = span !== undefined && row !== undefined && row.content_preview !== "[payload omitted]";
        const accepted = usable && (span.content_end > state.contiguous_delivered_bytes || size === 0 && !state.source_complete);
        entries.push({ target, span: span ?? null, preview_present: row !== undefined,
          preview_bytes: row === undefined ? 0 : Buffer.byteLength(row.content_preview), accepted_contiguous_span: accepted });
        if (accepted) {
          assert(span.content_start <= state.contiguous_delivered_bytes);
          assert.equal(row.content_preview, Buffer.from(stored.content_bytes).subarray(span.content_start, span.content_end).toString("utf8"));
          delivered.set(target.root_id, (delivered.get(target.root_id) ?? "") + Buffer.from(row.content_preview)
            .subarray(state.contiguous_delivered_bytes - span.content_start).toString("utf8"));
          state.contiguous_delivered_bytes = span.content_end;
          state.source_complete = span.content_complete && span.content_end === size;
          state.remaining_tail_bytes = size - span.content_end;
          firstSource ??= { ordinal, delivery_id: output.delivery_id, target, span };
        }
        states.set(target.root_id, state);
      }
      pages.push({ ordinal, phase, delivery_id: output.delivery_id, completeness: index.completeness,
        continuation: index.continuation, entries });
      if (membershipComplete && states.size > 0 && [...states.values()].every(state => state.source_complete)) { stop = "complete_public_body"; break; }
      if (mode === "prefix") { stop = "payload_call_cap"; break; }
      if (index.continuation === null) { stop = "no_public_continuation"; break; }
      const next = [...issuedTargets.values()].find(target => !states.get(target.root_id)?.source_complete);
      if (next !== undefined) {
        request = { ...config.first_request, continuation: index.continuation, payload_continuation: {
          schema_version: 1, purpose: "payload_expansion", target: next,
          start_offset: states.get(next.root_id)!.contiguous_delivered_bytes, byte_budget: config.bounds.payload_byte_budget } };
      } else request = { ...config.first_request, continuation: index.continuation };
    }
  } finally { tap(); await daemon.shutdown(); connection.close(); }
  assert(ordinal <= config.bounds.total_recall_calls);
  const observation = { calls: ordinal, membership_calls: membership, payload_expansion_calls: payloadCalls,
    source_states: [...states.values()], membership_complete: membershipComplete,
    source_complete: membershipComplete && states.size > 0 && [...states.values()].every(state => state.source_complete),
    first_source_exposure: firstSource, pages, trusted_principal: principal, query_identity: identity, stop_reason: stop };
  writeJson(join(execution, "observation-final-state.json"), observation); writeJson(join(execution, "observation.json"), observation);
  writeJson(join(execution, "shutdown.json"), { at: new Date().toISOString(), shutdown_awaited: true, daemon_started: true,
    frozen_source_file_unchanged: hashRegularFileNoFollow(config.snapshot_path) === config.snapshot_sha256,
    snapshot_sha256: config.snapshot_sha256, failure: null, provider_calls: 0, consumer_calls: 0 });
  writeJson(join(execution, "process-result.json"), { status: "closed", close: { code: 0, signal: null },
    forced: false, child_error: null, process_in_flight: false, no_retry: true });
  return { root, execution, config, observation, bodies, delivered };
}

export function capturedCalls(capture: Awaited<ReturnType<typeof captureMultipleSources>>) {
  return Array.from({ length: capture.observation.calls }, (_, index) => {
    const stem = String(index + 1).padStart(2, "0");
    const envelope = OrdinaryRecallEnvelopeSchema.parse(readJson(join(capture.execution, `${stem}-public-envelope.json`)));
    const block = envelope.content.find(item => item.type === "text"); assert(typeof block?.text === "string");
    const decoded = JSON.parse(block.text), exposurePath = join(capture.execution, `${stem}-first-exposure.json`);
    return { request: OrdinaryRecallRequestRecordSchema.parse(readJson(join(capture.execution, `${stem}-request.json`))), envelope,
      output: decoded.ok === true ? SoulMemorySearchResponseSchema.parse(decoded.output) : null,
      firstExposure: existsSync(exposurePath) ? FirstExposurePageSchema.parse(readJson(exposurePath)) : null,
      contexts: (readJson(join(capture.execution, `${stem}-trusted-contexts.json`)) as unknown[]).map(value => OrdinaryRecallContextSchema.parse(value)),
      transportError: null, responseState: decoded.ok === true ? "success" as const : "public_error" as const };
  });
}
