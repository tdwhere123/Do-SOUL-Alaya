import { describe, expect, it } from "vitest";
import { createRecallRetrievalFieldBundle } from
  "../../../../recall/field/retrieval/retrieval-field-bundle.js";
import type { RecallServiceMemoryRepoPort } from
  "../../../../recall/runtime/recall-service-ports.js";
import {
  fieldResult,
  truncatedReceipt
} from "../../runtime/diagnostics/lexical-bound-proof-fixture.js";

describe("memory keyword field this binding", () => {
  it("keeps class-repo this on capture, refinement, and bare invoke paths", async () => {
    await expectBoundSearch({ captureProof: true, refinementMaxDepth: 8 });
    await expectBoundSearch({ refinementMaxDepth: 8 });
    await expectBoundSearch({});
  });
});

async function expectBoundSearch(source: Readonly<{
  readonly captureProof?: true;
  readonly refinementMaxDepth?: number;
}>): Promise<void> {
  const repo = new HostMemoryRepo();
  const bundle = createRecallRetrievalFieldBundle({
    workspaceId: "workspace-1",
    queryText: "stable",
    memoryRepo: repo,
    ...source
  });
  await bundle.searchMemoryKeyword({
    variant: "lexical_relaxed",
    queryText: "stable",
    limit: 2,
    scope: {}
  });
  expect(repo.bound).toBe(true);
}

class HostMemoryRepo implements Pick<
  RecallServiceMemoryRepoPort,
  "findByWorkspaceId" | "findByDimension" | "findByScopeClass" | "searchByKeywordField"
> {
  public bound = false;

  public async findByWorkspaceId(): Promise<readonly never[]> {
    return [];
  }

  public async findByDimension(): Promise<readonly never[]> {
    return [];
  }

  public async findByScopeClass(): Promise<readonly never[]> {
    return [];
  }

  public async searchByKeywordField(): Promise<ReturnType<typeof fieldResult>> {
    this.bound = true;
    return fieldResult(truncatedReceipt());
  }
}
