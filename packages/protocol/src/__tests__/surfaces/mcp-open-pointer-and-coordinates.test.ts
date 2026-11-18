import { describe, expect, it } from "vitest";
import {
  CallerQueryCoordinatesSchema,
  RecallMemberIndexLineSchema,
  SoulMemorySearchRequestSchema,
  SoulOpenPointerRequestSchema,
  SoulOpenPointerResponseSchema,
  soulToolJsonSchemas
} from "../../surfaces/mcp-types.js";
import { deriveJsonSchema } from "../../surfaces/mcp-json-schema.js";
import { sourceDisclosure } from "../../recall/source-disclosure.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const BASE_SEARCH = {
  query: "Which café did Alice visit in May?",
  scope_class: null,
  dimension: null,
  domain_tags: null,
  max_results: 5
} as const;

describe("caller query_coordinates and open_pointer schemas", () => {
  it("accepts a query-only call and advertises the exact caller coordinate schema", () => {
    expect(SoulMemorySearchRequestSchema.parse({ query: BASE_SEARCH.query })).toEqual({
      query: BASE_SEARCH.query, scope_class: null, dimension: null, domain_tags: null,
      max_results: 10, enumeration_policy: "native_query", result_kind_view: "mixed"
    });
    expect(soulToolJsonSchemas["soul.recall"]).toMatchObject({
      required: ["query"], additionalProperties: false,
      properties: {
        scope_class: { default: null }, dimension: { default: null }, domain_tags: { default: null },
        max_results: { type: "integer", minimum: 0, maximum: 1000, default: 10 }
      }
    });
    expect(soulToolJsonSchemas["soul.recall"].properties).toHaveProperty(
      "query_coordinates", deriveJsonSchema(CallerQueryCoordinatesSchema)
    );
  });

  it("recovers bounded valid items and preserves intentionally unanchored conditions", () => {
    const interval = { start: "2026-05-01", end: "2026-05-31" };
    const anchors = ["Alice", "a", "b", "c", "d", "e", "f", "g", "h"];
    const validCondition = { statement: "Alice visited a café.", speaker: "user", anchors: anchors.slice(0, 8) };
    const unanchored = { statement: "A café was visited.", speaker: "assistant", anchors: [] };
    const result = SoulMemorySearchRequestSchema.parse({
      query: BASE_SEARCH.query,
      question_time: { intervals: [{ start: "2027-01-01", end: "2027-01-02" }] },
      query_coordinates: {
        unknown: "ignored",
        question_time: {
          interpretation_clock: "ignored",
          intervals: [{ start: "2026-05-32", end: "2026-05-31" }, null, ...Array(33).fill(interval)]
        },
        evidence_conditions: [
          { ...validCondition, speaker: "system" },
          { ...validCondition, anchors: [42, "  "] },
          { ...validCondition, anchors: [null, " Alice ", ...anchors], ignored: true },
          unanchored, unanchored, unanchored, validCondition
        ],
        evidence_relation: "derived"
      }
    });
    expect(result).not.toHaveProperty("question_time");
    expect(result.query_coordinates).toEqual({
      question_time: { intervals: Array(32).fill(interval) },
      evidence_conditions: [validCondition, unanchored, unanchored, unanchored],
      evidence_relation: "derived"
    });
  });

  it.each([null, [], "mistake", { question_time: { intervals: [{ start: "bad", end: "bad" }] } }])(
    "degrades unusable coordinates %j to raw recall",
    query_coordinates => {
      const result = SoulMemorySearchRequestSchema.parse({
        query: BASE_SEARCH.query, query_coordinates, question_time: 1, evidence_conditions: 2, evidence_relation: 3
      });
      expect(result).toEqual(SoulMemorySearchRequestSchema.parse({ query: BASE_SEARCH.query }));
    }
  );

  it.each([
    {}, { query: "q", delivery_id: "unknown" }, { query: "q", since: "bad" }, { query: "q", until: "bad" },
    { query: "q", scope_class: "unknown" }, { query: "q", dimension: "unknown" },
    ...["original_query_digest", "producer_id", "producer_version", "schema_version"].map(field => ({ query: "q", [field]: "bad" }))
  ])("keeps unrelated ingress validation strict for %j", input => {
    expect(SoulMemorySearchRequestSchema.safeParse(input).success).toBe(false);
  });

  it("rejects both coordinate channels before repairing either one", () => {
    const parsed = SoulMemorySearchRequestSchema.safeParse({
      query: BASE_SEARCH.query, query_coordinates: null, interpretation_proposal: null
    });
    expect(parsed.error?.issues).toEqual([{
      code: "custom", path: ["query_coordinates"],
      message: "query_coordinates and interpretation_proposal cannot both be provided."
    }]);
  });

  it("keeps replay packet fields and the surrounding replay request strict", () => {
    const interpretation_proposal = {
      schema_version: 1,
      original_query_digest: DIGEST,
      producer_id: "alaya.query.question-time.v1",
      question_time: {
        interpretation_clock: "2026-06-01T00:00:00Z",
        intervals: [{ start: "2026-05-01", end: "2026-05-31" }]
      }
    };
    const request = { query: BASE_SEARCH.query, interpretation_proposal };
    expect(SoulMemorySearchRequestSchema.safeParse(request).success).toBe(true);
    expect(SoulMemorySearchRequestSchema.safeParse({ ...request, question_time: {} }).success).toBe(false);
    expect(SoulMemorySearchRequestSchema.safeParse({
      ...request, interpretation_proposal: { ...interpretation_proposal, unexpected: true }
    }).success).toBe(false);
  });

  it("accepts query_coordinates without sha256 or interpretation_clock and rejects simultaneous interpretation_proposal", () => {
    const parsed = SoulMemorySearchRequestSchema.parse({
      ...BASE_SEARCH,
      query_coordinates: {
        question_time: { intervals: [{ start: "2026-05-01", end: "2026-05-31" }] },
        evidence_conditions: [{ statement: "Alice visited a café.", speaker: "user", anchors: ["Alice"] }],
        evidence_relation: "derived"
      }
    });
    expect(parsed.query_coordinates?.question_time?.intervals).toHaveLength(1);
    expect(
      SoulMemorySearchRequestSchema.safeParse({
        ...BASE_SEARCH,
        query_coordinates: { question_time: { intervals: [{ start: "2026-05-01", end: "2026-05-31" }] } },
        interpretation_proposal: {
          schema_version: 1,
          original_query_digest: DIGEST,
          producer_id: "alaya.query.question-time.v1"
        }
      }).success
    ).toBe(false);
  });

  it("keeps RecallMemberIndexLine backward-compatible and forbids workspace_id on source_target", () => {
    const legacyLine = {
      label: "R06",
      root_id: "rec-1",
      date: "2026-05-01",
      line: "Alice visited Café Lumière",
      producer: "first-message" as const,
      statement_ids: [],
      in_pool: false
    };
    expect(RecallMemberIndexLineSchema.parse(legacyLine)).toEqual(legacyLine);
    const withTarget = {
      ...legacyLine,
      source_target: {
        root_kind: "source_record" as const,
        root_id: "rec-1",
        source_version: "v1",
        content_digest: DIGEST,
        evidence_object_id: null
      }
    };
    expect(RecallMemberIndexLineSchema.parse(withTarget)).toEqual(withTarget);
    expect(
      RecallMemberIndexLineSchema.safeParse({
        ...legacyLine,
        source_target: { ...withTarget.source_target, workspace_id: "ws-foreign" }
      }).success
    ).toBe(false);
  });

  it("extends SoulOpenPointerRequestSchema without default keys on object_id", () => {
    expect(SoulOpenPointerRequestSchema.parse({ object_id: "mem-1" })).toEqual({ object_id: "mem-1" });
    expect(SoulOpenPointerRequestSchema.safeParse({}).success).toBe(false);
    const sourceTarget = {
      root_kind: "source_record" as const,
      root_id: "rec-1",
      source_version: "v1",
      content_digest: DIGEST,
      evidence_object_id: null
    };
    expect(
      SoulOpenPointerRequestSchema.safeParse({ object_id: "mem-1", source_target: sourceTarget }).success
    ).toBe(false);
    expect(
      SoulOpenPointerRequestSchema.safeParse({ object_id: "mem-1", start_offset: 0 }).success
    ).toBe(false);
    expect(
      SoulOpenPointerRequestSchema.safeParse({ object_id: "mem-1", byte_budget: 1024 }).success
    ).toBe(false);
    expect(
      SoulOpenPointerRequestSchema.safeParse({
        source_target: { ...sourceTarget, workspace_id: "ws-foreign" }
      }).success
    ).toBe(false);
    expect(
      SoulOpenPointerRequestSchema.safeParse({ source_target: sourceTarget, byte_budget: 65537 }).success
    ).toBe(false);
    expect(
      SoulOpenPointerRequestSchema.parse({ source_target: sourceTarget, start_offset: 128, byte_budget: 4096 })
    ).toEqual({ source_target: sourceTarget, start_offset: 128, byte_budget: 4096 });
  });

  it("forbids minted object_id on source_evidence open_pointer responses", () => {
    const validDisclosure = [
      1,
      "original_body",
      "unbound",
      null,
      "2026-05-01T00:00:00.000Z",
      { kind: "unknown", reason: "unbound" },
      { kind: "unknown", reason: "unbound" },
      "unknown",
      { kind: "source_only", qualification: "not_current_proof" }
    ] as const;
    expect(sourceDisclosure(validDisclosure).proof_use.kind).toBe("source_only");
    const span = {
      content_start: 0,
      content_end: 12,
      retained_extent: "body" as const,
      content_complete: true,
      original_complete: true
    };
    const response = {
      object_kind: "source_evidence",
      target: {
        kind: "source_evidence" as const,
        workspace_id: "ws-1",
        root_kind: "source_record" as const,
        root_id: "rec-1",
        source_version: "v1",
        content_digest: DIGEST,
        evidence_object_id: null,
        span
      },
      content: {
        object_kind: "source_evidence",
        schema_version: 1,
        content: "hello source",
        domain_tags: [],
        evidence_refs: [],
        text_disclosures: { content: validDisclosure, gist: validDisclosure },
        source_disclosure: validDisclosure,
        span
      }
    };
    expect(SoulOpenPointerResponseSchema.parse(response).object_id).toBeUndefined();
    expect(
      SoulOpenPointerResponseSchema.safeParse({ ...response, object_id: "minted-1" }).success
    ).toBe(false);
  });
});
