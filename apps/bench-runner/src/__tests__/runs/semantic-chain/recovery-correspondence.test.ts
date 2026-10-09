import { afterAll, afterEach, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  // Reuse the CLI test's preimport provider guard before loading native execution.
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

// Publication wiring is outside this helper contract; retain real request/cache/revision execution.
vi.mock("../../../runs/semantic-chain/recovery-publication.js", () => ({}));
vi.mock("../../../runs/semantic-chain/recovery-final-publication.js", () => ({}));
vi.mock("../../../runs/semantic-chain/recovery-query-review.js", () => ({}));
vi.mock("../../../runs/semantic-chain/recovery-reason.js", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION, UNKNOWN_UTTERANCE_ATTRIBUTION,
  SourceSemanticInterpretationSchema, SourceSemanticReasoningResultSchema,
  sourceSemanticInterpretationIdentity, sourceSemanticCorrespondenceIdentity, sourceSemanticQueryIdentity
} from "@do-soul/alaya-protocol";
import { fieldContractSha256, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { authoredQuerySemantics } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-producer-fixture.js";
import { syntheticGeminiBody } from "../semantic-proposal/gemini-response-evidence.test-support.js";
import { buildRecoveryCorrespondenceWorkset, applyAffectedRecoveryCorrespondencePolicy } from
  "../../../runs/semantic-chain/recovery-correspondence.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { readSemanticChainProposalResults } from "../../../runs/semantic-chain/inputs.js";

const ORIGINAL = "which parcel was sent and inspected?";
const GENERATION = { model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1", provider_url: "http://127.0.0.1:9" };
const OPTIONS = { correspondence_demand: { kind: "query_branches" as const, maximum_demands_per_interpretation: 2 }, correspondence_cap: 2 };
const TOKENS = 4096;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { isolation.restore(); expect(isolation.forbidden).toEqual([]); });

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

function lines(workset: NonNullable<ReturnType<typeof buildRecoveryCorrespondenceWorkset>>) {
  return materializeSemanticProposalLines(workset, TOKENS);
}

function policyInput(workset: ReturnType<typeof buildRecoveryCorrespondenceWorkset>, selected = fixture().selected) {
  return { selected, baseWorkset: workset, initialWorkset: workset, initialCacheRoot: "unused-cache", maxOutputTokens: TOKENS,
    queryChanged: false, nomination: { source_id: "src", source_version: selected[0]!.source_version, record_id: "record" }, reasonResults: [] };
}

it("builds two distinct branch demands for one H and caps the total C across H", () => {
  const { query, selected } = fixture();
  const workset = buildRecoveryCorrespondenceWorkset(query, selected, GENERATION, OPTIONS)!;
  const requests = lines(workset).map(line => line.request as SourceSemanticCorrespondenceRequest);
  expect(requests.map(request => request.generation_policy)).toEqual([0, 1].map(input => ({
    contract: "source-semantic-correspondence-generation-policy-v1", kind: "branch_demand", alternative: 0,
    target: { kind: "evidence", input } })));
  expect(requests.map(request => request.demand?.demanded_handles)).toEqual([["qe1", "qe2"], ["qe3", "qe4"]]);
  expect(new Set(lines(workset).map(line => line.key)).size).toBe(2);
  const second = fixture("2").selected;
  const capped = buildRecoveryCorrespondenceWorkset(query, [...selected, ...second], GENERATION, { ...OPTIONS, correspondence_cap: 3 })!;
  expect(lines(capped).map(line => (line.request as SourceSemanticCorrespondenceRequest).source_interpretation_descriptors[0]!.source_interpretation_id))
    .toEqual([selected[0]!.descriptor.source_interpretation_id, selected[0]!.descriptor.source_interpretation_id, second[0]!.descriptor.source_interpretation_id]);
  expect(buildRecoveryCorrespondenceWorkset(query, selected, GENERATION, { ...OPTIONS, correspondence_cap: 0 })).toBeNull();
  expect(() => buildRecoveryCorrespondenceWorkset(query, selected, GENERATION, { correspondence_cap: 1 })).toThrow();
});

it("retains the omitted full-catalog policy and original request keys", () => {
  const { query, selected } = fixture();
  const workset = buildRecoveryCorrespondenceWorkset(query, selected, GENERATION)!;
  const old = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "semantic_correspondence",
    ...GENERATION, items: selected.map(row => ({ original_query: ORIGINAL, admitted_query_semantics: query.query_semantics,
      source_interpretation_descriptors: [row.descriptor] })) });
  expect(workset).toEqual(old);
  expect(lines(workset)[0]!.key).toBe(lines(old)[0]!.key);
  expect(lines(workset)[0]!.request.contract).toBe("source-semantic-correspondence-request-v7");
  expect(buildRecoveryCorrespondenceWorkset(query, [], GENERATION)).toBeNull();
});

it("reuses unchanged demands without inventing attention, and changes keys for changed H or Q", () => {
  const { query, selected } = fixture();
  const workset = buildRecoveryCorrespondenceWorkset(query, selected, GENERATION, OPTIONS)!;
  const unchanged = applyAffectedRecoveryCorrespondencePolicy(policyInput(workset));
  expect(unchanged.workset).toBe(workset);
  expect([...unchanged.initialKeys]).toEqual(lines(workset).map(line => line.key));
  const changedH = buildRecoveryCorrespondenceWorkset(query, fixture("2").selected, GENERATION, OPTIONS)!;
  const changedQ = buildRecoveryCorrespondenceWorkset({ ...query, query_semantics: { ...query.query_semantics, producer_version: "2" } }, selected, GENERATION, OPTIONS)!;
  for (const changed of [changedH, changedQ]) {
    expect(lines(changed).every(line => !unchanged.initialKeys.has(line.key))).toBe(true);
    expect(applyAffectedRecoveryCorrespondencePolicy({ ...policyInput(workset), baseWorkset: changed,
      selected: changed === changedH ? fixture("2").selected : selected, queryChanged: changed === changedQ }).workset).toBe(changed);
  }
});

async function fill(workset: NonNullable<ReturnType<typeof buildRecoveryCorrespondenceWorkset>>, cacheRoot: string, unresolved = false) {
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, cacheRoot, TOKENS),
    inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  const extract = vi.fn(async ({ userPrompt }: { userPrompt: string }) => {
    const request = JSON.parse(userPrompt) as SourceSemanticCorrespondenceRequest;
    const handles = request.demand?.demanded_handles ?? request.catalog.query_endpoints.map(row => row.handle);
    const rawJson = JSON.stringify({ contract: request.demand === undefined
      ? "source-semantic-correspondence-response-v5" : "source-semantic-correspondence-response-v6",
      outcome: { status: "interpreted", gaps: [] }, semantic_correspondence: {
        contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
        assessments: handles.map(query => {
          const endpoint = request.catalog.query_endpoints.find(row => row.handle === query)!;
          return !unresolved && endpoint.kind === "predicate" ? { query, status: "supported", equivalents: [{
            source: request.catalog.source_endpoints.find(row => row.kind === "frame")!.handle,
            query_excerpt: endpoint.frame === "qSend" ? "sent" : "inspected", source_semantic_support: [{ kind: "lexical", mentions: ["mSent"] }], grounding: "Authored local premise." }] }
            : { query, status: "unresolved", query_excerpt: "parcel", explanation: "No equivalent proposed." };
        }) } });
    const usage = { inputTokens: 3, outputTokens: 5, totalTokens: 8 };
    return { rawJson, usage, responseBody: syntheticGeminiBody(rawJson, "STOP", usage),
      responseMetadata: { finishReason: "STOP", completionWitness: "finish_reason" as const, completionContractVersion: 1 as const } };
  });
  const input = { workset, cacheRoot, authority, extractor: { extract }, config: { model: GENERATION.model,
    requestProfile: "gemini-3.1-minimal-v1" as const, providerUrl: GENERATION.provider_url, apiKey: null } };
  await executeSemanticProposalFill(input);
  return { input, extract };
}

function reason(selected: ReturnType<typeof fixture>["selected"], correspondenceId?: string) {
  const { descriptor } = selected[0]!, queryId = sourceSemanticQueryIdentity(fixture().query.query_semantics, fieldContractSha256);
  const { source_id, source_version, content_digest } = descriptor.interpretation.source;
  const computationId = `sha256:${"a".repeat(64)}`;
  return { source_interpretation_id: descriptor.source_interpretation_id, response: { result: SourceSemanticReasoningResultSchema.parse({
    contract: "source-interpretation-reasoning-v5", outcome: { status: "interpreted", gaps: [] }, consumed_leaves: [],
    source_interpretation_id: descriptor.source_interpretation_id, query_semantics_id: queryId,
    ...(correspondenceId === undefined ? {} : { semantic_correspondence_id: correspondenceId, conditional_computation_id: computationId }),
    attention: { contract: "source-semantic-attention-v1", source_interpretation_id: descriptor.source_interpretation_id,
      query_semantics_id: queryId, source_id, source_version, content_digest,
      ...(correspondenceId === undefined ? { kind: "preparation", missing: "semantic_correspondence", observation: "not_executed" }
        : { kind: "computed", semantic_correspondence_id: correspondenceId, conditional_computation_id: computationId,
          truncated: false, entries: [{ alternative: 0, frame: "qInspect", obligation: "predicate",
            state: "correspondence_missing", observation: "exhausted" }] }) },
    semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation", world_claim: "unknown" }) } };
}

it.each([false, true])("revises only the exact consumed retained C after request reordering (full catalog: %s)", async full => {
  const { query, selected } = fixture(), root = mkdtempSync(join(tmpdir(), "recovery-correspondence-")); roots.push(root);
  const workset = buildRecoveryCorrespondenceWorkset(query, selected, GENERATION, full ? {} : OPTIONS)!;
  const cacheRoot = join(root, "initial");
  const produced = await fill(workset, cacheRoot);
  expect(produced.extract).toHaveBeenCalledTimes(workset.items.length);
  const parents = readSemanticChainProposalResults(workset, cacheRoot, TOKENS);
  expect(parents.map(row => row.status)).toEqual(workset.items.map(() => "interpreted"));
  const parentIndex = full ? 0 : 1, received = parents[parentIndex]!.received;
  if (received === undefined || !("semantic_correspondence" in received) || received.semantic_correspondence === undefined) throw new Error("authored C required");
  const consumedId = sourceSemanticCorrespondenceIdentity(received.semantic_correspondence, fieldContractSha256);
  const base = { ...workset, items: [...workset.items].reverse() };
  const changed = applyAffectedRecoveryCorrespondencePolicy({ ...policyInput(workset), initialCacheRoot: cacheRoot,
    baseWorkset: base, nomination: { ...policyInput(workset).nomination, attention: { semantic_correspondence_id: consumedId } },
    reasonResults: [reason(selected, consumedId)] });
  expect(changed.workset!.items).toHaveLength(workset.items.length);
  const revised = lines(changed.workset!);
  expect(revised[0]!.request.revision?.parent_request_json).toBe(lines(workset)[parentIndex]!.userPrompt);
  expect(revised[0]!.key).not.toBe(lines(workset)[parentIndex]!.key);
  if (!full) expect(revised[1]!.key).toBe(lines(workset)[0]!.key);
  const child = { ...changed.workset!, items: [changed.workset!.items[0]] };
  const filled = await fill(child, join(root, "child"));
  expect(filled.extract).toHaveBeenCalledTimes(1);
  await executeSemanticProposalFill(filled.input);
  expect(filled.extract).toHaveBeenCalledTimes(1);
  await executeSemanticProposalFill(produced.input);
  expect(produced.extract).toHaveBeenCalledTimes(workset.items.length);
});

it("fails closed when two policies received the same consumed canonical C identity", async () => {
  const { query, selected } = fixture(), root = mkdtempSync(join(tmpdir(), "recovery-ambiguous-correspondence-")); roots.push(root);
  const workset = buildRecoveryCorrespondenceWorkset(query, selected, GENERATION, OPTIONS)!;
  await fill(workset, root, true);
  const identities = readSemanticChainProposalResults(workset, root, TOKENS).map(row => {
    if (row.received === undefined || !("semantic_correspondence" in row.received) || row.received.semantic_correspondence === undefined) {
      throw new Error("authored C required");
    }
    return sourceSemanticCorrespondenceIdentity(row.received.semantic_correspondence, fieldContractSha256);
  });
  expect(identities[0]).toBe(identities[1]);
  expect(() => applyAffectedRecoveryCorrespondencePolicy({ ...policyInput(workset), initialCacheRoot: root,
    reasonResults: [reason(selected, identities[0])] })).toThrow(/one exact retained parent/u);
});

it("fails closed when preparation attention cannot identify one of two C parents", () => {
  const { query, selected } = fixture();
  const workset = buildRecoveryCorrespondenceWorkset(query, selected, GENERATION, OPTIONS)!;
  expect(() => applyAffectedRecoveryCorrespondencePolicy({ ...policyInput(workset), reasonResults: [reason(selected)] }))
    .toThrow(/one exact retained parent/u);
});
