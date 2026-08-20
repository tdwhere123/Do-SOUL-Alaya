import { describe, expect, it, vi } from "vitest";

import {
  captureRecallQueryFactFrames,
  produceRelationQueryFieldAttributionContribution,
  verifyRecallQueryFactFrameExtractionCapture
} from "../../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";
import { compileRecallQueryDemand } from
  "../../../recall/query/recall-query-demand.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { digestRecallFieldIdentity } from
  "../../../recall/field/field-identity.js";
import { captureRecallQueryEntities } from
  "../../../recall/field/query-entity-attribution-producer.js";
import { collectQueryFieldAttribution } from
  "../../../recall/supplements/query/query-field-attribution.js";

describe("query fact-frame relation attribution producer", () => {
  it("grounds a structured relation slot to its exact query span", async () => {
    const query = "Where did I buy a desk from IKEA?";
    const extract = vi.fn(async () => [purchaseFrame()]);
    const capture = await captureRecallQueryFactFrames({
      query_text: query,
      port: { operator_id: "structured_query_frame_v1", extract }
    });
    const contribution = produceRelationQueryFieldAttributionContribution({
      query_text: query,
      query_demand: compileRecallQueryDemand(compileRecallQueryProbes(query)),
      capture
    });

    expect(extract).toHaveBeenCalledWith(query, { maxFrames: 8 });
    expect(capture.status).toBe("returned");
    expect(contribution?.attributions).toEqual([{
      query_atom_id: "lexical_term:buy",
      role: "relation",
      source_spans: [[12, 15]]
    }]);
  });

  it("fails closed when a proposed frame is not source-grounded", async () => {
    const onFailure = vi.fn();
    const capture = await captureRecallQueryFactFrames({
      query_text: "Where did I buy a desk?",
      port: {
        operator_id: "structured_query_frame_v1",
        extract: async () => [{
          schema_version: 1,
          slots: [
            { role: "subject", text: "I" },
            { role: "relation", text: "purchase" },
            { role: "value", text: "desk" }
          ]
        }]
      },
      on_failure: onFailure
    });

    expect(capture.status).toBe("unavailable");
    expect(capture.frames).toEqual([]);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("distinguishes absent parsing capability from an empty result", async () => {
    const unavailable = await captureRecallQueryFactFrames({
      query_text: "query"
    });
    const empty = await captureRecallQueryFactFrames({
      query_text: "query",
      port: {
        operator_id: "structured_query_frame_v1",
        extract: async () => []
      }
    });

    expect(unavailable.status).toBe("unavailable");
    expect(empty.status).toBe("returned");
  });

  it("carries a grounded stop-listed predicate into canonical typed demand", async () => {
    const query = "How many playlists do I have on Spotify?";
    const entityCapture = await captureRecallQueryEntities({ query_text: query });
    const result = await collectQueryFieldAttribution({
      queryText: query,
      queryDemand: compileRecallQueryDemand(compileRecallQueryProbes(query)),
      entityCapture,
      factFramePort: {
        operator_id: "structured_query_frame_v1",
        extract: async () => [{
          schema_version: 1,
          slots: [
            { role: "value", text: "How many playlists" },
            { role: "subject", text: "I" },
            { role: "relation", text: "have" }
          ]
        }]
      }
    });

    expect(result.attribution?.attributions).toContainEqual({
      query_atom_id: "lexical_term:have",
      role: "relation"
    });
  });

  it("rejects source offsets changed after capture sealing", async () => {
    const query = "Where did I buy a desk from IKEA?";
    const capture = await captureRecallQueryFactFrames({
      query_text: query,
      port: {
        operator_id: "structured_query_frame_v1",
        extract: async () => [purchaseFrame()]
      }
    });
    const frame = capture.frames[0]!;
    const relation = frame.slots[1]!;
    const forgedBody = {
      ...capture,
      frames: [{
        ...frame,
        slots: [
          frame.slots[0]!,
          { ...relation, source_offset: [11, 14] as const },
          ...frame.slots.slice(2)
        ]
      }]
    };
    const { capture_digest: _digest, ...body } = forgedBody;
    const forged = {
      ...body,
      capture_digest: digestRecallFieldIdentity(body)
    };

    expect(() => verifyRecallQueryFactFrameExtractionCapture(forged)).not.toThrow();
    expect(() => produceRelationQueryFieldAttributionContribution({
      query_text: query,
      query_demand: compileRecallQueryDemand(compileRecallQueryProbes(query)),
      capture: forged
    })).toThrow(/source-exact/u);
  });

  it("keeps unrelated typed atoms when producers conflict on one atom", async () => {
    const query = "Where did I purchase a desk?";
    const demand = compileRecallQueryDemand(compileRecallQueryProbes(query));
    const entityCapture = await captureRecallQueryEntities({
      query_text: query,
      port: {
        operator_id: "entity_likeness_v1",
        extract: async () => [
          {
            surface: "purchase",
            normalized: "purchase",
            kind: "unknown",
            confidence: 0.35,
            source_offset: [12, 20]
          },
          {
            surface: "desk",
            normalized: "desk",
            kind: "unknown",
            confidence: 0.35,
            source_offset: [23, 27]
          }
        ]
      }
    });
    const onFailure = vi.fn();
    const receipt = await collectQueryFieldAttribution({
      queryText: query,
      queryDemand: demand,
      entityCapture,
      factFramePort: {
        operator_id: "structured_query_frame_v1",
        extract: async () => [{
          schema_version: 1,
          slots: [
            { role: "subject", text: "I" },
            { role: "relation", text: "purchase" },
            { role: "value", text: "desk" }
          ]
        }]
      },
      onFailure
    });

    expect(receipt.attribution?.contributions).toHaveLength(2);
    expect(receipt.attribution?.attributions).toEqual([{
      query_atom_id: "lexical_term:desk",
      role: "entity"
    }]);
    expect(receipt.factFrameCapture.status).toBe("returned");
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reclassifies aggregation failures as unavailable captures", async () => {
    const query = "Where did I buy a desk?";
    const entityCapture = await captureRecallQueryEntities({
      query_text: query,
      port: {
        operator_id: "entity_parser_v1",
        extract: async () => []
      }
    });
    const onFailure = vi.fn();
    const result = await collectQueryFieldAttribution({
      queryText: query,
      queryDemand: compileRecallQueryDemand(compileRecallQueryProbes(query)),
      entityCapture: { ...entityCapture, producer_operator_id: null },
      factFramePort: {
        operator_id: "structured_query_frame_v1",
        extract: async () => []
      },
      onFailure
    });

    expect(result.factFrameCapture.status).toBe("unavailable");
    expect(onFailure).toHaveBeenCalledOnce();
  });
});

function purchaseFrame() {
  return {
    schema_version: 1 as const,
    slots: [
      { role: "subject" as const, text: "I" },
      { role: "relation" as const, text: "buy" },
      { role: "value" as const, text: "desk" },
      { role: "qualifier" as const, text: "IKEA" }
    ]
  };
}
