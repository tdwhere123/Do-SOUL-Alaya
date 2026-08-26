import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointDigest } from "../../../bench/diagnostic-loop/checkpoint.js";
import { sha256File } from "../../../bench/snapshot/integrity.js";
import { diagnosticAuthorityDigest } from
  "../../../bench/diagnostic-loop/authority/identity.js";
import { compareF0F2VsCachedF3 } from
  "../../../bench/diagnostics/stage-attribution/diagnostic-100q.js";
import { row } from "../diagnostics/phase/exposure-receipt-fixture.js";
import { createLoopTemp } from "./run-loop-fixture.js";
import { forgedExposureReceipt } from "./forged-exposure-receipt.js";

const { cleanupLoopTemps, completedRun, resume } = createLoopTemp("diagnostic-loop-miss-");

afterEach(async () => {
  await cleanupLoopTemps();
});

describe("diagnostic-loop miss-ledger authority", () => {
  it("rejects a fully re-signed miss ledger that is not derived from arm diagnostics", async () => {
    const workRoot = await completedRun();
    const missPath = join(workRoot, "miss-ledger.json");
    const forged = compareF0F2VsCachedF3({
      control: [row({ question_id: "forged", stage: "delivered_top5", hit_at_5: true, proof: "hit_at_5" })],
      treatment: [row({ question_id: "forged", stage: "delivered_top5", hit_at_5: true, proof: "hit_at_5" })],
      treatmentExposure: [forgedExposureReceipt()]
    });
    await writeFile(missPath, `${JSON.stringify(forged)}\n`);
    await resealCheckpoint(workRoot, "miss_ledger", (body) => ({
      ...body,
      details: {
        ...(body.details as object),
        artifact_sha256: awaitSha(missPath),
        exposure_sli: forged.exposure_sli,
        canary_polarity_matrix: forged.canary_polarity_matrix,
        diagnostic_100q_unlock: forged.diagnostic_100q_unlock
      }
    }));
    await resealReportAuthority(workRoot, forged);
    await expect(resume(workRoot)).rejects.toThrow(/miss-ledger source authority mismatch/iu);
  });
});

let pendingSha = "";
function awaitSha(path: string): string {
  pendingSha = path;
  return pendingSha;
}

async function resealCheckpoint(
  workRoot: string,
  phase: string,
  mutate: (body: Record<string, unknown>) => Record<string, unknown>
) {
  const path = join(workRoot, "checkpoints", `${phase}.json`);
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const { checkpoint_digest: _digest, ...unsigned } = value;
  const changed = mutate(unsigned);
  if (phase === "miss_ledger") {
    changed.details = {
      ...(changed.details as object),
      artifact_sha256: await sha256File(pendingSha)
    };
  }
  const sealed = { ...changed, checkpoint_digest: checkpointDigest(changed as never) };
  await writeFile(path, `${JSON.stringify(sealed, null, 2)}\n`);
  return sealed;
}

async function resealReportAuthority(
  workRoot: string,
  forged: ReturnType<typeof compareF0F2VsCachedF3>
) {
  const reportPath = join(workRoot, "report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
  const changed = {
    ...report,
    miss_ledger: {
      ...(report.miss_ledger as object),
      exposure_sli: forged.exposure_sli,
      canary_polarity_matrix: forged.canary_polarity_matrix,
      diagnostic_100q_unlock: forged.diagnostic_100q_unlock
    },
    diagnostic_100q_unlock: forged.diagnostic_100q_unlock,
    diagnostic_100q_promotion: { eligible: false, reason: "not_a_kpi_promotion_gate" }
  };
  await writeFile(reportPath, `${JSON.stringify(changed, null, 2)}\n`);
  await resealCheckpoint(workRoot, "report", (body) => ({
    ...body, content_identity: diagnosticAuthorityDigest(changed)
  }));
}
