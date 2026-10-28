import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { StorageDatabase } from "@do-soul/alaya-storage";
import { encodeSourceDisclosure, sourceDisclosure, sourceDisclosureProofUse, sourceIndexEntry,
  SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import { sourceLookupStores } from "../../../runs/snapshot/source-records/publish.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { chainIdentity } from "../../../runs/recall-measurement/contract.js";
import { FirstExposureSession } from "../../../runs/measurement/first-exposure-session.js";
import { writeJson, type captureOrdinaryFixture } from "./ordinary-capture.test-support.js";

/** Authored reader controls, not captures of any historical daemon. No native envelope is relabeled. */
export function authorHistoricalOrdinaryCapture(capture: Awaited<ReturnType<typeof captureOrdinaryFixture>>,
  root: string, protocolVersion: string) {
  const execution = join(root, "execution"), at = "2026-09-13T00:00:00.000Z";
  mkdirSync(execution, { recursive: true });
  const nativeSemantics = protocolVersion === "27.0.0" ? "ordinary-native-field.v4"
    : protocolVersion === "28.0.0" ? "ordinary-native-field.v5" : undefined;
  const native = nativeSemantics !== undefined;
  const config = { ...capture.config, protocol_package_version: protocolVersion,
    public_semantics: nativeSemantics ?? "conditional-field-source-only-v1", candidate: "a".repeat(40), tree: "b".repeat(40),
    implementation_revision: "a".repeat(40), fixture_kind: "authored_historical_format_not_producer_evidence",
    first_request: { ...capture.config.first_request, enumeration_policy: native ? "native_query" as const : "canonical" as const } };
  const connection = new BetterSqlite3(config.snapshot_path, { readonly: true });
  const stored = sourceLookupStores(new StorageDatabase(config.snapshot_path, connection))
    .getStoredRecord(config.workspace_id, config.expected_target.root_id);
  connection.close(); assert(stored); assert.equal(stored.record.source_representation, undefined);
  const legacy = ["14.1.0", "15.0.0", "16.0.0", "17.0.0"].includes(protocolVersion);
  const disclosure = encodeSourceDisclosure({ material_kind: legacy ? "original_body" : "unknown",
    source_binding: "checked_record", evaluated_as_of: config.first_request.source_observed_at!,
    source_time: stored.record.event_time === null ? { kind: "unknown", reason: "not_recorded" }
      : { kind: "known", at: stored.record.event_time },
    validity: { kind: "unknown", reason: "not_recorded" }, temporal_state: "unknown",
    proof_use: sourceDisclosureProofUse("source_only") });
  const preview = stored.content_bytes.slice(0, 32);
  assert(preview.length < stored.content_bytes.length);
  const span = { content_start: 0, content_end: Buffer.byteLength(preview), retained_extent: "body" as const,
    content_complete: false, original_complete: false };
  const target = { ...config.expected_target, span };
  const coordinates = { hypothesis_id: "authored-hypothesis", output_binding: "authored-binding",
    program_state: "accepting", time_state: "as_of" };
  const output = SoulMemorySearchResponseSchema.parse({ delivery_id: "authored-delivery", protocol_version: 1,
    total_count: 1, results: [{ object_kind: "source_evidence", target, relevance_score: 0,
      content_preview: preview, source_disclosure: disclosure, evidence_pointers: [], ...coordinates,
      selection_reason: "Authored historical-format control, not historical producer evidence", source_channels: [],
      score_factors: { activation: 0, relevance: 0 }, budget_state: { token_estimate: 1, max_entries: 8,
        max_total_tokens: 4096, remaining_entries: 7, remaining_tokens: 4095, within_budget: true } }],
    index: { schema_version: 1, query_id: "authored-query", snapshot_id: `sha256:${config.snapshot_sha256}`,
      result_version: nativeSemantics ?? "v1", interpretation_id: "authored-interpretation", as_of: config.first_request.source_observed_at,
      entries: [{ ...sourceIndexEntry({ ...target, ...coordinates, association_milligrades: 0 }), target }],
      completeness: { schema_version: 1, logical_index: "complete", observed_coverage: "complete",
        transport: "complete", payload: "partial", representation: "complete" }, continuation: null,
      representation: { schema_version: 1, policy: "construct_index_then_page_then_payload", page_budget: 8,
        identity_tie_break: "serialization" } } });
  const payload = { ok: true, output: { ...output, results: output.results.map(row => ({ ...row,
    source_disclosure: native || ["19.0.0", "19.1.0", "20.0.0"].includes(protocolVersion)
      ? disclosure : sourceDisclosure(disclosure) })) } };
  const envelope = { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
  const context = { workspaceId: config.workspace_id, runId: config.run_id, agentTarget: "bench-runner",
    sessionId: "authored-session", surfaceId: null };
  const observation = { calls: 1, membership_calls: 1, payload_expansion_calls: 0,
    contiguous_delivered_bytes: span.content_end, source_complete: false,
    first_source_exposure: { ordinal: 1, delivery_id: output.delivery_id, span },
    pages: [{ ordinal: 1, phase: "membership", delivery_id: output.delivery_id, completeness: output.index!.completeness,
      continuation: null, span, preview_bytes: span.content_end, accepted_contiguous_span: true }],
    trusted_principal: context, query_identity: [output.index!.query_id, output.index!.snapshot_id,
      output.index!.result_version, output.index!.interpretation_id, output.index!.as_of],
    remaining_tail_bytes: config.expected_source_bytes - span.content_end, stop_reason: "payload_call_cap" };
  writeFileSync(join(root, "operator.mjs"), "// Authored format control; no daemon or historical producer was executed.\n");
  const binding = { candidate: config.candidate, tree: config.tree, config_identity: chainIdentity(config),
    operator_sha256: hashRegularFileNoFollow(join(root, "operator.mjs")) };
  writeJson(join(root, "config.json"), config);
  writeJson(join(root, "preparation.json"), { ...binding, status: "prepared_not_executed", prepared_at: at,
    native_implementation_revision: config.implementation_revision });
  writeJson(join(execution, "reservation.json"), { ...binding, lane: "authored-control", reserved_at: at, retry: false });
  writeJson(join(execution, "01-request.json"), { ordinal: 1, phase: "membership", tool: "soul.recall",
    arguments: config.first_request, reserved_at: at, retry: false });
  writeJson(join(execution, "01-public-envelope.json"), envelope);
  writeJson(join(execution, "01-trusted-contexts.json"), [context]);
  writeJson(join(execution, "01-first-exposure.json"), new FirstExposureSession().record(output));
  writeFileSync(join(execution, "public-mcp-messages.jsonl"), [
    { ordinal: 1, at, direction: "client_to_server", message: { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "soul.recall", arguments: config.first_request } } },
    { ordinal: 2, at, direction: "server_to_client", message: { jsonrpc: "2.0", id: 1, result: envelope } }
  ].map(row => `${JSON.stringify(row)}\n`).join(""));
  writeJson(join(execution, "observation-final-state.json"), observation);
  writeJson(join(execution, "observation.json"), observation);
  writeJson(join(execution, "shutdown.json"), { at, shutdown_awaited: true, daemon_started: true,
    frozen_source_file_unchanged: true, snapshot_sha256: config.snapshot_sha256, failure: null, provider_calls: 0, consumer_calls: 0 });
  writeJson(join(execution, "process-result.json"), { status: "closed", close: { code: 0, signal: null },
    forced: false, child_error: null, process_in_flight: false, no_retry: true });
  return { root, config };
}
