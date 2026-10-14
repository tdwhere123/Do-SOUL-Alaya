import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { StorageDatabase } from "@do-soul/alaya-storage";
import { sourceEvidenceRootTarget, SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import { startBenchDaemon, type BenchDaemonHandle } from "../../../harness/daemon.js";
import { chainIdentity } from "../../../runs/semantic-chain/contract.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { sourceLookupStores } from "../../../runs/snapshot/source-records/publish.js";
import { restoreSnapshotToDataDir } from "../../../runs/snapshot/materialize.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { FirstExposureSession } from "../../../runs/measurement/first-exposure-session.js";
import { OrdinaryRecallCaptureConfigSchema, OrdinaryRecallEnvelopeSchema,
  ordinaryRecallReaderProtocolVersion } from "../../../runs/semantic-chain/consumer/ordinary-recall-contract.js";
import type { nativeConsumerFixture } from "./consumer.test-support.js";

export const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
export const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
type Mode = "complete" | "prefix" | "prefix_error" | "error";
export type RecallResponseCase = "invalidated" | "resource_rejected" | "interrupted" | "open" | "unknown" | "transport_partial" | "indexed_without_preview" | "complete_empty";

/** Match publicRecall finally files when await callTool rejects before observe updates its summary. */
export function captureFailedCallFixture(capture: Awaited<ReturnType<typeof captureOrdinaryFixture>>, root: string,
  options: { retainedContext: boolean; rpcError: boolean }) {
  cpSync(capture.root, root, { recursive: true });
  const execution = join(root, "execution"), ordinal = capture.observation.calls, stem = String(ordinal).padStart(2, "0");
  rmSync(join(execution, `${stem}-public-envelope.json`));
  rmSync(join(execution, `${stem}-first-exposure.json`), { force: true });
  rmSync(join(execution, "observation.json"));
  if (!options.retainedContext) writeJson(join(execution, `${stem}-trusted-contexts.json`), []);
  const wirePath = join(execution, "public-mcp-messages.jsonl");
  const wire = readFileSync(wirePath, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  const reply = wire.pop();
  if (options.rpcError) wire.push({ ...reply, message: { jsonrpc: "2.0", id: reply.message.id,
    error: { code: -32603, message: "fixture transport rejection" } } });
  writeFileSync(wirePath, `${wire.map(row => JSON.stringify(row)).join("\n")}\n`);
  const observation = ordinal === 1 ? { calls: 1, membership_calls: 1, payload_expansion_calls: 0,
    contiguous_delivered_bytes: 0, source_complete: false, first_source_exposure: null,
    pages: [], trusted_principal: null, query_identity: null, remaining_tail_bytes: capture.config.expected_source_bytes,
    stop_reason: "operator_or_transport_error" } : { ...capture.observation, stop_reason: "operator_or_transport_error" };
  writeJson(join(execution, "observation-final-state.json"), observation);
  writeJson(join(execution, "process-result.json"), { status: "failed_or_interrupted", close: { code: 1, signal: null },
    forced: false, child_error: null, process_in_flight: false, no_retry: true });
  writeJson(join(execution, "shutdown.json"), { ...readJson(join(execution, "shutdown.json")),
    failure: { name: "Error", message: "fixture public call rejection" } });
  return { root, execution, observation };
}

function prepareCapture(base: Awaited<ReturnType<typeof nativeConsumerFixture>>, mode: Mode) {
  const root = join(base.root, `ordinary-${mode}`), execution = join(root, "execution");
  mkdirSync(execution, { recursive: true });
  const plan = base.admitted.plan.config, response = base.admitted.replay.rows[0]!.response;
  assert(response?.operation === "recall");
  const target = response.results?.[0]?.target;
  assert(target?.kind === "source_evidence");
  const connection = new BetterSqlite3(plan.snapshot_path, { readonly: true });
  const stored = sourceLookupStores(new StorageDatabase(plan.snapshot_path, connection)).getStoredRecord(plan.workspace_id, target.root_id);
  assert(stored); connection.close();
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const config = OrdinaryRecallCaptureConfigSchema.parse({ capture_contract: "ordinary-recall-local-capture-v1",
    public_semantics: "conditional-field-source-only-v1", protocol_package_version: ordinaryRecallReaderProtocolVersion(),
    candidate, tree, implementation_revision: readCurrentExtractionAuthorityRevision(),
    snapshot_path: plan.snapshot_path, snapshot_sha256: plan.snapshot_sha256,
    workspace_id: plan.workspace_id, run_id: plan.run_id,
    first_request: { query: base.admitted.plan.queries[0]!.original_query, scope_class: "project", dimension: null,
      domain_tags: null, max_results: 8, source_observed_at: plan.interpretation_clock,
      enumeration_policy: "canonical", result_kind_view: "source_only", protocol_version: 1, supports_source_evidence: true },
    expected_target: sourceEvidenceRootTarget(target), expected_source_bytes: Buffer.byteLength(stored.content_bytes),
    bounds: { membership_calls: 1, payload_expansion_calls: 6, total_recall_calls: 7,
      payload_byte_budget: 4096, public_envelope_observation_bytes: 1048576,
      default_native_request: { schema_version: 1, work_units: 10000, memory_bytes: 1000000,
        page_budget: 8, finalization_reserve: 100, min_envelope: 10 } }, provider_calls: 0, consumer_calls: 0 });
  copyFileSync(fileURLToPath(import.meta.url), join(root, "operator.mjs"));
  const operator_sha256 = hashRegularFileNoFollow(join(root, "operator.mjs"));
  writeJson(join(root, "config.json"), config);
  writeJson(join(root, "preparation.json"), { status: "prepared_not_executed", prepared_at: new Date().toISOString(),
    candidate, tree, native_implementation_revision: config.implementation_revision,
    config_identity: chainIdentity(config), operator_sha256 });
  writeJson(join(execution, "reservation.json"), { candidate, tree, lane: "native-test", reserved_at: new Date().toISOString(),
    config_identity: chainIdentity(config), operator_sha256, retry: false });
  return { root, execution, config, stored };
}

/** The fixture captures the physical SDK transport and the handler context of real daemon calls. */
export async function captureOrdinaryFixture(base: Awaited<ReturnType<typeof nativeConsumerFixture>>, mode: Mode) {
  const { root, execution, config, stored } = prepareCapture(base, mode);
  const working = join(root, "working");
  restoreSnapshotToDataDir({ snapshotDbPath: config.snapshot_path, expectedSha256: config.snapshot_sha256, dataDirRoot: working });
  const daemon = await startBenchDaemon({ dataDirRoot: working, workspaceId: config.workspace_id, runId: config.run_id,
    embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  const contexts: unknown[] = [], tap = observeTransport(daemon, execution, contexts, mode);
  const exposures = new FirstExposureSession(), pages: unknown[] = [];
  let request = config.first_request;
  let ordinal = 0, end = 0, complete = false, firstSource: unknown = null, identity: unknown = null;
  let principal: unknown = null, stop = "total_call_cap";
  try {
    while (++ordinal <= config.bounds.total_recall_calls) {
      const phase = ordinal === 1 ? "membership" : "payload", stem = String(ordinal).padStart(2, "0");
      contexts.length = 0;
      writeJson(join(execution, `${stem}-request.json`), { ordinal, phase, tool: "soul.recall", arguments: request,
        reserved_at: new Date().toISOString(), retry: false });
      const envelope = OrdinaryRecallEnvelopeSchema.parse(await daemon.mcpClient.callTool({ name: "soul.recall", arguments: request }));
      writeJson(join(execution, `${stem}-public-envelope.json`), envelope);
      writeJson(join(execution, `${stem}-trusted-contexts.json`), contexts);
      principal ??= contexts[0];
      const block = envelope.content.find(item => item.type === "text");
      assert(block?.type === "text" && typeof block.text === "string");
      const payload = JSON.parse(block.text);
      if (payload.ok !== true) { stop = "public_error"; break; }
      const output = SoulMemorySearchResponseSchema.parse(payload.output), index = output.index;
      assert(index);
      writeJson(join(execution, `${stem}-first-exposure.json`), exposures.record(output, request.continuation));
      identity ??= [index.query_id, index.snapshot_id, index.result_version, index.interpretation_id, index.as_of];
      const row = output.results[0]; assert(row?.target.kind === "source_evidence");
      const span = row.target.span; assert(span);
      assert.equal(span.content_start, end);
      assert.equal(row.content_preview, Buffer.from(stored.content_bytes).subarray(span.content_start, span.content_end).toString("utf8"));
      assert(span.content_end > end);
      pages.push({ ordinal, phase, delivery_id: output.delivery_id, completeness: index.completeness,
        continuation: index.continuation, span, preview_bytes: Buffer.byteLength(row.content_preview), accepted_contiguous_span: true });
      end = span.content_end;
      firstSource ??= { ordinal, delivery_id: output.delivery_id, span };
      complete = span.content_complete && end === config.expected_source_bytes;
      if (complete) { stop = "complete_public_body"; break; }
      if (mode === "prefix") { stop = "payload_call_cap"; break; }
      assert(index.continuation);
      const target = index.entries[0]!.target; assert(target.kind === "source_evidence");
      request = { ...config.first_request, continuation: index.continuation, payload_continuation: {
        schema_version: 1, purpose: "payload_expansion", target,
        start_offset: end, byte_budget: config.bounds.payload_byte_budget } };
    }
  } finally { tap(); await daemon.shutdown(); }
  assert(ordinal <= config.bounds.total_recall_calls);
  const observation = { calls: ordinal, membership_calls: 1, payload_expansion_calls: ordinal - 1,
    contiguous_delivered_bytes: end, source_complete: complete, first_source_exposure: firstSource,
    pages, trusted_principal: principal, query_identity: identity, remaining_tail_bytes: config.expected_source_bytes - end, stop_reason: stop };
  writeJson(join(execution, "observation-final-state.json"), observation);
  writeJson(join(execution, "observation.json"), observation);
  writeJson(join(execution, "shutdown.json"), { at: new Date().toISOString(), shutdown_awaited: true, daemon_started: true,
    frozen_source_file_unchanged: hashRegularFileNoFollow(config.snapshot_path) === config.snapshot_sha256,
    snapshot_sha256: config.snapshot_sha256, failure: null, provider_calls: 0, consumer_calls: 0 });
  writeJson(join(execution, "process-result.json"), { status: "closed", close: { code: 0, signal: null },
    forced: false, child_error: null, process_in_flight: false, no_retry: true });
  return { root, config, observation, execution, body: stored.content_bytes };
}

export function observeTransport(daemon: BenchDaemonHandle, execution: string, contexts: unknown[], mode: Mode,
  responseCase?: RecallResponseCase) {
  const transport = daemon.mcpClient.transport; assert(transport);
  const send = transport.send, receive = transport.onmessage; assert(receive);
  const handler = daemon.runtime.services.mcpMemoryToolHandler, originalCall = handler.call;
  let ordinal = 0, calls = 0;
  const retain = (direction: string, message: unknown) => appendFileSync(join(execution, "public-mcp-messages.jsonl"),
    `${JSON.stringify({ ordinal: ++ordinal, at: new Date().toISOString(), direction, message })}\n`);
  transport.send = function (...args) { retain("client_to_server", args[0]); return Reflect.apply(send, this, args); };
  transport.onmessage = function (...args) { retain("server_to_client", args[0]); return Reflect.apply(receive, this, args); };
  handler.call = async function (input) {
    const context = input.context;
    contexts.push({ workspaceId: context.workspaceId, runId: context.runId, sessionId: context.sessionId,
      agentTarget: context.agentTarget, surfaceId: context.surfaceId ?? null });
    calls += 1;
    if (mode === "error" || mode === "prefix_error" && calls === 2) {
      return { ok: false, tool_name: "soul.recall", error: { code: "UNAVAILABLE", message: "fixture terminal failure" } };
    }
    const result = await Reflect.apply(originalCall, this, [input]);
    if (responseCase === undefined || !result.ok || result.tool_name !== "soul.recall") return result;
    const output = SoulMemorySearchResponseSchema.parse(result.output);
    assert(output.index);
    const completeness = responseCase === "complete_empty"
      ? { ...output.index.completeness, logical_index: "complete" as const, transport: "complete" as const, payload: "complete" as const }
      : responseCase === "transport_partial" || responseCase === "indexed_without_preview"
      ? { ...output.index.completeness, transport: "partial" as const }
      : { ...output.index.completeness, logical_index: responseCase, payload: responseCase };
    return { ...result, output: { ...output, results: [], index: { ...output.index,
      entries: responseCase === "indexed_without_preview" ? output.index.entries : [], continuation: null,
      page_purpose: undefined, completeness } } };
  };
  return () => { transport.send = send; transport.onmessage = receive; handler.call = originalCall; };
}
