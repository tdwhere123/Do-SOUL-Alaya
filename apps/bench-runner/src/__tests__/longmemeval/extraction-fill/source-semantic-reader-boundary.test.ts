import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  buildSourceSemanticRequest, parseSourceSemanticRequest, parseRetainedSourceSemanticRequest,
  sourceSemanticRequestCatalog, sourceSemanticResponseJsonSchema, sourceSemanticSystemPrompt,
  retainedSourceSemanticResponseJsonSchema, retainedSourceSemanticSystemPrompt,
  receiveSourceSemantics, verifyRetainedSourceSemantics
} from "@do-soul/alaya-soul";
import { computeRetainedCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";
import { parseSourceSemanticRequestLine, prepareSourceSemanticRequestLine,
  verifyRetainedSourceSemanticRequestLine } from "../../../runs/extraction/request-artifact.js";
import { receiveSourceSemanticBatchLine, verifyRetainedSourceSemanticBatchLine
} from "../../../runs/extraction/fill/batch/source-semantic-interpretation.js";

it("keeps a retained v2 producer response out of current request and Batch admission", () => {
  const input = { sourceCorpus: "Ada sealed crate.", sourceScope: "complete-source" as const, assertionIds: [1],
    source_id: "source", source_version: "1", producer_id: "test-author", producer_version: "1" };
  const current = buildSourceSemanticRequest(input);
  const { source_digest: _digest, ...wrapper } = current;
  const old = { ...wrapper, source_catalog: sourceSemanticRequestCatalog(current), source_request: {
    ...current.source_request, generation_schema_contract: undefined, proposal_contract: "source-semantic-proposal-v2"
  } };
  const retained = parseRetainedSourceSemanticRequest(old);
  const rawJson = JSON.stringify({ contract: "source-semantic-proposal-v2", outcome: { status: "interpreted" }, content: {
    entities: [], statements: [{ id: "seal", predicate: { kind: "explicit", reading: "seal",
      evidence: [{ assertion_id: 1, source_ref: { first: "a1s2", last: "a1s2" } }] }, arguments: [] }],
    operators: [], acts: [{ occurrence: "seal", act: "assertion" }], gaps: [] } });
  const archived = verifyRetainedSourceSemantics(rawJson, retained, input);
  expect(archived.eligibility).toBe("retained_only");
  expect(archived.result.outcome.status).toBe("interpreted");
  expect(archived.result.rawJson).toBe(rawJson);
  expect(archived.result.interpretation?.normalizer_version).toBe("source-semantic-normalizer-v5");
  expect(() => parseSourceSemanticRequest(old)).toThrow(/ineligible/u);
  expect(() => receiveSourceSemantics(rawJson, retained, input)).toThrow(/ineligible/u);
  expect(() => sourceSemanticSystemPrompt(retained)).toThrow(/ineligible/u);
  expect(() => sourceSemanticResponseJsonSchema(retained)).toThrow(/ineligible/u);
  expect(retainedSourceSemanticSystemPrompt(retained)).toContain("source-semantic-proposal-v2");
  expect(JSON.stringify(retainedSourceSemanticResponseJsonSchema(retained))).toContain("source-semantic-proposal-v2");

  const config = { model: "gemini-2.5-flash-lite", requestProfile: "gemini-2.5-nonthinking-v1" as const };
  const userPrompt = JSON.stringify(retained), systemPrompt = retainedSourceSemanticSystemPrompt(retained);
  const line = { key: computeRetainedCacheKey(config.model, config.requestProfile, systemPrompt, userPrompt),
    unitKeys: ["source"], requestSha256: createHash("sha256").update(userPrompt).digest("hex"), systemPrompt, userPrompt };
  expect(verifyRetainedSourceSemanticRequestLine(line, config).eligibility).toBe("retained_only");
  expect(verifyRetainedSourceSemanticBatchLine({ config, line, rawJson, sourceCorpus: input.sourceCorpus,
    proposal: input }).result.interpretation).toEqual(archived.result.interpretation);
  expect(() => prepareSourceSemanticRequestLine(retained, line.unitKeys, config)).toThrow(/ineligible/u);
  expect(() => parseSourceSemanticRequestLine(line, config)).toThrow(/malformed/u);
  expect(() => receiveSourceSemanticBatchLine({ config, line, rawJson, sourceCorpus: input.sourceCorpus,
    proposal: input })).toThrow(/ineligible/u);
});
