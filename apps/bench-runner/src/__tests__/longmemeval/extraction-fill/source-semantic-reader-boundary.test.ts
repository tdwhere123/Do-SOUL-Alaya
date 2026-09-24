import { expect, it } from "vitest";
import {
  buildSourceSemanticRequest, parseSourceSemanticRequest, receiveSourceSemantics,
  sourceSemanticResponseJsonSchema, sourceSemanticSystemPrompt
} from "@do-soul/alaya-soul";
import { receiveSourceSemanticBatchLine } from "../../../runs/extraction/fill/batch/source-semantic-interpretation.js";

it("keeps an old producer envelope outside current request and Batch admission", () => {
  const input = { sourceCorpus: "Ada sealed crate.", sourceScope: "complete-source" as const, assertionIds: [1],
    source_id: "source", source_version: "1", producer_id: "test-author", producer_version: "1" };
  const current = buildSourceSemanticRequest(input);
  const oldRequest = { ...current, source_request: {
    ...current.source_request, proposal_contract: "source-semantic-proposal-v2"
  } };
  const recorded = oldRequest as unknown as typeof current;
  const rawJson = JSON.stringify({ contract: "source-semantic-proposal-v2", outcome: { status: "abstained" } });
  expect(() => parseSourceSemanticRequest(oldRequest)).toThrow();
  expect(() => sourceSemanticSystemPrompt(recorded)).toThrow();
  expect(() => sourceSemanticResponseJsonSchema(recorded)).toThrow();
  expect(receiveSourceSemantics(rawJson, current, input).outcome.status).toBe("invalid");
  const line = { key: "recorded-old-key", unitKeys: ["source"], requestSha256: "recorded-request-digest",
    userPrompt: JSON.stringify(oldRequest), systemPrompt: "recorded old prompt" };
  expect(() => receiveSourceSemanticBatchLine({ config: {
    model: "gemini-2.5-flash-lite", requestProfile: "gemini-2.5-nonthinking-v1"
  }, line, rawJson, sourceCorpus: input.sourceCorpus, proposal: input })).toThrow();
});
