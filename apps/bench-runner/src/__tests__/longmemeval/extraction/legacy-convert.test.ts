import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildOfficialApiExtractionRequests } from "@do-soul/alaya-soul";
import { convertLegacyExtractionShard } from "../../../runs/extraction/cache/semantic-artifact/legacy-convert.js";
import type { CachedExtractionEntry } from "../../../runs/compile-seed/cache/cache-shard.js";
import type { SemanticArtifactSourceBinding } from "../../../runs/extraction/cache/semantic-artifact/contract.js";

const KEY = "ab".repeat(32);
const CONTRACT = "alaya.assertion_semantic_identity.v1";
const PROMPT_SHA = "aa".repeat(32);

function entry(rawJson: string): CachedExtractionEntry {
  return {
    model: "mimo-v2.5",
    request_profile: "mimo-v2.5-nonthinking-v1",
    cache_key: "ef".repeat(32),
    raw_json: rawJson,
    extracted_at: "2026-08-23T10:07:08.564Z"
  };
}

function bindingFor(request: ReturnType<typeof buildOfficialApiExtractionRequests>[number]): SemanticArtifactSourceBinding {
  const assertion = request.source_assertions[0]!;
  return {
    semanticKey: KEY,
    sourceCorpusIdentity: request.source_corpus_identity,
    sourceTextDigest: createHash("sha256").update(assertion.text, "utf8").digest("hex"),
    locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: assertion.assertion_id,
      start: 0,
      end: assertion.text.length
    }
  };
}

describe("legacy shard conversion", () => {
  it("does not mint assertion-empty from batch-empty without exhaustive proof", () => {
    const requests = buildOfficialApiExtractionRequests("I moved to Berlin.", [
      { role: "user", content: "I moved to Berlin." }
    ]);
    const request = requests[0]!;
    const report = convertLegacyExtractionShard({
      entry: entry('{"signals":[]}'),
      request,
      sourceBindings: [bindingFor(request)],
      semanticContract: CONTRACT,
      modelFamily: "mimo-v2.5",
      expectedPromptSha256: PROMPT_SHA
    });
    expect(report.converted).toEqual([]);
    expect(report.unresolved[0]?.reason).toMatch(/not assertion-empty/u);
  });

  it("records empty-turn shards as unresolved rather than known-empty artifacts", () => {
    const request = buildOfficialApiExtractionRequests("?", [{ role: "user", content: "?" }])[0]!;
    const report = convertLegacyExtractionShard({
      entry: entry('{"signals":[]}'),
      request,
      sourceBindings: [],
      semanticContract: CONTRACT,
      modelFamily: "mimo-v2.5",
      expectedPromptSha256: PROMPT_SHA
    });
    expect(request.source_assertions).toEqual([]);
    expect(report.converted).toEqual([]);
    expect(report.unresolved[0]?.reason).toMatch(/no assertion members/u);
  });

  it("keeps truncated and non-JSON shards unresolved", () => {
    const requests = buildOfficialApiExtractionRequests("I moved to Berlin.", [
      { role: "user", content: "I moved to Berlin." }
    ]);
    const request = requests[0]!;
    const truncated = convertLegacyExtractionShard({
      entry: entry('{"signals":['),
      request,
      sourceBindings: [bindingFor(request)],
      semanticContract: CONTRACT,
      modelFamily: "mimo-v2.5",
      expectedPromptSha256: PROMPT_SHA
    });
    expect(truncated.converted).toEqual([]);
    expect(truncated.unresolved.length).toBeGreaterThan(0);
  });

  it("mints deterministic-empty members only with exhaustive inspection proof", () => {
    const requests = buildOfficialApiExtractionRequests("I moved to Berlin.", [
      { role: "user", content: "I moved to Berlin." }
    ]);
    const request = requests[0]!;
    const raw = '{"signals":[]}';
    const rawSha = createHash("sha256").update(raw, "utf8").digest("hex");
    const report = convertLegacyExtractionShard({
      entry: entry(raw),
      request,
      sourceBindings: [bindingFor(request)],
      semanticContract: CONTRACT,
      modelFamily: "mimo-v2.5",
      expectedPromptSha256: PROMPT_SHA,
      exhaustiveProof: {
        prompt_sha256: PROMPT_SHA,
        raw_json_sha256: rawSha,
        parser_status: "ok",
        completion_status: "complete",
        catalog_assertion_ids: request.source_assertions.map((assertion) => assertion.assertion_id)
      }
    });
    expect(report.converted).toHaveLength(1);
    expect(report.converted[0]?.admission_state).toBe("deterministic_empty");
    expect(report.converted[0]?.deterministic_empty_proof?.kind).toBe("exhaustive_member_inspection");
  });

  it("is deterministic for the same shard and request", () => {
    const requests = buildOfficialApiExtractionRequests("I moved to Berlin.", [
      { role: "user", content: "I moved to Berlin." }
    ]);
    const request = requests[0]!;
    const first = convertLegacyExtractionShard({
      entry: entry('{"signals":[]}'),
      request,
      sourceBindings: [bindingFor(request)],
      semanticContract: CONTRACT,
      modelFamily: "mimo-v2.5",
      expectedPromptSha256: PROMPT_SHA
    });
    const second = convertLegacyExtractionShard({
      entry: entry('{"signals":[]}'),
      request,
      sourceBindings: [bindingFor(request)],
      semanticContract: CONTRACT,
      modelFamily: "mimo-v2.5",
      expectedPromptSha256: PROMPT_SHA
    });
    expect(second).toEqual(first);
  });
});
