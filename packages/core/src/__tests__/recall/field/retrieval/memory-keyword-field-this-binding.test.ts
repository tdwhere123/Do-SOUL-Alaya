import { compareCodeUnits } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import type { RecallFieldDigest } from "../../../../recall/field/field-identity.js";
import type { RecordedFieldResult } from
  "../../../../recall/field/retrieval/retrieval-field-bundle.js";
import { createRecallRetrievalFieldBundle } from
  "../../../../recall/field/retrieval/retrieval-field-bundle.js";
import { materializeRetrievalFieldBundleCaptures } from
  "../../../../recall/field/retrieval/retrieval-field-captures.js";
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

describe("retrieval field capture request_digest order", () => {
  it("canonicalizes a lawful Unicode request_digest pair to code-unit order", () => {
    const composed = "sha256:\u00e9" as RecallFieldDigest;
    const decomposed = "sha256:e\u0301" as RecallFieldDigest;
    expect(composed).not.toBe(decomposed);
    expect(composed.localeCompare(decomposed)).toBe(0);
    expect(compareCodeUnits(decomposed, composed)).toBeLessThan(0);
    const expected = [
      "workspace_local:memory_entry:decomposed",
      "workspace_local:memory_entry:composed"
    ];
    expect(exactCandidateKeys([
      { request_digest: composed, object_id: "composed" },
      { request_digest: decomposed, object_id: "decomposed" }
    ])).toEqual(expected);
    expect(exactCandidateKeys([
      { request_digest: decomposed, object_id: "decomposed" },
      { request_digest: composed, object_id: "composed" }
    ])).toEqual(expected);
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

function exactCandidateKeys(
  records: readonly Readonly<{
    readonly request_digest: RecallFieldDigest;
    readonly object_id: string;
  }>[]
): readonly string[] {
  const captures = materializeRetrievalFieldBundleCaptures(
    {
      workspaceId: "workspace-1",
      queryText: "stable",
      memoryRepo: new HostMemoryRepo()
    },
    records.map((record) => unicodeLaneRecord(record))
  );
  return captures.find((capture) => capture.channel.channel_id === "lexical_relaxed_exact")
    ?.channel.observations.map((observation) => observation.candidate_key) ?? [];
}

function unicodeLaneRecord(input: Readonly<{
  readonly request_digest: RecallFieldDigest;
  readonly object_id: string;
}>): RecordedFieldResult {
  const observation = Object.freeze({
    object_id: input.object_id, rank: 1, normalized_rank: 1
  });
  return Object.freeze({
    request_digest: input.request_digest,
    prefix: "lexical_relaxed",
    source: "memory",
    object_kind: "memory_entry",
    requested_depth: 1,
    result: Object.freeze({
      matches: Object.freeze([observation]),
      lanes: Object.freeze([Object.freeze({
        lane: "exact" as const,
        status: "complete" as const,
        depth: 1,
        observations: Object.freeze([observation]),
        unseen_upper_bound: 0
      })])
    })
  });
}
