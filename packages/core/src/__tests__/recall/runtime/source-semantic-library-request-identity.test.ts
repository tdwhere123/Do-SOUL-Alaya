import { expect, it } from "vitest";
import { sourceSemanticLibraryRequestIdentity } from "../../../recall/runtime/source-semantic-library-recall.js";
import { admitSourceSemanticQuery, sourceSemanticQueryStatus } from "../../../recall/conditional-field/query/source-semantic-query-admission.js";
import { BUDGET, CLOCK, ORIGINAL, correspondenceFor, query, source } from "./source-semantic-proof-fixture.js";

type Request = Parameters<typeof sourceSemanticLibraryRequestIdentity>[0];
const semantics = query();
const request: Request = {
  workspace_id: "workspace", as_of: CLOCK, authorized_scopes: ["project", "global_core"],
  original_query: ORIGINAL, query_semantics: semantics,
  query_semantics_status: sourceSemanticQueryStatus(admitSourceSemanticQuery(semantics, ORIGINAL)),
  semantic_correspondences: [correspondenceFor(source(), semantics)],
  budget: BUDGET, output_byte_limit: 1_000_000, access_policy: "query-conditioned-v1"
};

it("binds every resolved request dimension including unused correspondence inputs", () => {
  const identity = sourceSemanticLibraryRequestIdentity(request);
  const changes: readonly Partial<Request>[] = [
    { workspace_id: "another-workspace" },
    { as_of: "2026-09-19T00:00:00.000Z" },
    { authorized_scopes: null },
    { authorized_scopes: ["project"] },
    { original_query: "which tools does Bob use?" },
    { source_id: "restricted-source" },
    { query_semantics: { ...semantics, return_variables: ["actor"] } },
    { query_semantics: undefined, query_semantics_status: { status: "unavailable", reason: "absent" } },
    { query_semantics: undefined, query_semantics_status: { status: "unavailable", reason: "invalid" } },
    { semantic_correspondences: [] },
    { semantic_correspondences: [...request.semantic_correspondences, request.semantic_correspondences[0]!] },
    { budget: { ...BUDGET, work_units: BUDGET.work_units - 1 } },
    { output_byte_limit: 500_000 },
    { access_policy: "canonical-v1" }
  ];
  for (const change of changes) {
    expect(sourceSemanticLibraryRequestIdentity({ ...request, ...change }), Object.keys(change).join(","))
      .not.toBe(identity);
  }
});

it("normalizes scope order while keeping unrestricted and empty admissions distinct", () => {
  expect(sourceSemanticLibraryRequestIdentity({ ...request, authorized_scopes: ["global_core", "project"] }))
    .toBe(sourceSemanticLibraryRequestIdentity(request));
  expect(sourceSemanticLibraryRequestIdentity({ ...request, source_id: undefined }))
    .toBe(sourceSemanticLibraryRequestIdentity(request));
  expect(sourceSemanticLibraryRequestIdentity({ ...request, authorized_scopes: [] }))
    .not.toBe(sourceSemanticLibraryRequestIdentity({ ...request, authorized_scopes: null }));
});
