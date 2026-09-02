import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildOfficialApiExtractionRequests } from "@do-soul/alaya-soul";
import {
  ASSERTION_SEMANTIC_IDENTITY_CONTRACT_ID,
  mintOfficialApiAssertionBindings
} from "../../../../../../packages/soul/src/garden/ingestion/official-api/extraction-request.js";
import { convertLegacyExtractionShard } from "../../../runs/extraction/cache/semantic-artifact/legacy-convert.js";
import type { CachedExtractionEntry } from "../../../runs/compile-seed/cache/cache-shard.js";
import type { SemanticArtifactSourceBinding } from "../../../runs/extraction/cache/semantic-artifact/contract.js";

const CONTRACT = ASSERTION_SEMANTIC_IDENTITY_CONTRACT_ID;
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

function bindingFor(
  turnContent: string,
  request: ReturnType<typeof buildOfficialApiExtractionRequests>[number]
): SemanticArtifactSourceBinding {
  const minted = mintOfficialApiAssertionBindings(turnContent, [
    { role: "user", content: turnContent }
  ]);
  const binding = minted.find((item) =>
    request.source_assertions.some((assertion) => assertion.assertion_id === item.locator.assertion_id)
  );
  if (binding === undefined) throw new Error("no minted binding");
  return binding;
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
      sourceBindings: [bindingFor("I moved to Berlin.", request)],
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
      sourceBindings: [bindingFor("I moved to Berlin.", request)],
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
      sourceBindings: [bindingFor("I moved to Berlin.", request)],
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
      sourceBindings: [bindingFor("I moved to Berlin.", request)],
      semanticContract: CONTRACT,
      modelFamily: "mimo-v2.5",
      expectedPromptSha256: PROMPT_SHA
    });
    const second = convertLegacyExtractionShard({
      entry: entry('{"signals":[]}'),
      request,
      sourceBindings: [bindingFor("I moved to Berlin.", request)],
      semanticContract: CONTRACT,
      modelFamily: "mimo-v2.5",
      expectedPromptSha256: PROMPT_SHA
    });
    expect(second).toEqual(first);
  });
});
