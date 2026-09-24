import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  admitSourceSemanticCorrespondence, admitSourceSemanticQuery,
  SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID
} from "@do-soul/alaya-core";
import {
  AlayaError, SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION,
  SourceSemanticInterpretationSchema, SourceSemanticQuerySchema,
  buildSourceSemanticCorrespondenceEndpointCatalog, buildSourceSemanticCorrespondenceEndpointEvidence,
  sourceSemanticInterpretationIdentity,
  UNKNOWN_UTTERANCE_ATTRIBUTION
} from "@do-soul/alaya-protocol";
import {
  buildSourceSemanticCorrespondenceRequest, proposeCorrespondenceSemantics, type SourceSemanticCorrespondenceRequest
} from "@do-soul/alaya-soul";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import {
  inspectSemanticProposalShard, hasAdmittedProposalOutcome
} from "../../../runs/semantic-proposal/artifact.js";
import {
  executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults
} from "../../../runs/semantic-proposal/fill.js";
import {
  materializeSemanticProposalLines, parseSemanticProposalWorkset
} from "../../../runs/semantic-proposal/workset.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";
import { proposalRecoveryCases } from "./proposal-recovery.test-support.js";

const MODEL = "gemini-3.1-flash-lite";
const PROFILE = "gemini-3.1-minimal-v1" as const;
const ORIGINAL = "which parcel was sent and inspected?";
const roots: string[] = [];

proposalRecoveryCases({ workset: correspondenceWorkset,
  body: line => selectionBody(line.request as SourceSemanticCorrespondenceRequest, "sent"), config });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "proposal-semantic_correspondence-fill-"));
  roots.push(root);
  return root;
}

function config(): CompileSeedExtractionConfig {
  return { providerUrl: "http://127.0.0.1:9", model: MODEL, requestProfile: PROFILE, apiKey: "synthetic-fixture-key" };
}

function extractor(raws: string[]) {
  const queue = [...raws];
  const calls: string[] = [];
  return {
    calls,
    extract: async (input: { readonly userPrompt: string }) => {
      calls.push(input.userPrompt);
      return {
        rawJson: queue.shift() ?? "{",
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        responseMetadata: {
          finishReason: "STOP", completionWitness: "finish_reason" as const, completionContractVersion: 1 as const
        }
      };
    }
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function admittedQuery() {
  return {
    contract: "source-semantic-query-v4" as const,
    original_query_digest: `sha256:${sha256(ORIGINAL)}`,
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
    producer_version: "1",
    contract_version: "source-semantic-query-v4",
    variables: [
      { id: "parcel", sort: "entity" as const },
      { id: "fSend", sort: "proposition" as const }
    ],
    alternatives: [{
      frames: [{
        id: "qSend", variable: "fSend", predicate_reading: "send",
        role_requirements: [{
          id: "object", role_reading: "object", target_variable: "parcel",
          support: { kind: "query_text" as const, excerpt: "parcel" }
        }]
      }],
      context_obligations: [{ frame: "qSend", kind: "asserted_at_source" as const }]
    }],
    return_variables: ["parcel"],
    gaps: []
  };
}

function admittedCapacityQuery(contextCount: number) {
  const base = admittedQuery();
  const frames = Array.from({ length: 32 }, (_, index) => ({
    id: `frame${index}`, variable: "fSend", predicate_reading: "send",
    role_requirements: [{ id: "object", role_reading: "object", target_variable: "parcel",
      support: { kind: "query_text" as const, excerpt: "parcel" } }]
  }));
  return SourceSemanticQuerySchema.parse({ ...base,
    variables: [{ id: "parcel", sort: "entity", reference: { kind: "query_text", excerpt: "parcel" } },
      { id: "fSend", sort: "proposition" }],
    alternatives: [{ frames, context_obligations: Array.from({ length: contextCount }, (_, index) => ({
      frame: `frame${index % frames.length}`, kind: "asserted_at_source"
    })) }],
    return_variables: [], gaps: [],
    requested_operation: { reading: "send", support: { kind: "query_text", excerpt: "sent" } }
  });
}

function interpretation() {
  return SourceSemanticInterpretationSchema.parse({
    contract: "source-interpretation-v4",
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "src", source_version: "1", content_digest: `sha256:${sha256(ORIGINAL)}`,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    producer_id: "source-interpretation-producer", producer_version: "1", contract_version: "source-interpretation-v4",
    mentions: [
      {
        id: "mSent", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" },
        text: "sent", utf8_span: [0, 4]
      },
      {
        id: "mParcel", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" },
        text: "parcel", utf8_span: [5, 11]
      }
    ],
    referents: [{ id: "rParcel", referent_kind: "grouped", mentions: ["mParcel"] }],
    frames: [{
      id: "fSend", assertion_ids: [1],
      context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [],
      predicate_support: { kind: "explicit", reading: "send", mentions: ["mSent"] },
      slots: [{
        id: "object", role_reading: "object",
        support: [{ kind: "lexical", mentions: ["mParcel"] }]
      }],
      bindings: [{
        slot_id: "object", target: { kind: "node", id: "rParcel" }, support: []
      }]
    }],
    operators: [], gaps: [], entry_roots: ["fSend"], asserted_at_scope: ["fSend"]
  });
}

function correspondenceWorkset() {
  const sourceInterpretation = interpretation();
  return parseSemanticProposalWorkset({
    contract: "source-semantic-proposal-workset-v3", provider_url: "http://127.0.0.1:9",
    kind: "semantic_correspondence", model: MODEL, request_profile: PROFILE,
    items: [{
      original_query: ORIGINAL,
      admitted_query_semantics: admittedQuery(),
      source_interpretation_descriptors: [{
        source_interpretation_id: sourceSemanticInterpretationIdentity(sourceInterpretation, sha256),
        interpretation: sourceInterpretation
      }]
    }]
  });
}

function selectionBody(request: SourceSemanticCorrespondenceRequest, excerpt: string): string {
  const predicate = request.catalog?.query_endpoints.find((row) => row.kind === "predicate");
  const frame = request.catalog?.source_endpoints.find((row) => row.kind === "frame");
  if (predicate === undefined || frame === undefined) {
    throw new Error("semantic_correspondence catalog missing predicate or frame");
  }
  return JSON.stringify({
    contract: "source-semantic-correspondence-response-v3",
    outcome: { status: "interpreted", gaps: [] },
    semantic_correspondence: {
      contract: "source-semantic-correspondence-selection-v2", source_interpretation_handle: "source1",
      selections: [{
        query: predicate.handle, source: frame.handle, query_excerpt: excerpt,
        source_semantic_support: [{ kind: "lexical", mentions: ["mSent"] }]
      }]
    }
  });
}

it("sends Step correspondence through the pinned route and reopens its admitted raw", async () => {
  const prepared = parseSemanticProposalWorkset({
    ...correspondenceWorkset(), contract: "source-semantic-proposal-workset-v4",
    provider_url: STEP_PLAN_QUOTE_BASIS.selected_provider_url,
    model: STEP_PLAN_QUOTE_BASIS.selected_model,
    request_profile: "step-3.5-2603-low-json-schema-v1"
  });
  const cacheRoot = join(tempRoot(), "step-cache");
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 4096, 1),
    inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
    outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million
  });
  const line = materializeSemanticProposalLines(prepared, 4096)[0]!;
  const wire = `data: ${JSON.stringify({ choices: [{
    delta: { content: selectionBody(line.request as SourceSemanticCorrespondenceRequest, "sent") },
    finish_reason: "stop"
  }], usage: { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29 } })}\n\ndata: [DONE]\n\n`;
  const seen: { path: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    seen.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(wire);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const config: CompileSeedExtractionConfig = { model: prepared.model, requestProfile: "step-3.5-2603-low-json-schema-v1",
      providerUrl: prepared.provider_url, apiKey: "loopback-only" };
    const nativeFetch = globalThis.fetch;
    const localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fetchImpl: typeof fetch = (url, init) => {
      const selected = new URL(String(url));
      expect(selected.href).toBe("https://api.stepfun.com/step_plan/v1/chat/completions");
      return nativeFetch(new URL(selected.pathname, localOrigin), init);
    };
    const result = await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority,
      config, extractor: createSemanticProviderHttpExtractor(config, "source_semantic_proposal", fetchImpl) });
    expect(result).toMatchObject({ interpreted: 1, newly_admitted: 1, attempts: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ path: "/step_plan/v1/chat/completions",
      body: { reasoning_effort: "low", max_tokens: 4096, response_format: { type: "json_schema" } } });
    expect(readProviderRawAttempt(cacheRoot, line.key, 1)).toMatchObject({
      contract: "semantic-proposal-raw-attempt-v2", http_response: { bodyBase64: Buffer.from(wire).toString("base64") }
    });
    expect(readSemanticProposalResults(prepared, cacheRoot, 4096)[0]?.status).toBe("interpreted");
    await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null } });
    expect(seen).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("rejects an semantic_correspondence workset whose original question differs from the admitted query digest", () => {
  const workset = correspondenceWorkset();
  expect(() => materializeSemanticProposalLines({ ...workset, items: [{
    ...(workset.items[0] as Record<string, unknown>), original_query: "Another original question?"
  }] }, 128)).toThrow(/does not bind the original query/u);
});

it("bounds a Core-admitted 120-frame projection before traversing its full endpoint graph", () => {
  const base = admittedQuery();
  const frames = Array.from({ length: 120 }, (_, index) => ({
    id: `frame${index}`, variable: "proposition", predicate_reading: "send",
    role_requirements: [{ id: "role", role_reading: "object", target_variable: "entity",
      support: { kind: "query_text" as const, excerpt: "parcel" } }]
  }));
  const query = SourceSemanticQuerySchema.parse({ ...base,
    variables: [{ id: "entity", sort: "entity", reference: { kind: "query_text", excerpt: "parcel" } },
      { id: "proposition", sort: "proposition" }],
    return_variables: [], gaps: [],
    alternatives: [{ frames,
      context_obligations: Array.from({ length: 256 }, (_, index) => ({
        frame: `frame${index % 120}`, kind: "asserted_at_source"
      })),
      answer_frames: frames.map(row => row.id),
      evidence_inputs: Array.from({ length: 16 }, () => ({ frames: frames.map(row => row.id) })) }],
    requested_operation: { reading: "send", support: { kind: "query_text", excerpt: "sent" } }
  });
  expect(admitSourceSemanticQuery(query, ORIGINAL).kind).toBe("admitted");
  const source = interpretation();
  const descriptor = { source_interpretation_handle: "source1", interpretation: source };
  const catalog = buildSourceSemanticCorrespondenceEndpointCatalog(query, [descriptor]);
  expect(catalog.query_endpoints).toHaveLength(241);
  const guarded = structuredClone(query);
  Object.defineProperty(guarded.alternatives[0]!.frames[119]!, "role_requirements", {
    get() { throw new Error("projection traversed the final frame after exceeding its budget"); }
  });
  let directFailure: unknown;
  try { buildSourceSemanticCorrespondenceEndpointEvidence(guarded, [descriptor], catalog); }
  catch (error) { directFailure = error; }
  expect(directFailure).toBeInstanceOf(AlayaError);
  expect(directFailure).toMatchObject({ code: "VALIDATION", message: "semantic_correspondence request exceeds input budget" });
  const sourceDescriptor = { source_interpretation_id: sourceSemanticInterpretationIdentity(source, sha256),
    interpretation: source };
  expect(() => buildSourceSemanticCorrespondenceRequest({ original_query: ORIGINAL,
    admitted_query_semantics: query, source_interpretation_descriptors: [sourceDescriptor],
    producer_id: "authored-control", producer_version: "1" }))
    .toThrow(/semantic_correspondence request exceeds input budget/u);
});

it("rejects a complete request before serializing it when its lawful projection fits alone", () => {
  const query = admittedCapacityQuery(200);
  expect(admitSourceSemanticQuery(query, ORIGINAL).kind).toBe("admitted");
  const source = interpretation();
  const descriptor = { source_interpretation_handle: "source1", interpretation: source };
  const catalog = buildSourceSemanticCorrespondenceEndpointCatalog(query, [descriptor]);
  const projection = buildSourceSemanticCorrespondenceEndpointEvidence(query, [descriptor], catalog);
  expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThan(1_000_000);
  const sourceDescriptor = { source_interpretation_id: sourceSemanticInterpretationIdentity(source, sha256),
    interpretation: source };
  const originalStringify = JSON.stringify;
  JSON.stringify = function (value, ...args) {
    if (value !== null && typeof value === "object" && "contract" in value &&
      value.contract === "source-semantic-correspondence-request-v6") {
      throw new Error("oversized request was serialized before budget rejection");
    }
    return Reflect.apply(originalStringify, JSON, [value, ...args]);
  };
  let failure: unknown;
  try {
    buildSourceSemanticCorrespondenceRequest({ original_query: ORIGINAL, admitted_query_semantics: query,
      source_interpretation_descriptors: [sourceDescriptor], producer_id: "authored-control", producer_version: "1" });
  } catch (error) { failure = error; }
  finally { JSON.stringify = originalStringify; }
  expect(failure).toBeInstanceOf(AlayaError);
  expect(failure).toMatchObject({ code: "VALIDATION", message: "semantic_correspondence request exceeds input budget" });
});

it("accepts a nearby Core-admitted request within the complete byte budget", () => {
  const query = admittedCapacityQuery(192);
  expect(admitSourceSemanticQuery(query, ORIGINAL).kind).toBe("admitted");
  const source = interpretation();
  const request = buildSourceSemanticCorrespondenceRequest({ original_query: ORIGINAL,
    admitted_query_semantics: query,
    source_interpretation_descriptors: [{ source_interpretation_id: sourceSemanticInterpretationIdentity(source, sha256),
      interpretation: source }], producer_id: "authored-control", producer_version: "1" });
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(1_000_000);
});

it("rejects a descriptor aggregate before serializing its oversized array", () => {
  const source = interpretation();
  const enlarged = SourceSemanticInterpretationSchema.parse({ ...source,
    mentions: source.mentions.map((mention, index) => index === 0
      ? { ...mention, text: "a".repeat(20_000) } : mention)
  });
  const descriptor = { source_interpretation_id: sourceSemanticInterpretationIdentity(enlarged, sha256),
    interpretation: enlarged };
  const originalStringify = JSON.stringify;
  JSON.stringify = function (value, ...args) {
    if (Array.isArray(value) && value.length === 64 && value[0]?.interpretation !== undefined) {
      throw new Error("oversized descriptor aggregate was serialized before budget rejection");
    }
    return Reflect.apply(originalStringify, JSON, [value, ...args]);
  };
  let failure: unknown;
  try {
    buildSourceSemanticCorrespondenceRequest({ original_query: ORIGINAL, admitted_query_semantics: admittedQuery(),
      source_interpretation_descriptors: Array.from({ length: 64 }, () => descriptor),
      producer_id: "authored-control", producer_version: "1" });
  } catch (error) { failure = error; }
  finally { JSON.stringify = originalStringify; }
  expect(failure).toBeInstanceOf(AlayaError);
  expect(failure).toMatchObject({ code: "VALIDATION", message: "semantic_correspondence descriptors exceed input budget" });
});

async function fillCorrespondence(excerpt: string) {
  const cacheRoot = join(tempRoot(), "cache");
  const prepared = correspondenceWorkset();
  const line = materializeSemanticProposalLines(prepared, 128)[0]!;
  const request = line.request as SourceSemanticCorrespondenceRequest;
  const body = selectionBody(request, excerpt);
  const received = proposeCorrespondenceSemantics({ original_query: request.original_query,
    admitted_query_semantics: request.admitted_query_semantics,
    source_interpretation_descriptors: request.source_interpretation_descriptors,
    producer_id: request.producer_capability.producer_id,
    producer_version: request.producer_capability.producer_version
  }, { rawJson: body });
  const core = admitSourceSemanticCorrespondence({
    semantic_correspondence: received.semantic_correspondence,
    source_interpretation: request.source_interpretation_descriptors[0]!.interpretation,
    query_semantics: request.admitted_query_semantics,
    original_query: ORIGINAL
  });
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const first = extractor([body]);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: first
  });
  return { cacheRoot, prepared, authority, first, result, key: authority.keys[0]!, received, core };
}

it("admits an semantic_correspondence shard only after Core admission", async () => {
  expect(admitSourceSemanticQuery(admittedQuery(), ORIGINAL).kind).toBe("admitted");
  const { cacheRoot, prepared, authority, first, result, key, received, core } =
    await fillCorrespondence("sent");
  expect(received.outcome.status).toBe("interpreted");
  expect(core.kind).toBe("admitted");
  const shard = inspectSemanticProposalShard(cacheRoot, key, {
    kind: "semantic_correspondence", model: MODEL, request_profile: PROFILE
  });
  expect(first.calls).toHaveLength(1);
  expect(result.newly_admitted).toBe(1);
  expect(result.interpreted).toBe(1);
  expect(shard?.admitted).toBe(true);
  expect(hasAdmittedProposalOutcome(shard!)).toBe(true);
  const second = extractor(["should-not-run"]);
  const replayed = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: second
  });
  expect(second.calls).toHaveLength(0);
  expect(replayed.cache_hits).toBe(1);
  expect(replayed.interpreted).toBe(1);
  expect(replayed.newly_admitted).toBe(0);
});

it("retains a Core-invalid interpreted semantic_correspondence as non-executable cache", async () => {
  const { cacheRoot, prepared, authority, first, result, key, received, core } =
    await fillCorrespondence("invented support");
  expect(received.outcome.status).toBe("interpreted");
  expect(core.kind).toBe("invalid");
  const shard = inspectSemanticProposalShard(cacheRoot, key, {
    kind: "semantic_correspondence", model: MODEL, request_profile: PROFILE
  });
  expect(first.calls).toHaveLength(1);
  expect(result.newly_admitted).toBe(0);
  expect(result.interpreted).toBe(0);
  expect(readProviderRawAttempt(cacheRoot, key, 1)?.decoded_text).toContain("invented support");
  expect(shard?.admitted).toBe(false);
  expect(shard?.outcome).toMatchObject({ status: "interpreted" });
  expect(shard?.finish_reason).toBe("STOP");
  expect(readSemanticProposalResults(prepared, cacheRoot, 128)[0]?.status).toBe("core_rejected");
  expect(hasAdmittedProposalOutcome(shard!)).toBe(false);
  expect(() => prepareSemanticProposal(prepared, cacheRoot, 128)).not.toThrow();
  const second = extractor(["should-not-run"]);
  const replayed = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: second
  });
  expect(second.calls).toHaveLength(0);
  expect(replayed.cache_hits).toBe(1);
  expect(replayed.cached_invalid).toBe(1);
  expect(replayed.newly_admitted).toBe(0);
  expect(replayed.interpreted).toBe(0);
});
