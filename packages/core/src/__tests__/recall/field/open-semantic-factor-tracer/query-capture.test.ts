import { describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { captureRecallQueryOpenSemanticFactors } from
  "../../../../recall/field/open-semantic-factors/query-capture.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { evidenceProposal, proposal, queryProposal } from "./fixture.js";

describe("open semantic factor query capture", () => {
  it("keeps unavailable formation explicit instead of guessing structure", () => {
    const unavailable = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: "What did I buy?",
    });

    expect(unavailable).toMatchObject({ status: "unavailable", graph: null });
  });

  it("captures query structure through the shared open compiler port", async () => {
    const query = await captureRecallQueryOpenSemanticFactors({
      query_text: "What do I use for research?",
      port: {
        operator_id: "open-factor-test-producer-v1",
        extract: async () => queryProposal()
      }
    });

    expect(query).toMatchObject({
      status: "formed",
      producer_operator_id: "open-factor-test-producer-v1",
      graph: { source_kind: "query" }
    });
  });

  it("reuses a prepared query proposal without invoking the extraction port", async () => {
    let extractionCalls = 0;
    const queryText = "What do I use for research?";
    const query = await captureRecallQueryOpenSemanticFactors({
      query_text: queryText,
      port: {
        operator_id: "open-factor-test-producer-v1",
        extract: async () => {
          extractionCalls += 1;
          return null;
        }
      },
      prepared_proposal: {
        schema_version: 1,
        producer_operator_id: "open-factor-test-producer-v1",
        source_text: queryText,
        graph: queryProposal()
      }
    });

    expect(extractionCalls).toBe(0);
    expect(query).toMatchObject({ status: "formed", graph: { source_kind: "query" } });
  });

  it("rejects a prepared query proposal for a different source", async () => {
    const query = await captureRecallQueryOpenSemanticFactors({
      query_text: "What do I use for research?",
      prepared_proposal: {
        schema_version: 1,
        producer_operator_id: "open-factor-test-producer-v1",
        source_text: "What do I buy?",
        graph: queryProposal()
      }
    });

    expect(query).toMatchObject({ status: "rejected", graph: null });
  });

  it("reuses a validated query formation capture without invoking the port", async () => {
    const queryText = "What do I use for research?";
    const prepared = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: queryText,
      proposal: proposal(queryText, queryProposal())
    });
    let extractionCalls = 0;
    const query = await captureRecallQueryOpenSemanticFactors({
      query_text: queryText,
      port: {
        operator_id: "unused-query-port-v1",
        extract: async () => {
          extractionCalls += 1;
          return null;
        }
      },
      prepared_capture: prepared
    });

    expect(extractionCalls).toBe(0);
    expect(query).toEqual(prepared);
  });

  it("bounds a non-ranking compatibility trace by evidence identity", async () => {
    const evidence = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: "I used Atlas for research.",
      proposal: proposal("I used Atlas for research.", evidenceProposal())
    });
    const query = await captureRecallQueryOpenSemanticFactors({
      query_text: "What do I use for research?",
      port: {
        operator_id: "open-factor-test-producer-v1",
        extract: async () => queryProposal()
      }
    });

    expect(materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: { "evidence-atlas": evidence }
    })).toMatchObject({
      observed_evidence_count: 1,
      evaluated_evidence_count: 1,
      truncated: false,
      entries: [{ evidence_id: "evidence-atlas", receipt: { status: "compatible" } }]
    });
  });
});
