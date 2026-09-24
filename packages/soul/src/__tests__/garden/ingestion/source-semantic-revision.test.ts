import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT, buildSourceSemanticRequest, parseSourceSemanticRequest } from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { prepareSourceSemanticRevision } from "../../../garden/ingestion/official-api/source-semantic-revision.js";
import { receiveSourceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";

const input = { sourceCorpus: "The permit is valid on Tuesday only. The clerk does not know whether the permit is valid on Thursday.", assertionIds: [1, 2],
  source_id: "revision", source_version: "1", producer_id: "authored", producer_version: "1" };
const raw = SOURCE_SEMANTIC_SYSTEM_PROMPT.split("Example response:\n")[1]!;

describe("source-bound explicit proposal revisions", () => {
  it("retains invalid JSON only with explicit observed completion and keeps replacement admission strict", () => {
    const parent = buildSourceSemanticRequest(input), malformed = raw + "}";
    const revision = prepareSourceSemanticRevision(parent, malformed, [], { responseCompletion: "complete" });
    expect(revision.contract).toBe("source-semantic-revision-v2");
    expect(revision.structural_diagnostics).toEqual([{ code: "invalid_json", path: [], message: expect.any(String) }]);
    const request = buildSourceSemanticRequest({ ...input, revision });
    expect(request.source_request.revision?.previous_response).toBe(malformed);
    expect(receiveSourceSemantics(malformed, request, input).outcome).toMatchObject({ status: "invalid", reason: "malformed_json" });
    expect(receiveSourceSemantics(raw, request, input).outcome.status).toBe("interpreted");
    for (const responseCompletion of ["truncated", "unknown"] as const)
      expect(() => prepareSourceSemanticRevision(parent, malformed, [], { responseCompletion })).toThrow(/observed completion/u);
    expect(() => prepareSourceSemanticRevision(parent, malformed)).toThrow(/complete retained JSON/u);
    expect(() => prepareSourceSemanticRevision(parent, "  ", [], { responseCompletion: "complete" })).toThrow(/nonempty/u);
    expect(() => parseSourceSemanticRequest({ ...request, source_request: { ...request.source_request,
      revision: { ...revision, previous_response_completion: "unknown" } } })).toThrow();
    expect(() => parseSourceSemanticRequest({ ...request, source_request: { ...request.source_request,
      revision: { ...revision, structural_diagnostics: [] } } })).toThrow(/diagnostics differ/u);
  });

  it("preserves historical revision bytes and validates mixed legacy and completed-response chains", () => {
    const parent = buildSourceSemanticRequest(input);
    const legacy = prepareSourceSemanticRevision(parent, raw);
    expect(legacy.contract).toBe("source-semantic-revision-v1");
    expect(legacy).not.toHaveProperty("previous_response_completion");
    const first = buildSourceSemanticRequest({ ...input, revision: legacy });
    const next = prepareSourceSemanticRevision(first, raw + "}", [], { responseCompletion: "complete" });
    expect(next.revision_number).toBe(2);
    const request = buildSourceSemanticRequest({ ...input, revision: next });
    expect(parseSourceSemanticRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(JSON.parse(next.parent_request_json).source_request.revision).toEqual(legacy);
  });

  it("retains rejected raw and precise diagnostics while applying unchanged admission to the replacement", () => {
    const parent = buildSourceSemanticRequest(input);
    const broken = JSON.parse(raw);
    broken.content.nodes.find((node: { key: string }) => node.key === "knowledge").arguments[1].target =
      { kind: "content_ref", key: "absent" };
    const previous = JSON.stringify(broken);
    const original = receiveSourceSemantics(previous, parent, input);
    expect(original.outcome.status).toBe("invalid");
    const revision = prepareSourceSemanticRevision(parent, previous, [{ assertion_ids: [2], comment: "Preserve the supplied proposition under uncertainty." }]);
    expect(revision.structural_diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(revision.structural_diagnostics)).toContain("absent");
    const request = buildSourceSemanticRequest({ ...input, revision });
    expect(request.source_request.revision?.previous_response).toBe(previous);
    expect(receiveSourceSemantics(previous, request, input).outcome.status).toBe("invalid");
    const replacement = receiveSourceSemantics(raw, request, input);
    expect(replacement.outcome.status).toBe("interpreted");
    const embedded = replacement.interpretation!.frames.find((row) => row.predicate_support.reading === "valid"
      && row.context_owner.kind === "embedding")!;
    expect(replacement.interpretation!.asserted_at_scope).not.toContain(embedded.id);
    expect(original.rawJson).toBe(previous);
    expect(original.interpretation).toBeUndefined();
  });

  it("rejects foreign sources, changed prior raw and out-of-catalog review before production", () => {
    const parent = buildSourceSemanticRequest(input);
    const revision = prepareSourceSemanticRevision(parent, raw);
    expect(() => buildSourceSemanticRequest({ ...input, sourceCorpus: input.sourceCorpus.replace("Tuesday", "Monday"), revision })).toThrow(/different original source/u);
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
      proposal_contract: "source-semantic-proposal-v1" } })).toThrow(/proposal_contract/u);
  });
});
