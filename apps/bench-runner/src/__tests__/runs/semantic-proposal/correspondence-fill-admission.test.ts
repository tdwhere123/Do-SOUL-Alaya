import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  admitSourceSemanticCorrespondence, admitSourceSemanticQuery,
  SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID
} from "@do-soul/alaya-core";
import {
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION,
  SourceSemanticInterpretationSchema, sourceSemanticInterpretationIdentity
} from "@do-soul/alaya-protocol";
import {
  proposeCorrespondenceSemantics, type SourceSemanticCorrespondenceRequest
} from "@do-soul/alaya-soul";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import {
  inspectSemanticProposalShard, isExecutableProposalShard
} from "../../../runs/semantic-proposal/artifact.js";
import {
  executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults
} from "../../../runs/semantic-proposal/fill.js";
import {
  materializeSemanticProposalLines, parseSemanticProposalWorkset
} from "../../../runs/semantic-proposal/workset.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";

const MODEL = "gemini-3.1-flash-lite";
const PROFILE = "gemini-3.1-minimal-v1" as const;
const ORIGINAL = "which parcel was sent and inspected?";
const roots: string[] = [];

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
    contract: "source-semantic-query-v2" as const,
    original_query_digest: `sha256:${sha256(ORIGINAL)}`,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
    producer_version: "1",
    contract_version: "source-semantic-query-v2",
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

function interpretation() {
  return SourceSemanticInterpretationSchema.parse({
    contract: "source-interpretation-v4",
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "src", source_version: "1", content_digest: `sha256:${sha256(ORIGINAL)}` },
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
    contract: "source-semantic-proposal-workset-v2",
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

it("rejects an semantic_correspondence workset whose original question differs from the admitted query digest", () => {
  const workset = correspondenceWorkset();
  expect(() => materializeSemanticProposalLines({ ...workset, items: [{
    ...(workset.items[0] as Record<string, unknown>), original_query: "Another original question?"
  }] }, 128)).toThrow(/does not bind the original query/u);
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
  expect(isExecutableProposalShard(shard!)).toBe(true);
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
  expect(isExecutableProposalShard(shard!)).toBe(false);
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
