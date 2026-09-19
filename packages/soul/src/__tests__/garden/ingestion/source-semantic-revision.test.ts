import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT, buildSourceSemanticRequest, parseSourceSemanticRequest } from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { prepareSourceSemanticRevision } from "../../../garden/ingestion/official-api/source-semantic-revision.js";
import { receiveSourceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";

const input = { sourceCorpus: "Mira promised to lend the atlas. Every visitor might read it.", assertionIds: [1, 2],
  source_id: "revision", source_version: "1", producer_id: "authored", producer_version: "1" };
const raw = SOURCE_SEMANTIC_SYSTEM_PROMPT.split("Example response:\n")[1]!;

describe("source-bound explicit proposal revisions", () => {
  it("retains rejected raw and precise diagnostics while applying unchanged admission to the replacement", () => {
    const parent = buildSourceSemanticRequest(input);
    const broken = JSON.parse(raw);
    broken.content.statements[1].arguments[0].target.id = "absent";
    const previous = JSON.stringify(broken);
    const original = receiveSourceSemantics(previous, parent, input);
    expect(original.outcome.status).toBe("invalid");
    const revision = prepareSourceSemanticRevision(parent, previous, [{ assertion_ids: [1], comment: "Preserve the lender and promised loan scope." }]);
    expect(revision.structural_diagnostics[0]).toMatchObject({ path: ["content", "statements", 1, "arguments", 0, "target", "id"] });
    const request = buildSourceSemanticRequest({ ...input, revision });
    expect(request.source_request.revision?.previous_response).toBe(previous);
    expect(receiveSourceSemantics(previous, request, input).outcome.status).toBe("invalid");
    const replacement = receiveSourceSemantics(raw, request, input);
    expect(replacement.outcome.status).toBe("interpreted");
    expect(replacement.interpretation!.asserted_at_scope).not.toContain("loan");
    expect(original.rawJson).toBe(previous);
    expect(original.interpretation).toBeUndefined();
  });

  it("rejects foreign sources, changed prior raw and out-of-catalog review before production", () => {
    const parent = buildSourceSemanticRequest(input);
    const revision = prepareSourceSemanticRevision(parent, raw);
    expect(() => buildSourceSemanticRequest({ ...input, sourceCorpus: input.sourceCorpus.replace("Mira", "Nora"), revision })).toThrow(/different original source/u);
    expect(() => buildSourceSemanticRequest({ ...input, revision: { ...revision, previous_response: "{}" } })).toThrow(/digest mismatch/u);
    expect(() => prepareSourceSemanticRevision(parent, raw, [{ assertion_ids: [9], comment: "Foreign assertion" }])).toThrow(/unselected assertion/u);
    expect(() => prepareSourceSemanticRevision(parent, "{")).toThrow(/complete retained JSON/u);
    expect(() => buildSourceSemanticRequest({ ...input, revision: { ...revision, parent_request_sha256: "0".repeat(64) } })).toThrow(/parent identity/u);
    expect(() => buildSourceSemanticRequest({ ...input, revision: { ...revision, revision_number: 2 } })).toThrow(/immediate parent/u);
    expect(() => buildSourceSemanticRequest({ ...input, revision: { ...revision, structural_diagnostics: [
      { code: "custom", path: ["content"], message: "Fabricated compiler finding" }
    ] } })).toThrow(/diagnostics differ/u);
  });

  it("caps explicit revisions and validates each immediate parent in the bounded retained chain", () => {
    let request = buildSourceSemanticRequest(input);
    const parents = new Set<string>();
    for (let number = 1; number <= 3; number++) {
      const revision = prepareSourceSemanticRevision(request, raw);
      expect(revision.revision_number).toBe(number);
      expect(parents.has(revision.parent_request_sha256)).toBe(false);
      parents.add(revision.parent_request_sha256);
      request = buildSourceSemanticRequest({ ...input, revision });
    }
    expect(() => prepareSourceSemanticRevision(request, raw)).toThrow();
    expect(() => parseSourceSemanticRequest({ ...request, source_request: { ...request.source_request,
      proposal_contract: "source-semantic-proposal-v1" } })).toThrow(/revision requires/u);
  });
});
