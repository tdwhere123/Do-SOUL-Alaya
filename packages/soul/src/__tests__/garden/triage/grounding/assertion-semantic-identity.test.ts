import { describe, expect, it } from "vitest";
import {
  OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
  buildOfficialApiExtractionRequests,
  computeOfficialApiSourceCorpusIdentity,
  stringifyOfficialApiExtractionRequest
} from "../../../../garden/ingestion/official-api/extraction-request.js";
import {
  indexSourceAssertions,
  OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION
} from "../../../../garden/triage/grounding/source-locator/assertion-catalog.js";
import { buildOfficialApiSourceCorpus } from "../../../../garden/triage/grounding/source-locator.js";
import {
  ASSERTION_SEMANTIC_IDENTITY_CONTRACT_VERSION,
  bindAssertionSource,
  computeAssertionSemanticKey,
  digestSourceText,
  resolveAssertionSemanticContext
} from "../../../../garden/triage/grounding/source-locator/assertion-semantic-identity.js";

const FORMATION = OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION;

function key(input: {
  readonly exactText: string;
  readonly trustedRole?: "user" | "assistant";
  readonly semanticContext?: string;
  readonly formationContractVersion?: number;
}): string {
  return computeAssertionSemanticKey({
    formationContractVersion: input.formationContractVersion ?? FORMATION,
    exactText: input.exactText,
    trustedRole: input.trustedRole ?? "user",
    semanticContext: input.semanticContext ?? ""
  });
}

describe("assertion semantic identity", () => {
  it("is stable across batch size, partition, run, workspace, and transport wrappers", () => {
    const exactText = "User: I moved to Berlin.";
    const semanticKey = key({ exactText });
    const wrappers = [
      { batch_index: 0, batch_count: 1, run_id: "run-a", workspace_id: "ws-a", endpoint: "https://a" },
      { batch_index: 7, batch_count: 8, run_id: "run-b", workspace_id: "ws-b", endpoint: "https://b" }
    ];
    expect(wrappers.map((transport) => ({ transport, semanticKey }))).toEqual(
      wrappers.map((transport) => ({ transport, semanticKey: key({ exactText }) }))
    );
  });

  it("changes when role, exact text, formation contract, or required context changes", () => {
    const base = key({ exactText: "User: She moved to Berlin." });
    expect(key({ exactText: "User: She moved to Paris." })).not.toBe(base);
    expect(key({ exactText: "User: She moved to Berlin.", trustedRole: "assistant" })).not.toBe(base);
    expect(key({
      exactText: "User: She moved to Berlin.",
      formationContractVersion: FORMATION + 1
    })).not.toBe(base);
    const sentence = "I met Alice. User: She moved to Berlin.";
    const context = resolveAssertionSemanticContext("User: She moved to Berlin.", sentence);
    expect(context).toBe(sentence);
    expect(key({ exactText: "User: She moved to Berlin.", semanticContext: context })).not.toBe(base);
  });

  it("keeps one semantic key and two bindings across distinct source corpora", () => {
    const exactText = "User: I moved to Berlin.";
    const semanticKey = key({ exactText });
    const corpusA = "User: I moved to Berlin.\nAssistant: Noted.";
    const corpusB = "User: Hello.\nUser: I moved to Berlin.";
    const bindingA = bindAssertionSource({
      semanticKey,
      sourceCorpusIdentity: computeOfficialApiSourceCorpusIdentity(corpusA),
      sourceTextDigest: digestSourceText(corpusA),
      locator: { assertion_id: 1, start: 0, end: exactText.length },
      datasetRevision: "rev-a"
    });
    const bindingB = bindAssertionSource({
      semanticKey,
      sourceCorpusIdentity: computeOfficialApiSourceCorpusIdentity(corpusB),
      sourceTextDigest: digestSourceText(corpusB),
      locator: { assertion_id: 2, start: 14, end: 14 + exactText.length },
      datasetRevision: "rev-b"
    });
    expect(bindingA.semanticKey).toBe(bindingB.semanticKey);
    expect(bindingA.sourceCorpusIdentity).not.toBe(bindingB.sourceCorpusIdentity);
    expect(bindingA.sourceTextDigest).not.toBe(bindingB.sourceTextDigest);
    expect(bindingA.locator.assertion_id).not.toBe(bindingB.locator.assertion_id);
  });

  it("treats Unicode, CJK, and whitespace as exact identity bytes", () => {
    const cjk = key({ exactText: "我住在杭州。" });
    expect(key({ exactText: "我住在杭州。" })).toBe(cjk);
    expect(key({ exactText: "我住在苏州。" })).not.toBe(cjk);
    expect(key({ exactText: "I moved to Berlin." })).not.toBe(
      key({ exactText: "i moved to berlin." })
    );
    expect(key({ exactText: "I moved to Berlin." })).not.toBe(
      key({ exactText: "I  moved to Berlin." })
    );
    expect(key({ exactText: "café" })).not.toBe(key({ exactText: "cafe" }));
  });

  it("does not collapse parent and child spans by substring similarity", () => {
    const parent = "I bought coffee and I like tea.";
    const child = "I like tea.";
    expect(parent.includes(child)).toBe(true);
    expect(key({ exactText: parent })).not.toBe(key({ exactText: child }));
  });

  it("binds local-antecedent context only when the assertion is not locally closed", () => {
    const closed = "User: I moved to Berlin.";
    expect(resolveAssertionSemanticContext(closed, closed)).toBe("");
    const open = "She moved to Berlin.";
    const sentence = "I met Alice yesterday. She moved to Berlin.";
    expect(resolveAssertionSemanticContext(open, sentence)).toBe(sentence);
    expect(() => resolveAssertionSemanticContext(open, "unrelated sentence.")).toThrow(
      /must contain the exact assertion text/u
    );
  });

  it("rejects empty text and does not accept evaluator or provider fields", () => {
    expect(() => key({ exactText: "" })).toThrow(/exact text/u);
    const identityFn: typeof computeAssertionSemanticKey = computeAssertionSemanticKey;
    expect(identityFn.length).toBe(1);
    expect(ASSERTION_SEMANTIC_IDENTITY_CONTRACT_VERSION).toBe(1);
  });
});

describe("assertion catalog byte-equivalence after identity introduction", () => {
  it("preserves request order, text, and locator partitioning", () => {
    const source = Array.from(
      { length: OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH * 2 + 1 },
      (_, index) => `I recorded durable detail number ${index + 1}.`
    ).join(" ");
    const messages = [{ role: "user" as const, content: source }];
    const corpus = buildOfficialApiSourceCorpus(source, messages);
    const catalog = indexSourceAssertions(corpus);
    const requests = buildOfficialApiExtractionRequests(source, messages);

    expect(catalog.map(({ assertion_id, text }) => ({ assertion_id, text }))).toEqual(
      requests.flatMap((request) => request.source_assertions)
    );
    expect(stringifyOfficialApiExtractionRequest(requests[0]!)).toContain("batch_index");
    expect(new Set(requests.map((request) => request.source_corpus_identity)).size).toBe(1);
    const keys = catalog.map((assertion) => key({ exactText: assertion.text }));
    expect(new Set(keys).size).toBe(catalog.length);
    for (const assertion of catalog) {
      expect(corpus.slice(assertion.start, assertion.end)).toBe(assertion.text);
    }
  });
});
