import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalJson, UNKNOWN_UTTERANCE_ATTRIBUTION } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { readVerifiedNativeSourceSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { censusNativeSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { nativeSourceOccurrenceId, nativeSourceRequestInventory } from "../../../runs/extraction/fill/source-request-workset.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { declareRecoveryInitialQueryPreparation, freezeNativeRecoveryWindow, admitRecoveryWindow } from
  "../../../runs/semantic-chain/recovery-window.js";
import { CLOCK, OBSERVED, URL, MODEL, H_PROFILE, Q_PROFILE, BUDGET, ALLOWANCE,
  queryRaw, fillProposal, prepareRetainedRecoverySnapshot } from "./native-recovery-provider.test-support.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("freezes exact retained occurrence keys across shared bodies, roles, attribution, empty and unsupported records", async () => {
  const root = mkdtempSync(join(tmpdir(), "retained-recovery-window-")); roots.push(root);
  const snapshotPath = join(root, "source.sqlite"), recoveryRoot = join(root, "recovery");
  const body = "Mira used Parquet for the Atlas export.\n";
  const captured = { contract: "utterance-attribution-v1" as const, status: "captured" as const,
    issuer_scope: "retained-conversation", utterances: [{ occurrence_id: "original-utterance",
      utf8_span: [0, Buffer.byteLength(body)] as const, conversation_ref: "retained-conversation", author_ref: "retained-author" }] };
  const sources = [
    { source_id: "user-source", content_bytes: body, speaker: "user" as const, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    { source_id: "assistant-source", content_bytes: body, speaker: "assistant" as const, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    { source_id: "captured-source", content_bytes: body, speaker: "assistant" as const, attribution_context: captured },
    { source_id: "shared-captured-source", content_bytes: body, speaker: "assistant" as const, attribution_context: captured },
    { source_id: "empty-source", content_bytes: "", speaker: "user" as const, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    { source_id: "unsupported-source", content_bytes: Array.from({ length: 129 }, (_, index) =>
      `The assistant recorded source fact ${index + 1}.`).join("\n"),
    speaker: "assistant" as const, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION }
  ];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error("Unexpected provider dispatch"); });
  vi.stubGlobal("fetch", fetch);
  await prepareRetainedRecoverySnapshot(root, snapshotPath, "retained-window",
    sources.map(source => ({ ...source, event_time: OBSERVED })));
  const native = readVerifiedNativeSourceSnapshot(snapshotPath);
  const census = censusNativeSourceRecords({ population: "originals", snapshotPath });
  const inventory = nativeSourceRequestInventory(census.records, census.dataset_sha256, {
    model: MODEL, requestProfile: H_PROFILE, sourcePacking: "complete-source",
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION });
  expect(inventory.requests).toHaveLength(4);
  expect(inventory.unsupportedSources).toHaveLength(1);
  const expectedBySource = new Map(sources.map(source => [source.source_id,
    inventory.requests.find(row => {
      const request = parseSourceSemanticRequest(JSON.parse(row.line.userPrompt)).source_request;
      return row.sourceCorpus === source.content_bytes && request.source_role === source.speaker &&
        canonicalJson(request.attribution_context) === canonicalJson(source.attribution_context);
    })?.line.key ?? null]));
  expect(new Set([...expectedBySource.values()].filter(key => key !== null)).size).toBe(4);
  expect(expectedBySource.get("captured-source")).toBe(expectedBySource.get("shared-captured-source"));
  expect(expectedBySource.get("user-source")).not.toBe(expectedBySource.get("assistant-source"));
  expect(expectedBySource.get("assistant-source")).not.toBe(expectedBySource.get("captured-source"));
  expect(expectedBySource.get("empty-source")).not.toBeNull();
  expect(expectedBySource.get("unsupported-source")).toBeNull();
  const qCache = join(root, "q-cache"), qPath = join(root, "q.json");
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
    model: MODEL, request_profile: Q_PROFILE, provider_url: URL,
    items: [{ original_query: "Which file format did Mira use for the Atlas export?" }] });
  writeFileSync(qPath, JSON.stringify(workset));
  const input = { native_snapshot_path: snapshotPath, population: "originals", source_model: MODEL,
    source_request_profile: H_PROFILE, source_cache_root: join(root, "h-cache"),
    recorded_at: CLOCK, producer_commit: "0".repeat(40), allowance: ALLOWANCE,
    chain: { implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: CLOCK,
      workspace_id: "retained-window", run_id: "retained-window", query_workset: workset,
      query_cache_root: qCache, correspondence_cache_root: join(root, "c-cache"), max_output_tokens: 16_384,
      correspondence_generation: { model: MODEL, request_profile: H_PROFILE, provider_url: URL, max_output_tokens: 16_384 },
      discovery_page_cap: 1, correspondence_pair_cap: 6, access_policy: "query-conditioned-v1", budget: BUDGET,
      source_preview_extents: native.records.map(row => ({ source_id: row.source_id,
        source_version: row.source_version, record_id: row.record.identity,
        byte_extent: Math.max(1, Math.min(4096, Buffer.byteLength(row.content_bytes))) })),
      authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 1_000_000 } };
  declareRecoveryInitialQueryPreparation(input, recoveryRoot);
  await fillProposal(qPath, qCache, () => queryRaw(false, false), Q_PROFILE);
  const window = await freezeNativeRecoveryWindow(input, recoveryRoot);
  expect(window.window).toHaveLength(6);
  expect(window.selected_missing_keys).toEqual(inventory.requests.map(row => row.line.key).sort());
  for (const row of window.window) expect(row).toMatchObject({ source_observed_at: OBSERVED,
    initial_key: expectedBySource.get(row.source_id),
    initial_cache_status: row.source_id === "unsupported-source" ? "unsupported" : "missing" });
  const frozenBytes = readFileSync(join(recoveryRoot, "recovery-window.json"));
  expect(await freezeNativeRecoveryWindow(input, recoveryRoot)).toEqual(window);
  expect(admitRecoveryWindow(recoveryRoot)).toEqual(window);
  expect(readFileSync(join(recoveryRoot, "recovery-window.json"))).toEqual(frozenBytes);
  expect(fetch).not.toHaveBeenCalled();
  for (const source of census.records) expect(inventory.requestKeysByOccurrence.get(nativeSourceOccurrenceId(source)) ?? null)
    .toBe(expectedBySource.get(source.source_id));
}, 60_000);
