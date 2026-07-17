import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readShardPayload } from "../../../cli/merge/shard/shard-diagnostics-reader.js";
import { LongMemEvalDiagnosticsSpool } from "../../../longmemeval/diagnostics/spool.js";
import {
  makeShardDiagnostics,
  makeShardKpi,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";

describe("shard merge question identity", () => {
  let root: string;
  let spool: LongMemEvalDiagnosticsSpool;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "merge-question-identity-"));
    spool = await LongMemEvalDiagnosticsSpool.create();
  });

  afterEach(async () => {
    await spool.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("rejects equal question IDs in a different order", async () => {
    await writeShard(["q-a", "q-b"], ["q-b", "q-a"]);

    await expect(readShardPayload(root, spool)).rejects.toThrow(
      "shard question identity mismatch at index=0: kpi='q-a' diagnostics='q-b'"
    );
  });

  it("rejects different question IDs with the same count", async () => {
    await writeShard(["q-a", "q-b"], ["q-a", "q-c"]);

    await expect(readShardPayload(root, spool)).rejects.toThrow(
      "shard question identity mismatch at index=1: kpi='q-b' diagnostics='q-c'"
    );
  });

  it("accepts exactly matching question identity and order", async () => {
    await writeShard(["q-a", "q-b"], ["q-a", "q-b"]);

    const result = await readShardPayload(root, spool);

    expect(result.payload.kpi.per_scenario.map((row) => row.id)).toEqual(["q-a", "q-b"]);
    expect(result.questionDiagnostics.map((row) => row.question_id)).toEqual(["q-a", "q-b"]);
  });

  async function writeShard(kpiIds: readonly string[], diagnosticsIds: readonly string[]) {
    const base = makeShardKpi();
    await writeShardRoot(
      root,
      makeShardKpi({
        evaluated_count: kpiIds.length,
        kpi: {
          ...base.kpi,
          per_scenario: kpiIds.map((id) => ({
            id,
            version: 1,
            hit_at_5: true,
            tier: "warm" as const
          }))
        }
      }),
      makeShardDiagnostics({
        questions: diagnosticsIds.map((question_id) => ({ question_id, candidates: [] }))
      })
    );
  }
});
