import { expect, it } from "vitest";
import { buildSourceSemanticQueryRequest } from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { prepareSourceSemanticProposalRevision } from "../../../garden/ingestion/official-api/source-semantic-proposal-revision.js";

const input = { original_query: "Which format did Atlas choose?", producer_id: "query-producer",
  producer_version: "1" };

it("keeps a query revision on unchanged original input and complete parent response", () => {
  const parent = buildSourceSemanticQueryRequest(input);
  const revision = prepareSourceSemanticProposalRevision({ kind: "query", parent_request: parent,
    previous_response: '{"outcome":{"status":"interpreted"}}', response_completion: "complete" });
  const child = buildSourceSemanticQueryRequest({ ...input, revision });
  expect(child.revision?.parent_request_json).toBe(JSON.stringify(parent));
  expect(child.original_query_digest).toBe(parent.original_query_digest);
  expect(JSON.stringify(child)).not.toBe(JSON.stringify(parent));
  expect(() => buildSourceSemanticQueryRequest({ ...input, original_query: "Which format did Beacon choose?", revision }))
    .toThrow(/original request/u);
  expect(() => buildSourceSemanticQueryRequest({ ...input, revision: { ...revision,
    previous_response: "{}" } })).toThrow();
  expect(() => prepareSourceSemanticProposalRevision({ kind: "query", parent_request: parent,
    previous_response: "{}", response_completion: "truncated" })).toThrow(/complete physical response/u);
  expect(() => prepareSourceSemanticProposalRevision({ kind: "query", parent_request: parent,
    previous_response: "{}", response_completion: "complete", review_comments: ["Choose Parquet"] }))
    .toThrow(/query revision cannot receive source/u);
  expect(() => prepareSourceSemanticProposalRevision({ kind: "query", parent_request: child,
    previous_response: "{}", response_completion: "complete" })).toThrow(/original request/u);
});
