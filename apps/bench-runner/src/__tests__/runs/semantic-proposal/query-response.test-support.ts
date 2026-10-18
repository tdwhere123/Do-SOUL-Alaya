import { encodeSourceSemanticQueryCarrier } from "@do-soul/alaya-protocol";

export const MIRA_QUERY = "Who sent the sample to Mira?";

export function meaningBody(themeExcerpt: string): string {
  return JSON.stringify({
    contract: "source-semantic-query-response-v8",
    outcome: { status: "interpreted" },
    query: encodeSourceSemanticQueryCarrier({
      contract: "source-semantic-query-meaning-v5",
      alternatives: [{ conditions: [{
        kind: "statement", key: "send", predicate: "send",
        arguments: [
          { role: "sender", target: { kind: "free", key: "sender", return: true }, excerpt: "Who" },
          { role: "theme", target: { kind: "named", key: "sample", excerpt: themeExcerpt }, excerpt: themeExcerpt },
          { role: "recipient", target: { kind: "named", key: "mira", excerpt: "Mira" }, excerpt: "Mira" }
        ]
      }] }],
      gaps: []
    })
  });
}

export function nestedMeaningBody(): string {
  return JSON.stringify({ contract: "source-semantic-query-response-v9", outcome: { status: "interpreted" }, query: {
    contract: "source-semantic-query-meaning-v5",
    entities: [{ kind: "free", key: "sender", excerpt: "Who", return: true },
      { kind: "named", key: "sample", excerpt: "sample" }, { kind: "named", key: "mira", excerpt: "Mira" }],
    alternatives: [{ conditions: [{ kind: "statement", key: "send", predicate: "send", arguments: [
      { role: "sender", target: { kind: "reference", key: "sender" }, excerpt: "Who" },
      { role: "theme", target: { kind: "reference", key: "sample" }, excerpt: "sample" },
      { role: "recipient", target: { kind: "reference", key: "mira" }, excerpt: "Mira" }
    ] }] }], gaps: []
  } });
}
