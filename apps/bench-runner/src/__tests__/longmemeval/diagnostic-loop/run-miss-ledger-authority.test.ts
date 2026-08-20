import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointDigest } from "../../../bench/diagnostic-loop/checkpoint.js";
import { sha256File } from "../../../bench/snapshot/integrity.js";
import { diagnosticAuthorityDigest } from
  "../../../bench/diagnostic-loop/authority/identity.js";
import { sealTreatmentExposureReceipt } from
  "../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import { digestRecallFieldIdentity } from "@do-soul/alaya-core";
import { notObservedPhaseLedger } from "../diagnostics/phase/not-observed-ledger.js";
import { createLoopTemp } from "./run-loop-fixture.js";

const { cleanupLoopTemps, completedRun, resume } = createLoopTemp("diagnostic-loop-miss-");

afterEach(async () => {
  await cleanupLoopTemps();
});

describe("diagnostic-loop miss-ledger authority", () => {
  it("rejects a fully re-signed miss ledger that is not derived from arm diagnostics", async () => {
    const workRoot = await completedRun();
    const missPath = join(workRoot, "miss-ledger.json");
    const comparison = JSON.parse(await readFile(missPath, "utf8")) as Record<string, unknown>;
    const receipt = forgedExposureReceipt();
    const gate = {
      schema_version: 1, kind: "cached_f3_exposed_denominator_gate",
      declared_minimum_rate: 1, evaluated_count: 1, exposed_count: 1,
      actual_rate: 1, passed: true
    };
    await writeFile(missPath, `${JSON.stringify({
      ...comparison,
      treatment_exposure_receipts: [receipt],
      causal_comparison_status: "eligible",
      exposed_denominator_gate: gate
    })}\n`);
    await resealCheckpoint(workRoot, "miss_ledger", (body) => ({
      ...body,
      details: { ...(body.details as object), artifact_sha256: awaitSha(missPath),
        exposed_denominator_gate: gate }
    }));
    await resealReportAuthority(workRoot, gate);
    await expect(resume(workRoot)).rejects.toThrow(/miss-ledger source authority mismatch/iu);
  });
});

function forgedExposureReceipt() {
  const activationBody = {
    schema_version: 1 as const, operator_id: "open_semantic_factor_candidate_activation_v1" as const,
    state: "observed" as const, score: 1, evidence_ids: ["e1"], solution_count: 1,
    proposition_match_count: 1
  };
  return sealTreatmentExposureReceipt({
    schema_version: 4, kind: "cached_f3_treatment_exposure", question_id: "forged",
    evidence_chain: { linked: true },
    control_non_exposure: { observed: true, formation_status: null, compatible_count: 0,
      composition_status: null, activation_status: null, activated_evidence_count: 0,
      candidate_attribution_count: 0, pure: true },
    formation: { status: "formed" }, compatible_evidence: { compatible_count: 1 },
    composition: { status: "composed", solution_count: 1, binding_count: 0 },
    activation: { status: "composed", activated_evidence_count: 1 },
    candidate_attribution: { entries: [{ candidate_key: "candidate:f3", receipt: {
      ...activationBody, receipt_digest: digestRecallFieldIdentity(activationBody)
    } }], candidate_keys: ["candidate:f3"], activated_evidence_ids: ["e1"] },
    membership_delta: { observed: true, changed: false, added_candidate_keys: [], removed_candidate_keys: [] },
    candidate_pool: { control_complete: true, treatment_complete: true },
    query_probe_delta: { observed: false, changed: false, added_expanded_terms: [], removed_expanded_terms: [] },
    retrieval_channel_delta: { observed: false, changed: false, changed_channels: [] },
    outcome: { control: { stage: "S5", hit_at_5: true }, treatment: { stage: "S5", hit_at_5: true } },
    product_phase_ledger: notObservedPhaseLedger(),
    exposure_status: "exposed"
  });
}

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
    changed.details = { ...(changed.details as object), artifact_sha256: await sha256File(pendingSha) };
  }
  const sealed = { ...changed, checkpoint_digest: checkpointDigest(changed as never) };
  await writeFile(path, `${JSON.stringify(sealed, null, 2)}\n`);
  return sealed;
}

async function resealReportAuthority(workRoot: string, gate: object) {
  const reportPath = join(workRoot, "report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
  const changed = { ...report,
    miss_ledger: { ...(report.miss_ledger as object), exposed_denominator_gate: gate },
    diagnostic_100q_promotion: { eligible: true, reason: "exposed_denominator_gate_passed" }
  };
  await writeFile(reportPath, `${JSON.stringify(changed, null, 2)}\n`);
  await resealCheckpoint(workRoot, "report", (body) => ({
    ...body, content_identity: diagnosticAuthorityDigest(changed)
  }));
}
