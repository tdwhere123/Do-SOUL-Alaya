import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEntry, type HistoryLayout } from "@do-soul/alaya-eval";
import { afterEach, describe, expect, it } from "vitest";
import { makeShardKpi } from "../cli/cli-merge-validations-fixture.js";
import {
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  readLatestLongMemEvalOppositeArchive
} from "../../longmemeval/archive-evidence.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("archive evidence summary reads", () => {
  it("does not materialize the previous run's full diagnostics artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "lme-evidence-summary-"));
    roots.push(root);
    const layout: HistoryLayout = { historyRoot: root };
    const invalidFullArtifact = join(root, "must-not-be-read.json");
    await writeFile(invalidFullArtifact, "not json", "utf8");
    const previous = makeShardKpi({ evaluated_count: 1, sample_size: 1 });
    const previousSlug = "2026-05-14T100000Z-abc1234";
    await writeEntry(layout, "public", previousSlug, previous, "# report\n", null, {
      sidecars: [{
        filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
        contents: `${JSON.stringify({
          schema_version: 1,
          compact_schema_version: 1,
          full_diagnostics_artifact_path: invalidFullArtifact,
          report_side_effects: null,
          scored_recall_evidence: null
        })}\n`
      }]
    });

    await expect(readLatestLongMemEvalOppositeArchive({
      layout,
      current: makeShardKpi({ simulate_report: "mixed" })
    })).resolves.toMatchObject({ slug: previousSlug });
  });
});
