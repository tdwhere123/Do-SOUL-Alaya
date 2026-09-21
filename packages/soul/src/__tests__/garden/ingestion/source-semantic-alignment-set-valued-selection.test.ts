import { describe, expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION,
  SourceSemanticInterpretationSchema, SourceSemanticQuerySchema,
  sourceSemanticInterpretationIdentity
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_ALIGNMENT_SYSTEM_PROMPT, semanticSha256
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { proposeAlignmentSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";

const SET_VALUED = "Which brands offer which items?";

const role = (id: string, variable: string, excerpt: string) => ({
  id, role_reading: id, target_variable: variable, support: { kind: "query_text" as const, excerpt }
});

function setValuedQuery() {
  return SourceSemanticQuerySchema.parse({
    contract: "source-semantic-query-v2",
    original_query_digest: `sha256:${semanticSha256(SET_VALUED)}`,
    producer_id: "query-producer", producer_version: "1", contract_version: "source-semantic-query-v2",
    variables: [
      { id: "offer_action", sort: "proposition" },
      { id: "brand", sort: "entity" },
      { id: "item", sort: "entity" }
    ],
    alternatives: [{
      frames: [{
        id: "offer_action", variable: "offer_action", predicate_reading: "offer",
        role_requirements: [
          role("agent", "brand", "Which brands"),
          role("theme", "item", "which items")
        ]
      }],
      context_obligations: [{ frame: "offer_action", kind: "asserted_at_source" }]
    }],
    return_variables: ["brand", "item"],
    gaps: []
  });
}

function twoOfferInterpretation() {
  const mention = (id: string, text: string, index: number) => ({
    id, assertion_id: 1, source_ref: { first: `a1s${index}`, last: `a1s${index}` },
    text, utf8_span: [index, index + text.length]
  });
  const offer = (id: string, brand: string, item: string, offerMention: string) => ({
    id, assertion_ids: [1],
    context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
    additional_support: [],
    predicate_support: { kind: "explicit" as const, reading: "offer", mentions: [offerMention] },
    slots: [
      { id: "agent", role_reading: "brand", support: [{ kind: "lexical" as const, mentions: [brand] }] },
      { id: "theme", role_reading: "item", support: [{ kind: "lexical" as const, mentions: [item] }] }
    ],
    bindings: [
      { slot_id: "agent", target: { kind: "node" as const, id: brand.replace("m", "r") }, support: [] },
      { slot_id: "theme", target: { kind: "node" as const, id: item.replace("m", "r") }, support: [] }
    ]
  });
  return SourceSemanticInterpretationSchema.parse({
    contract: "source-interpretation-v4",
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "src", source_version: "1", content_digest: `sha256:${semanticSha256(SET_VALUED)}` },
    producer_id: "h-producer", producer_version: "1", contract_version: "source-interpretation-v4",
    mentions: [
      mention("mPhilips", "Philips", 0), mention("mStylish", "stylish", 1), mention("mOffer1", "offers", 2),
      mention("mLutron", "Lutron", 3), mention("mDimmer", "dimmer", 4), mention("mOffer2", "offers", 5)
    ],
    referents: [
      { id: "rPhilips", referent_kind: "grouped", mentions: ["mPhilips"] },
      { id: "rStylish", referent_kind: "grouped", mentions: ["mStylish"] },
      { id: "rLutron", referent_kind: "grouped", mentions: ["mLutron"] },
      { id: "rDimmer", referent_kind: "grouped", mentions: ["mDimmer"] }
    ],
    frames: [
      offer("fPhilips", "mPhilips", "mStylish", "mOffer1"),
      offer("fLutron", "mLutron", "mDimmer", "mOffer2")
    ],
    operators: [], gaps: [], entry_roots: ["fPhilips", "fLutron"], asserted_at_scope: ["fPhilips", "fLutron"]
  });
}

function offerSelections(
  catalog: NonNullable<ReturnType<typeof proposeAlignmentSemantics>["request"]["catalog"]>,
  frames: readonly string[]
) {
  const queryByKind = {
    predicate: catalog.query_endpoints.find((row) => row.kind === "predicate")!,
    agent: catalog.query_endpoints.find((row) => row.kind === "slot" && row.slot === "agent")!,
    theme: catalog.query_endpoints.find((row) => row.kind === "slot" && row.slot === "theme")!
  };
  const selections = [];
  for (const frame of frames) {
    const sourceFrame = catalog.source_endpoints.find((row) => row.kind === "frame" && row.frame === frame)!;
    const agent = catalog.source_endpoints.find((row) => row.kind === "slot" && row.frame === frame && row.slot === "agent")!;
    const theme = catalog.source_endpoints.find((row) => row.kind === "slot" && row.frame === frame && row.slot === "theme")!;
    selections.push(
      { query: queryByKind.predicate.handle, source: sourceFrame.handle, query_excerpt: "offer",
        source_semantic_support: [{ kind: "lexical" as const, mentions: [frame === "fPhilips" ? "mOffer1" : "mOffer2"] }] },
      { query: queryByKind.agent.handle, source: agent.handle, query_excerpt: "Which brands",
        source_semantic_support: [{ kind: "lexical" as const, mentions: [frame === "fPhilips" ? "mPhilips" : "mLutron"] }] },
      { query: queryByKind.theme.handle, source: theme.handle, query_excerpt: "which items",
        source_semantic_support: [{ kind: "lexical" as const, mentions: [frame === "fPhilips" ? "mStylish" : "mDimmer"] }] }
    );
  }
  return selections;
}

describe("set-valued alignment selections stay producer-owned", () => {
  it("asks the producer for one selection group per matching asserted frame", () => {
    expect(SOURCE_SEMANTIC_ALIGNMENT_SYSTEM_PROMPT).toContain(
      "must emit a selection group for each matching asserted frame"
    );
    expect(SOURCE_SEMANTIC_ALIGNMENT_SYSTEM_PROMPT).toContain("Do not collapse those frames onto the first hit");
    expect(SOURCE_SEMANTIC_ALIGNMENT_SYSTEM_PROMPT).toContain("The host does not complete omitted selections");
  });

  it("still admits a first-pass single-frame selection as interpreted", () => {
    const h = twoOfferInterpretation();
    const hId = sourceSemanticInterpretationIdentity(h, semanticSha256);
    const admitted = setValuedQuery();
    const prepared = proposeAlignmentSemantics({
      original_query: SET_VALUED, admitted_q: admitted,
      h_descriptors: [{ h_id: hId, interpretation: h }],
      producer_id: "align-producer", producer_version: "1"
    });
    const catalog = prepared.request.catalog!;
    expect(catalog.source_endpoints.filter((row) => row.kind === "frame" && row.reading === "offer")).toHaveLength(2);
    const received = proposeAlignmentSemantics({
      original_query: SET_VALUED, admitted_q: admitted,
      h_descriptors: [{ h_id: hId, interpretation: h }],
      producer_id: "align-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-alignment-response-v3",
        outcome: { status: "interpreted" },
        alignment: {
          contract: "source-semantic-alignment-selection-v1", h: "h1",
          selections: offerSelections(catalog, ["fPhilips"])
        }
      })
    });
    expect(received.outcome.status).toBe("interpreted");
    expect(received.alignment?.correspondences).toHaveLength(3);
    expect(received.alignment?.correspondences.map((row) =>
      row.source_endpoint.kind === "referent" ? undefined : row.source_endpoint.frame
    )).toEqual(["fPhilips", "fPhilips", "fPhilips"]);
  });

  it("materializes one selection group per matching frame without adding omitted pairs", () => {
    const h = twoOfferInterpretation();
    const hId = sourceSemanticInterpretationIdentity(h, semanticSha256);
    const admitted = setValuedQuery();
    const prepared = proposeAlignmentSemantics({
      original_query: SET_VALUED, admitted_q: admitted,
      h_descriptors: [{ h_id: hId, interpretation: h }],
      producer_id: "align-producer", producer_version: "1"
    });
    const received = proposeAlignmentSemantics({
      original_query: SET_VALUED, admitted_q: admitted,
      h_descriptors: [{ h_id: hId, interpretation: h }],
      producer_id: "align-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-alignment-response-v3",
        outcome: { status: "interpreted" },
        alignment: {
          contract: "source-semantic-alignment-selection-v1", h: "h1",
          selections: offerSelections(prepared.request.catalog!, ["fPhilips", "fLutron"])
        }
      })
    });
    expect(received.outcome.status).toBe("interpreted");
    expect(received.alignment?.correspondences).toHaveLength(6);
    expect(new Set(received.alignment?.correspondences.map((row) =>
      row.source_endpoint.kind === "referent" ? undefined : row.source_endpoint.frame
    ))).toEqual(new Set(["fPhilips", "fLutron"]));
  });
});
