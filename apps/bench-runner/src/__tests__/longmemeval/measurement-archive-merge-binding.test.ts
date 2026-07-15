import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeMergedLongMemEvalArchive } from "../../cli/merge-command-archive.js";
import {
  buildMergedLongMemEvalPayload,
  loadMergeShards
} from "../../cli/merge-command-shards.js";
import { LongMemEvalDiagnosticsSpool } from "../../longmemeval/diagnostics/spool.js";
import { LongMemEvalQuestionDiagnosticSchema } from "../../longmemeval/diagnostics-schema.js";
import type { LongMemEvalQuestionDiagnostic } from "../../longmemeval/diagnostics.js";
import { withCurrentMeasurementAttribution } from "../../longmemeval/measurement/archive-attribution.js";
import { makeShardKpi } from "../cli/cli-merge-validations-fixture.js";
import {
  cohort,
  setupShard,
  streamedQuestion
} from "../cli/cli-merge-evidence-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("archive and merge measurement status binding", () => {
  it("rejects forged persisted status at the diagnostic schema seam", () => {
    const base = streamedQuestion("q-schema");
    expect(() => LongMemEvalQuestionDiagnosticSchema.parse({
      ...base,
      cohort_ledger: {
        ...cohort(),
        measurement_status: "evaluator_identity_unscorable"
      }
    })).toThrow(/measurement status.*primitive axes/u);
  });

  it("rejects forged persisted status at the single-run archive seam", () => {
    const diagnostic = forgedDiagnostic("q-archive");
    const base = makeShardKpi();
    const payload = {
      ...base,
      kpi: {
        ...base.kpi,
        per_scenario: [{
          id: "q-archive", version: 1, hit_at_5: true, scorable: true,
          measurement_cohort: "answerable" as const, tier: "warm" as const
        }]
      }
    };

    expect(() => withCurrentMeasurementAttribution({
      payload,
      failedQuestionIds: [],
      diagnostics: [diagnostic],
      provenanceContents: "{}"
    })).toThrow(/persisted measurement status/u);
  });

  it("rejects forged persisted status at the merged archive seam", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-status-binding-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await setupShard(shard, "q-merge", 0);
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      const loaded = await loadMergeShards([shard], spool);
      const build = buildMergedLongMemEvalPayload(loaded);
      const diagnostic = loaded.archiveRefs[0]!.diagnostics.questions[0]!;
      Object.assign(diagnostic.cohort_ledger!, {
        measurement_status: "evaluator_identity_unscorable"
      });
      const payload = {
        ...build.payload,
        answerable_evaluated_count: 1,
        kpi: {
          ...build.payload.kpi,
          per_scenario: build.payload.kpi.per_scenario.map((row) => ({
            ...row,
            scorable: true,
            measurement_cohort: "answerable" as const
          }))
        }
      };
      await expect(writeMergedLongMemEvalArchive({
        historyRoot: path.join(root, "history"),
        build: { ...build, payload },
        shardArchiveRefs: loaded.archiveRefs,
        diagnosticsSpool: spool
      })).rejects.toThrow(/persisted measurement status/u);
    } finally {
      await spool.dispose();
    }
  });
});

function forgedDiagnostic(id: string): LongMemEvalQuestionDiagnostic {
  const diagnostic = streamedQuestion(id);
  return {
    ...diagnostic,
    cohort_ledger: {
      ...cohort(),
      measurement_status: "evaluator_identity_unscorable" as const
    }
  };
}
