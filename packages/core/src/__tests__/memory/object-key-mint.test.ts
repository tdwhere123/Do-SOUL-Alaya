import { describe, expect, it } from "vitest";
import type { OpenSemanticFactorGraph } from "@do-soul/alaya-protocol";
import { mintMemoryObjectKeys } from "../../memory/object-keys/mint.js";

const OWNER = "memory-1";
const WORKSPACE = "workspace-1";
const EVIDENCE = "capsule-1";

describe("mintMemoryObjectKeys", () => {
  it("mints gist-remainder keys that are not already in distilled content", () => {
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "I took my niece to the museum.",
      evidence: [{
        object_id: EVIDENCE,
        gist: "By the way, I took my niece to the Natural History Museum. She loves her Golden Retriever.",
        fact_key_contents: ["I took my niece to the museum"],
        osf_graph: null
      }]
    });

    expect(surfacesOf(keys, "gist_remainder")).toEqual(
      expect.arrayContaining(["Golden Retriever"])
    );
    expect(keys.every((key) => key.source_ref.startsWith("evidence:capsule-1:"))).toBe(true);
    expect(keys.some((key) => key.surface.toLowerCase().includes("niece"))).toBe(false);
  });

  it("mints OSF factor surfaces and distinct semantic identities", () => {
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "I bought books.",
      evidence: [{
        object_id: EVIDENCE,
        gist: "I bought three used books in July.",
        fact_key_contents: [],
        osf_graph: osfGraph()
      }]
    });

    expect(surfacesOf(keys, "osf_surface")).toEqual(
      expect.arrayContaining(["three used books", "July"])
    );
    expect(surfacesOf(keys, "osf_identity")).toEqual(
      expect.arrayContaining(["buy"])
    );
  });

  it("normalizes stored date surfaces into complementary aliases without inventing a year", () => {
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "I took my niece to the museum on 2/8.",
      evidence: [{
        object_id: EVIDENCE,
        gist: "I took my niece to the Natural History Museum on 2/8.",
        fact_key_contents: [],
        osf_graph: null
      }]
    });

    const aliases = surfacesOf(keys, "temporal_alias");
    expect(aliases).toEqual(expect.arrayContaining(["February 8", "2月8日", "February"]));
    expect(aliases.some((surface) => /\d{4}/u.test(surface))).toBe(false);
  });

  it("aliases CJK calendar and relative forms that already appear in stored text", () => {
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "我们3天前去过博物馆。",
      evidence: [{
        object_id: EVIDENCE,
        gist: "我们2月8日去过博物馆，那是3天前。",
        fact_key_contents: [],
        osf_graph: null
      }]
    });

    const aliases = surfacesOf(keys, "temporal_alias");
    expect(aliases).toEqual(expect.arrayContaining(["February 8", "2/8", "3 days ago"]));
  });

  it("skips a remainder whose normalized form already exists on the object", () => {
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "Golden Retriever",
      evidence: [{
        object_id: EVIDENCE,
        gist: "She loves her Golden Retriever.",
        fact_key_contents: ["Golden Retriever"],
        osf_graph: null
      }]
    });

    expect(surfacesOf(keys, "gist_remainder")).not.toEqual(
      expect.arrayContaining(["Golden Retriever"])
    );
  });
});

function surfacesOf(
  keys: readonly Readonly<{ readonly key_type: string; readonly surface: string }>[],
  keyType: string
): readonly string[] {
  return keys.filter((key) => key.key_type === keyType).map((key) => key.surface);
}

function osfGraph(): OpenSemanticFactorGraph {
  return {
    schema_version: 1,
    source_kind: "evidence",
    factors: [
      {
        factor_id: "predicate",
        surface: "bought",
        source_span: [2, 8],
        semantic_identity: "buy"
      },
      {
        factor_id: "purchase",
        surface: "three used books",
        source_span: [9, 25],
        semantic_identity: "three used books"
      },
      {
        factor_id: "period",
        surface: "July",
        source_span: [29, 33],
        semantic_identity: "july"
      }
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "purchase-event",
      predicate_factor_id: "predicate",
      arguments: [
        {
          position: 0,
          binding_identity: "buy",
          reference_kind: "factor",
          reference_id: "predicate"
        },
        {
          position: 1,
          binding_identity: "three used books",
          reference_kind: "factor",
          reference_id: "purchase"
        },
        {
          position: 2,
          binding_identity: "july",
          reference_kind: "factor",
          reference_id: "period"
        }
      ]
    }]
  };
}
