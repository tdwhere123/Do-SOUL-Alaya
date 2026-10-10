import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolation = await vi.hoisted(async () => {
  const guard = "../../../../../core-daemon/src/__tests__/support/provider-free-cli.mjs";
  await import(guard);
  const [{ default: http }, { default: https }, { default: net }, { default: tls },
    { default: http2 }, { default: dgram }, { default: fs }, { default: fsp }, { syncBuiltinESMExports }] =
    await Promise.all([import("node:http"), import("node:https"), import("node:net"), import("node:tls"),
      import("node:http2"), import("node:dgram"), import("node:fs"), import("node:fs/promises"), import("node:module")]);
  const restores: (() => void)[] = [], forbidden: string[] = [];
  function block(owner: object, key: string) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
    Object.defineProperty(owner, key, { ...descriptor, value: () => {
      forbidden.push(key); throw new Error(`Provider-free recovery test forbids ${key}`);
    } });
    restores.push(() => Object.defineProperty(owner, key, descriptor));
  }
  for (const owner of [http, https]) for (const key of ["request", "get"]) block(owner, key);
  for (const key of ["connect", "createConnection"]) block(net, key);
  block(net.Socket.prototype, "connect"); block(tls, "connect"); block(http2, "connect");
  block(dgram, "createSocket"); block(globalThis, "fetch");
  const environment = process.env;
  process.env = new Proxy(environment, { get(target, key) {
    if (typeof key === "string" && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)) {
      forbidden.push("credential environment"); throw new Error("Credential environment access forbidden");
    }
    return Reflect.get(target, key);
  } });
  restores.push(() => { process.env = environment; });
  for (const owner of [fs, fsp]) for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor?.value === undefined) continue;
    Object.defineProperty(owner, key, { ...descriptor, value: new Proxy(descriptor.value, {
      apply(target, receiver, args) {
        if (/(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.aws|\.azure|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(String(args[0]))) {
          forbidden.push("credential file"); throw new Error("Credential file access forbidden");
        }
        return Reflect.apply(target, receiver, args);
      }
    }) });
    restores.push(() => Object.defineProperty(owner, key, descriptor));
  }
  syncBuiltinESMExports();
  return { forbidden, restore: () => { for (const restore of restores.reverse()) restore(); syncBuiltinESMExports(); } };
});

import {
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION, UNKNOWN_UTTERANCE_ATTRIBUTION,
  SourceSemanticInterpretationSchema, sourceSemanticInterpretationIdentity
} from "@do-soul/alaya-protocol";
import { fieldContractSha256, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { authoredQuerySemantics } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-producer-fixture.js";
import { buildRecoveryCorrespondenceWorkset } from "../../../runs/semantic-chain/recovery-correspondence.js";
import { bindRecoveryReasonCorrespondence, buildRecoveryReasonCorrespondenceItems,
  nominateRecoverySource, selectRecoveryNomination } from
  "../../../runs/semantic-chain/recovery-reason.js";
import { materializeSemanticProposalLines } from "../../../runs/semantic-proposal/workset.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, prepareSourceSemanticRequestLine,
  sourceSemanticArtifactPreparations } from "../../../runs/extraction/request-artifact.js";
import { parseSourceSemanticInteractivePreflight } from
  "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { prepareSourceSemanticRequestWire, sourceSemanticRequestWireDigest,
  sourceSemanticInteractiveWireSha256, SOURCE_SEMANTIC_INTERACTIVE_WIRE_DIGEST_CONTRACT } from
  "../../../runs/extraction/fill/source-semantic-interactive-request.js";
import { attemptInputByteUpperBound } from "../../../runs/extraction/authority/receipt-limits.js";
import { buildExtractionTransportProvenance } from "../../../runs/extraction/transport-route.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from
  "../../../runs/extraction/authority/receipt.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionPreservedValidClosure } from
  "../../../runs/extraction/authority/repair/preserved-valid-closure.js";
import { EXTRACTION_CACHE_KEY_ALGO, computeSystemPromptSha256 } from
  "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { openExtractionAttemptLedger } from "../../../runs/extraction/authority/attempt-ledger.js";
import { ProviderRawAttemptIdentityError, providerRawAttemptPath, writeProviderRawAttempt } from
  "../../../runs/extraction/fill/provider-raw-attempt.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { isolation.restore(); expect(isolation.forbidden).toEqual([]); });

const ORIGINAL = "which parcel was sent and inspected?";
const GENERATION = { model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1", provider_url: "http://127.0.0.1:9" };
const OPTIONS = { correspondence_demand: { kind: "query_branches" as const, maximum_demands_per_interpretation: 2 }, correspondence_cap: 2 };
const TOKENS = 4096;

function fixture(version = "1") {
  const query = authoredQuerySemantics({ original_query: ORIGINAL, producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" }, {
    variables: [{ id: "parcel", sort: "entity" }, { id: "pSend", sort: "proposition" }, { id: "pInspect", sort: "proposition" }],
    alternatives: [{ frames: ["Send", "Inspect"].map(name => ({ id: `q${name}`, variable: `p${name}`,
      predicate_reading: name.toLowerCase(), role_requirements: [{ id: "object", role_reading: "object", target_variable: "parcel",
        support: { kind: "query_text", excerpt: "parcel" } }] })),
      context_obligations: ["qSend", "qInspect"].map(frame => ({ frame, kind: "asserted_at_source" })),
      answer_frames: [], evidence_inputs: [{ frames: ["qSend"] }, { frames: ["qInspect"] }] }],
    return_variables: ["parcel"], gaps: [],
    requested_operation: { reading: "identify parcel", support: { kind: "query_text", excerpt: "which parcel" } }
  }).query;
  const interpretation = SourceSemanticInterpretationSchema.parse({ contract: "source-interpretation-v4",
    k_version: SOURCE_SEMANTIC_K_VERSION, normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "src", source_version: version, content_digest: `sha256:${fieldContractSha256(ORIGINAL)}`,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION }, producer_id: "source-producer", producer_version: "1",
    contract_version: "source-interpretation-v4",
    mentions: [{ id: "mSent", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" }, text: "sent", utf8_span: [0, 4] }],
    referents: [], frames: [{ id: "fSend", assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [], predicate_support: { kind: "explicit", reading: "send", mentions: ["mSent"] },
      slots: [], bindings: [] }], operators: [], gaps: [], entry_roots: ["fSend"], asserted_at_scope: ["fSend"] });
  const descriptor = { source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256), interpretation };
  return { query: { original_query: ORIGINAL, query_semantics: query },
    selected: [{ source_id: "src", source_version: version, record_id: "record", descriptor }] };
}

function rows(workset: NonNullable<ReturnType<typeof buildRecoveryCorrespondenceWorkset>>) {
  return materializeSemanticProposalLines(workset, TOKENS).map(line => ({ line }));
}

it("preserves omitted full-catalog bytes and binds one C per H without a v7 contract check", () => {
  const { query, selected } = fixture();
  const items = buildRecoveryReasonCorrespondenceItems(query, selected);
  expect(items).toHaveLength(1);
  expect("generation_policy" in items[0]!).toBe(false);
  const workset = buildRecoveryCorrespondenceWorkset(query, selected, GENERATION)!;
  expect(workset.items).toEqual(items);
  const bound = bindRecoveryReasonCorrespondence(rows(workset), selected, query);
  expect(bound).toHaveLength(1);
  expect(bound[0]!.descriptor.source_interpretation_id).toBe(selected[0]!.descriptor.source_interpretation_id);
  expect((bound[0]!.row.line.request as SourceSemanticCorrespondenceRequest).contract)
    .toBe("source-semantic-correspondence-request-v7");
  expect("generation_policy" in bound[0]!.row.line.request).toBe(false);
});

it("binds two scoped C for one H by policy cache material, not workset index", () => {
  const { query, selected } = fixture();
  const second = fixture("2").selected;
  const both = [...selected, ...second];
  const options = { ...OPTIONS, correspondence_cap: 3 };
  const items = buildRecoveryReasonCorrespondenceItems(query, both, options);
  expect(items.map(item => item.source_interpretation_descriptors[0]!.source_interpretation_id))
    .toEqual([selected[0]!.descriptor.source_interpretation_id, selected[0]!.descriptor.source_interpretation_id,
      second[0]!.descriptor.source_interpretation_id]);
  expect(items.every(item => "generation_policy" in item)).toBe(true);
  const workset = buildRecoveryCorrespondenceWorkset(query, both, GENERATION, options)!;
  expect(workset.items).toEqual(items);
  const bound = bindRecoveryReasonCorrespondence(rows(workset), both, query, options);
  expect(bound.map(row => row.descriptor.source_interpretation_id))
    .toEqual(items.map(item => item.source_interpretation_descriptors[0]!.source_interpretation_id));
  expect(new Set(bound.map(row => (row.row.line.request as SourceSemanticCorrespondenceRequest).contract)))
    .toEqual(new Set(["source-semantic-correspondence-request-v9"]));
  expect(() => bindRecoveryReasonCorrespondence(rows(workset).slice(0, 1), both, query, options))
    .toThrow(/denominator changed/u);
});

it("fails closed on unpaired preparation options, duplicate C material, or a foreign H", () => {
  const { query, selected } = fixture();
  expect(() => buildRecoveryReasonCorrespondenceItems(query, selected, { correspondence_cap: 1 }))
    .toThrow(/must appear together/u);
  const workset = buildRecoveryCorrespondenceWorkset(query, selected, GENERATION, OPTIONS)!;
  const duplicate = rows(workset);
  expect(() => bindRecoveryReasonCorrespondence([...duplicate, ...duplicate], selected, query, OPTIONS))
    .toThrow(/denominator changed|binds frozen Q and published H/u);
  expect(() => bindRecoveryReasonCorrespondence(rows(workset), fixture("2").selected, query, OPTIONS))
    .toThrow(/binds frozen Q and published H/u);
});

const KEY = "ab".repeat(32);
const REASON = { identity: "reason", qualified_snapshot_identity: "publication", results: [] };

function frozenSource(sourceId: string, initialKey: string | null = null) {
  return {
    rank: 1 as const, source_id: sourceId, source_version: "1", record_id: `record-${sourceId}`,
    content_digest: `sha256:${KEY}`, corpus_digest: KEY, source_observed_at: "2026-09-20T12:00:00.000Z",
    recorded_at: "2026-09-21T09:00:00.000Z", body_bytes: 12, read_bytes: 12, complete: false,
    initial_key: initialKey, initial_cache_status: initialKey === null ? "missing" as const : "hit" as const
  };
}

function qualifiedSnapshot(source_owners: readonly {
  key: string; cache_root: string; current_preflight_path: string; physical_preflight_path?: string;
}[], exported: ReturnType<typeof frozenSource>[] = []) {
  return {
    contract: "source-semantic-initial-qualified-v1" as const, window_identity: "window",
    source_preflight_identity: "preflight", source_preflight_path: "/tmp/preflight.json",
    source_cache_root: "/tmp/cache", source_owners: [...source_owners], association_identity: "assoc",
    snapshot_path: "/tmp/snap.sqlite", snapshot_sha256: "0".repeat(64), publication_identity: "publication",
    published_selected_count: exported.length,
    descriptor_export: exported.map(source => ({
      source_id: source.source_id, source_version: source.source_version, record_id: source.record_id,
      generation_key: KEY, descriptor: { source_interpretation_id: `sha256:${KEY}`, interpretation: {} }
    }))
  };
}

it("nominates an eligible frozen source when physical-parent eligibility is already supplied", () => {
  const survivor = frozenSource("survivor");
  const other = frozenSource("other", KEY);
  expect(selectRecoveryNomination([other, survivor], "publication", REASON, [survivor])).toMatchObject({
    source_id: "survivor", nomination: "frozen_window_after_unbound_reason" });
  expect(() => selectRecoveryNomination([other, survivor], "publication", REASON, [])).toThrow(/no frozen source/u);
});

it("keeps an explicit null initial key ineligible without treating it as a parent read failure", () => {
  const unbound = frozenSource("unbound");
  const survivor = frozenSource("survivor");
  expect(nominateRecoverySource([unbound, survivor], qualifiedSnapshot([], [survivor]), REASON)).toMatchObject({
    source_id: "survivor", nomination: "frozen_window_after_unbound_reason" });
  expect(() => nominateRecoverySource([unbound], qualifiedSnapshot([]), REASON)).toThrow(/no frozen source/u);
});

it("rejects nomination when a physical parent cannot be read even if another frozen source is eligible", () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-corrupt-parent-")); roots.push(root);
  const preflightPath = join(root, "parent-preflight.json");
  writeFileSync(preflightPath, "{");
  const survivor = frozenSource("survivor");
  const corrupt = frozenSource("corrupt", KEY);
  const settled = qualifiedSnapshot([{ key: KEY, cache_root: join(root, "cache"), current_preflight_path: preflightPath }],
    [survivor]);
  expect(() => nominateRecoverySource([survivor, corrupt], settled, REASON)).toThrow();
});

it("nominates a survivor when the initial key is absent from source owners", () => {
  const survivor = frozenSource("survivor");
  const absent = frozenSource("absent", KEY);
  expect(nominateRecoverySource([survivor, absent], qualifiedSnapshot([], [survivor]), REASON)).toMatchObject({
    source_id: "survivor", nomination: "frozen_window_after_unbound_reason" });
});

const PARENT_MODEL = "gemini-3.1-flash-lite";
const PARENT_PROFILE = "gemini-3.1-minimal-v1" as const;
const PARENT_URL = "https://generativelanguage.googleapis.com";

function writeOwnedPreflight() {
  const root = mkdtempSync(join(tmpdir(), "recovery-owned-parent-")); roots.push(root);
  const cacheRoot = join(root, "cache");
  mkdirSync(cacheRoot, { recursive: true });
  const config = {
    model: PARENT_MODEL, requestProfile: PARENT_PROFILE, providerUrl: PARENT_URL, apiKey: null,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION
  };
  const [prepared] = sourceSemanticArtifactPreparations("Mira arrived.\n", "complete-source",
    EXTRACTION_OPEN_SEMANTICS_GENERATION);
  if (prepared?.status !== "ready") throw new Error("owned parent fixture requires a ready source request");
  const line = prepareSourceSemanticRequestLine(prepared.semantic, [], config);
  const maxOutputTokens = 4096;
  const wire = prepareSourceSemanticRequestWire(config, line, maxOutputTokens);
  const quote = {
    contract: "gemini-source-experimental-quote-v1" as const, selected_model: PARENT_MODEL,
    selected_provider_url: PARENT_URL, value_kind: "declared_experimental_usd_policy_not_invoice" as const,
    input_usd_equivalent_per_million: 0.25, output_usd_equivalent_per_million: 1.5
  };
  const inputUpper = attemptInputByteUpperBound(wire.body);
  const planned = {
    ...line, request_digest: sourceSemanticRequestWireDigest(config, line, maxOutputTokens),
    wire_sha256: sourceSemanticInteractiveWireSha256(config, line, maxOutputTokens),
    request_url: wire.url.href, input_byte_upper: inputUpper
  };
  const preflight = parseSourceSemanticInteractivePreflight({
    contract: "source-semantic-interactive-preflight-v3", execution_authorized: false, provider_calls: 0,
    dataset_revision: "a".repeat(64), source_occurrences: 1, unsupported_source_occurrences: 0,
    unsupported_sources: [], total_requests: 1, selected_requests: 1, selected_keys: [line.key],
    cached_requests: 0, deterministic_requests: 0, config, transport_provenance: buildExtractionTransportProvenance(config),
    quote_basis: quote, max_output_tokens: maxOutputTokens,
    wire_digest_contract: SOURCE_SEMANTIC_INTERACTIVE_WIRE_DIGEST_CONTRACT, output_token_field: "maxOutputTokens",
    maximum_attempts_per_key: 1, maximum_input_tokens_per_attempt: inputUpper, input_token_bound: inputUpper,
    cost_bound_usd: (inputUpper * quote.input_usd_equivalent_per_million +
      maxOutputTokens * quote.output_usd_equivalent_per_million) / 1_000_000,
    planned_requests: [planned], ready_requests: [line]
  });
  const preflightPath = join(root, "parent-preflight.json");
  writeFileSync(preflightPath, JSON.stringify(preflight));
  return { cacheRoot, preflightPath, preflight, line, config, quote, maxOutputTokens };
}

function ownedSnapshot(owned: ReturnType<typeof writeOwnedPreflight>, exported: ReturnType<typeof frozenSource>[] = []) {
  return qualifiedSnapshot([{ key: owned.line.key, cache_root: owned.cacheRoot,
    current_preflight_path: owned.preflightPath }], exported);
}

function writeIncompletePhysicalParent(owned: ReturnType<typeof writeOwnedPreflight>) {
  const { cacheRoot, preflight, line, config, quote, maxOutputTokens } = owned;
  const observation = {
    revision: "0".repeat(40), commandDigest: "1".repeat(64), selectionDigest: "2".repeat(64),
    keyDigest: "3".repeat(64),
    dataset: { variant: "native_source_snapshot", revisionSha256: preflight.dataset_revision, windowOffset: 0,
      windowLimit: 1, expectedKeySetSha256: "4".repeat(64) },
    extraction: {
      model: config.model, modelFamily: config.model, requestProfile: config.requestProfile,
      sourcePacking: "complete-source" as const, providerUrl: config.providerUrl,
      systemPromptSha256: computeSystemPromptSha256(line.systemPrompt),
      cacheKeyAlgorithm: EXTRACTION_CACHE_KEY_ALGO, manifestSha256: null, rawContentClosureSha256: null
    },
    transport: { providerUrl: config.providerUrl, model: config.model },
    inventory: { expectedTurns: 1, validTurns: 0, missingTurns: 1, invalidTurns: 0, orphanTurns: 0 }
  };
  const inspection = {
    observation, sourceOccurrences: 1, unsupportedSourceOccurrences: 0, missingKeys: [line.key],
    pendingShards: [], nonemptyKeys: [line.key], invalidShards: [],
    preservedValidClosure: createExtractionPreservedValidClosure([]), writerLock: "absent" as const,
    disk: { status: "available" as const, freeBytes: 1_000_000_000 }, credentialStatus: "absent" as const,
    modelReadiness: "not_probed" as const
  };
  const receipt = createExtractionAuthorityReceipt({
    action: "sample", observation, inspection, sampleScope: createExtractionSampleScope([line.key], inspection),
    sourcePreflight: preflight, maxConcurrency: 1,
    outputTokenCap: { field: "maxOutputTokens", value: maxOutputTokens }, diskFloorBytes: 0,
    priceEstimate: {
      inputUsdPerMillion: quote.input_usd_equivalent_per_million,
      outputUsdPerMillion: quote.output_usd_equivalent_per_million,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt
    }
  });
  writeExtractionAuthorityReceipt(join(cacheRoot, `interactive-authority-${receipt.receipt_digest}.json`), receipt);
  writeProviderRawAttempt({
    root: cacheRoot, cacheKey: line.key, attemptOrdinal: 1, model: config.model,
    requestProfile: config.requestProfile, requestDigest: preflight.planned_requests[0]!.request_digest,
    decodedText: "{}", finishReason: null, kind: "source_semantic",
    authorityReceiptDigest: receipt.receipt_digest, authorityLineageDigest: receipt.lineage_digest,
    sourceRequestSha256: line.requestSha256
  });
  const ledger = openExtractionAttemptLedger({
    cacheRoot, lineageDigest: receipt.lineage_digest,
    cacheIdentity: { model: config.model, requestProfile: config.requestProfile },
    startingMissing: 1, maximumAttempts: 1, successfulShardCeiling: 1, maximumAttemptsPerKey: 1
  });
  ledger.reserveAttemptOrdinal(line.key);
  ledger.recordTransportOutcome(line.key, { retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1 }, 1);
}

it("keeps a readable preflight without a matching parent row ineligible", () => {
  const owned = writeOwnedPreflight();
  const survivor = frozenSource("survivor");
  const foreign = frozenSource("foreign", KEY);
  expect(nominateRecoverySource([survivor, foreign], qualifiedSnapshot([{ key: KEY, cache_root: owned.cacheRoot,
    current_preflight_path: owned.preflightPath }], [survivor]), REASON)).toMatchObject({
    source_id: "survivor", nomination: "frozen_window_after_unbound_reason" });
});

it("keeps a readable preflight with a missing raw parent ineligible", () => {
  const owned = writeOwnedPreflight();
  const survivor = frozenSource("survivor");
  const missing = frozenSource("missing", owned.line.key);
  expect(nominateRecoverySource([survivor, missing], ownedSnapshot(owned, [survivor]), REASON)).toMatchObject({
    source_id: "survivor", nomination: "frozen_window_after_unbound_reason" });
});

it("keeps a readable preflight with an incomplete physical parent ineligible", () => {
  const owned = writeOwnedPreflight();
  writeIncompletePhysicalParent(owned);
  const survivor = frozenSource("survivor");
  const incomplete = frozenSource("incomplete", owned.line.key);
  expect(nominateRecoverySource([survivor, incomplete], ownedSnapshot(owned, [survivor]), REASON)).toMatchObject({
    source_id: "survivor", nomination: "frozen_window_after_unbound_reason" });
});

it("rejects a malformed owned raw even if another frozen source is eligible", () => {
  const owned = writeOwnedPreflight();
  mkdirSync(join(owned.cacheRoot, "provider-raw", owned.line.key.slice(0, 2)), { recursive: true });
  writeFileSync(providerRawAttemptPath(owned.cacheRoot, owned.line.key, 1), "{");
  const survivor = frozenSource("survivor");
  const malformed = frozenSource("malformed", owned.line.key);
  expect(() => nominateRecoverySource([survivor, malformed], ownedSnapshot(owned, [survivor]), REASON))
    .toThrow(ProviderRawAttemptIdentityError);
});
