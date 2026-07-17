import { describe, expect, it } from "vitest";
import { canonicalizeVerifiedShards } from "../../cli/merge/shard/shard-ordering.js";
import type { VerifiedShardEvidence } from
  "../../cli/merge/shard/shard-evidence-verifier.js";

describe("canonical verified shard ordering", () => {
  it("rejects an implicit limit even for a single verified shard", () => {
    const verifiedEvidence = {
      execution: {
        protocol: "sequential",
        concurrency: 1,
        offset: 0,
        limit: null,
        evaluated_count: 1
      }
    } as VerifiedShardEvidence;

    expect(() => canonicalizeVerifiedShards([{ verifiedEvidence }])).toThrow(
      /verified sharded executions require explicit limits/u
    );
  });
});
