import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOURCE_INTERPRETATION_CONTRACT } from "@do-soul/alaya-protocol";
import { planOfficialApiSemanticWorkset } from "@do-soul/alaya-soul";
import type { FrozenAssertion } from "../../../../runs/extraction/enrichment-acceptance/frozen-population.js";
import { toBindingRequests } from "../../../../runs/extraction/enrichment-acceptance/emit-preparation.js";
import { bindFrozenPopulation } from "../../../../runs/extraction/enrichment-acceptance/source-binding.js";
import {
  ENRICHMENT_PREFLIGHT_CAPABILITY,
  ENRICHMENT_PREFLIGHT_MAX_OUTPUT_TOKENS,
  ENRICHMENT_PREFLIGHT_MODEL,
  ENRICHMENT_PREFLIGHT_REQUEST_PROFILE,
  runCurrentEnrichmentPreflight
} from "../../../../runs/extraction/enrichment-acceptance/current-preflight.js";

const text = "I moved to Berlin.";
const turn = {
  turnContent: text,
  turnMessages: [{ message_id: "message-1", role: "user" as const, content: text }]
};

function frozenRow(obligation: string): FrozenAssertion {
  return {
    population: "regression",
    annotation_pointer: {
      file: "regression-source-review.json",
      assertion_id: 1,
      request_key: "aa".repeat(32),
      canonical_index: null
    },
    original_ordinal: 1,
    exact_text: `User: ${text}`,
    original_source: { exact_text: text },
    occurrence: {
      source_message_ids: ["message-1"],
      source_locator: null,
      source_occurrence_identity: null,
      occurrence_bindings: []
    },
    classification: "optional",
    required_group_id: null,
    first_stage_subset: true,
    obligations: [obligation],
    forbidden: ["do not invent a subscription"],
    duplicate_of: null,
    participants: null,
    source_role: null,
    modality: null,
    conditions: null,
    scope: null,
    time: null,
    event_policy: null
  };
}

describe("current enrichment preflight", () => {
  let cacheRoot: string;
  const previousFetch = globalThis.fetch;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "enrichment-preflight-"));
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("captures current identities through the batch workset planner without a provider", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error("test fetch must not run");
    };
    const preflight = await runCurrentEnrichmentPreflight({
      cacheRoot,
      sourcePacking: "singleton",
      turns: [turn],
      datasetRevision: "synthetic-revision",
      frozenRows: [frozenRow("review-only obligation that is absent from source")]
    });
    expect(preflight.attempted_fetches).toBe(0);
    expect(fetches).toBe(0);
    expect(preflight.identities.capability).toBe(ENRICHMENT_PREFLIGHT_CAPABILITY);
    expect(preflight.identities.wire_contract).toBe(SOURCE_INTERPRETATION_CONTRACT);
    expect(preflight.identities.model).toBe(ENRICHMENT_PREFLIGHT_MODEL);
    expect(preflight.identities.request_profile).toBe(ENRICHMENT_PREFLIGHT_REQUEST_PROFILE);
    expect(preflight.identities.max_output_tokens).toBe(ENRICHMENT_PREFLIGHT_MAX_OUTPUT_TOKENS);
    expect(preflight.identities.prompt_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(preflight.annotation_interpolation).toBe("absent");
    expect(preflight.semantic_fill.status).toBe("not_run");
    expect(preflight.semantic_fill.reason).toMatch(/substrate manifest/u);
    expect(preflight.semantic_fill.uniqueUnits).toBeNull();
    expect(preflight.requests.length).toBeGreaterThan(0);
    expect(preflight.requests.some((request) =>
      request.user_prompt.includes("review-only obligation that is absent from source")
    )).toBe(false);
    expect(preflight.bounds.dispatch_authorized).toBe(false);
    expect(preflight.cached_request_count).toBe(0);
  });

  it("refuses when a frozen obligation string appears in a request payload", async () => {
    await expect(runCurrentEnrichmentPreflight({
      cacheRoot,
      sourcePacking: "singleton",
      turns: [turn],
      datasetRevision: "synthetic-revision",
      frozenRows: [frozenRow(text)]
    })).rejects.toThrow(/frozen annotation text entered a current request payload/u);
  });

  it("keeps nonempty and valid-empty request counts distinct without a provider", async () => {
    const nonempty = await runCurrentEnrichmentPreflight({
      cacheRoot,
      sourcePacking: "singleton",
      turns: [turn],
      datasetRevision: "synthetic-revision"
    });
    expect(nonempty.nonempty_request_count).toBeGreaterThan(0);
    expect(nonempty.deterministic_empty_request_count).toBe(0);
    expect(nonempty.attempted_fetches).toBe(0);

    const empty = await runCurrentEnrichmentPreflight({
      cacheRoot,
      sourcePacking: "singleton",
      turns: [{ turnContent: "", turnMessages: [{ message_id: "message-empty", role: "user", content: "" }] }],
      datasetRevision: "synthetic-revision"
    });
    expect(empty.nonempty_request_count).toBe(0);
    expect(empty.deterministic_empty_request_count).toBeGreaterThan(0);
    expect(empty.nonempty_request_count).not.toBe(empty.deterministic_empty_request_count);
    expect(empty.attempted_fetches).toBe(0);
  });

  it("retains both native message occurrences behind one deduplicated request", async () => {
    const originalMessages = [{
      role: "user" as const,
      content: text,
      message_id: "original-message"
    }];
    const foreignMessages = [{
      role: "user" as const,
      content: text,
      message_id: "foreign-message"
    }];
    const originalOcc = planOfficialApiSemanticWorkset(
      text, originalMessages, "synthetic-revision"
    ).units[0]!.binding.occurrenceIdentity;
    const foreignOcc = planOfficialApiSemanticWorkset(
      text, foreignMessages, "synthetic-revision"
    ).units[0]!.binding.occurrenceIdentity;
    expect(originalOcc).not.toBe(foreignOcc);
    const preflight = await runCurrentEnrichmentPreflight({
      cacheRoot,
      sourcePacking: "singleton",
      turns: [
        { turnContent: text, turnMessages: originalMessages },
        { turnContent: text, turnMessages: foreignMessages }
      ],
      datasetRevision: "synthetic-revision"
    });
    expect(preflight.requests).toHaveLength(1);
    expect(preflight.requests[0]!.occurrence_provenance).toEqual(expect.arrayContaining([
      { assertion_id: 1, occurrenceIdentity: originalOcc, source_message_id: "original-message" },
      { assertion_id: 1, occurrenceIdentity: foreignOcc, source_message_id: "foreign-message" }
    ]));
    const requests = toBindingRequests(preflight);
    expect(requests[0]!.source_assertions).toHaveLength(2);
    const bindings = bindFrozenPopulation([], { catalogUnits: preflight.units, requests });
    expect(bindings.packing.request_assertion_cardinalities).toEqual([1]);
  });
});
