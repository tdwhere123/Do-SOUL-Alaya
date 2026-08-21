import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointDigest, loadCompletedCheckpoints, readCheckpoint } from
  "../../../bench/diagnostic-loop/checkpoint.js";
import { assertCheckpointAuthorities } from
  "../../../bench/diagnostic-loop/authority/checkpoint.js";
import { readRunRecord, runRecordPath } from
  "../../../bench/diagnostic-loop/run-state.js";
import { loopRequest } from "./fixture.js";
import { createLoopTemp } from "./run-loop-fixture.js";

const { cleanupLoopTemps, completedRun, resume } = createLoopTemp("diagnostic-loop-schema-");

afterEach(async () => {
  await cleanupLoopTemps();
});

describe("diagnostic-loop unlock/promotion schema authority", () => {
  it("rejects a historical v2 checkpoint as archive-only", async () => {
    const workRoot = await completedRun();
    const path = join(workRoot, "checkpoints", "preflight.json");
    await writeFile(path, `${JSON.stringify({
      schema_version: 2,
      kind: "diagnostic_loop_checkpoint"
    })}\n`);
    expect(() => readCheckpoint(path)).toThrow(
      /historical diagnostic-loop checkpoint cannot be reinterpreted as current gate authority/u
    );
  });

  it("rejects a historical v3 report as archive-only, not a generic promotion mismatch", async () => {
    const workRoot = await completedRun();
    const reportPath = join(workRoot, "report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    await writeFile(reportPath, `${JSON.stringify({ ...report, schema_version: 3 })}\n`);
    await resealReportCheckpoint(workRoot, reportPath);
    await expect(resume(workRoot)).rejects.toThrow(
      /historical diagnostic-loop report cannot be reinterpreted as current gate authority/u
    );
  });

  it("fail-closes report authority when miss-ledger comparison is absent", async () => {
    const workRoot = await completedRun();
    const record = readRunRecord(runRecordPath(workRoot));
    const checkpoints = loadCompletedCheckpoints(workRoot, record.run_record_digest);
    checkpoints.delete("miss_ledger");
    await expect(assertCheckpointAuthorities(
      loopRequest(),
      record.identity,
      checkpoints
    )).rejects.toThrow(/report unlock\/promotion authority is incomplete/u);
  });

  it("fail-closes a current report that omits miss_ledger", async () => {
    const workRoot = await completedRun();
    const reportPath = join(workRoot, "report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    const { miss_ledger: _omitted, ...withoutLedger } = report;
    await writeFile(reportPath, `${JSON.stringify(withoutLedger)}\n`);
    await resealReportCheckpoint(workRoot, reportPath);
    await expect(resume(workRoot)).rejects.toThrow(
      /report unlock\/promotion authority mismatch/u
    );
  });

  it("names unlock/promotion authority when a current report unbinds the matrix", async () => {
    const workRoot = await completedRun();
    const reportPath = join(workRoot, "report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    await writeFile(reportPath, `${JSON.stringify({
      ...report,
      diagnostic_100q_unlock: {
        schema_version: 1,
        kind: "diagnostic_100q_unlock",
        eligible: true,
        reason: "gate7_polarity_matrix_passed",
        binds: { polarity_matrix_passed: true, physical_calls: 0 }
      }
    })}\n`);
    await resealReportCheckpoint(workRoot, reportPath);
    await expect(resume(workRoot)).rejects.toThrow(
      /report unlock\/promotion authority mismatch/u
    );
  });
});

async function resealReportCheckpoint(workRoot: string, reportPath: string): Promise<void> {
  const { diagnosticAuthorityDigest } = await import(
    "../../../bench/diagnostic-loop/authority/identity.js"
  );
  const path = join(workRoot, "checkpoints", "report.json");
  const current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const { checkpoint_digest: _digest, ...body } = current;
  const next = {
    ...body,
    content_identity: diagnosticAuthorityDigest(
      JSON.parse(await readFile(reportPath, "utf8"))
    )
  };
  await writeFile(path, `${JSON.stringify({
    ...next,
    checkpoint_digest: checkpointDigest(next as never)
  }, null, 2)}\n`);
}
