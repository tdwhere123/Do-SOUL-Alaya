import { SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT } from "@do-soul/alaya-protocol";

export function tableCompletedResponse(assertion_id: number, theme: string) {
  return {
    contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, outcome: { status: "interpreted" },
    content: {
      roots: [{ act: "assertion", expression: { kind: "content_ref", key: "completed" } }],
      entities: [{ form: "entity", key: "theme", semantic_key: "theme", mentions: [{ assertion_id, text: theme }] }],
      nodes: [{ kind: "statement", key: "completed",
        predicate: { kind: "explicit", reading: "complete", support: { assertion_id, text: "completed" } },
        arguments: [{ role: "theme", target: { kind: "entity_ref", key: "theme" } }], qualifications: [] }],
      gaps: [] as object[]
    }
  };
}
