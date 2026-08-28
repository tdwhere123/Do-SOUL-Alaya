// @ts-nocheck
import { beforeEach, expect, it, vi } from "vitest";
import { buildFullLongMemEvalPayload } from
  "../../../../../../packages/eval/src/__tests__/history/history-fixture.js";
import type { ParsedFlags } from "../../../cli/cli-options.js";

const mocks = vi.hoisted(() => ({
  runRecallEval: vi.fn()
}));

vi.mock("../../../bench/lifecycle/recall-eval/recall-eval-impl.js", () => ({
  runRecallEval: mocks.runRecallEval
}));

import { runRecallEvalCommand } from "../../../cli/recall-eval/command.js";

beforeEach(() => {
  mocks.runRecallEval.mockReset();
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});

it("returns non-zero when release hard gates fail without a baseline", async () => {
  const payload = buildFullLongMemEvalPayload("public", "abc1234", 0.5);
  payload.diff_vs_previous = null;
  mocks.runRecallEval.mockResolvedValue(result(payload));

  await expect(runRecallEvalCommand(flags())).resolves.toBe(1);
});

it("returns non-zero when seed extraction release evidence is missing", async () => {
  const payload = buildFullLongMemEvalPayload("public", "abc1234", 0.95);
  payload.kpi.seed_extraction_path = undefined;
  payload.diff_vs_previous = null;
  mocks.runRecallEval.mockResolvedValue(result(payload));

  await expect(runRecallEvalCommand(flags())).resolves.toBe(1);
});

it("does not require tier-one evidence for a clean recall-eval fast loop", async () => {
  const payload = buildFullLongMemEvalPayload("public", "abc1234", 0.95);
  payload.diff_vs_previous = null;
  mocks.runRecallEval.mockResolvedValue(result(payload));

  await expect(runRecallEvalCommand(flags())).resolves.toBe(0);
});

it("reports bounded post-commit and memory-profile completion failures", async () => {
  const payload = buildFullLongMemEvalPayload("public", "abc1234", 0.95);
  payload.diff_vs_previous = null;
  mocks.runRecallEval.mockResolvedValue({
    ...result(payload),
    completion: incomplete("diagnostics_spool_cleanup", "EIO"),
    memoryProfile: incomplete("profile_close", "ENOSPC")
  });

  await expect(runRecallEvalCommand(flags())).resolves.toBe(2);
  const output = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(output).toContain(
    "completion status=incomplete failures=phase=diagnostics_spool_cleanup name=Error code=EIO"
  );
  expect(output).toContain(
    "memory-profile status=incomplete failures=phase=profile_close name=Error code=ENOSPC"
  );
});

it("requires projection rebuild for default fact-frame backfill", async () => {
  await expect(runRecallEvalCommand({
    ...flags(),
    experiment: true,
    backfillMissingFactFrameFormations: true
  })).resolves.toBe(2);

  expect(mocks.runRecallEval).not.toHaveBeenCalled();
});

it("rejects mixing default backfill with the sealed retrofit ledger", async () => {
  await expect(runRecallEvalCommand({
    ...flags(),
    experiment: true,
    rebuildEvidenceSearchProjections: true,
    backfillMissingFactFrameFormations: true,
    factFrameRetrofitLedger: "/tmp/frames.ndjson"
  })).resolves.toBe(2);

  expect(mocks.runRecallEval).not.toHaveBeenCalled();
});

function result(payload: ReturnType<typeof buildFullLongMemEvalPayload>) {
  return {
    slug: "fixture",
    kpiPath: "/tmp/kpi.json",
    reportPath: "/tmp/report.md",
    findingsPath: "/tmp/findings.md",
    payload,
    snapshotManifest: {},
    perQuestionDelivered: [],
    completion: { status: "complete", failures: [] },
    memoryProfile: { status: "disabled", failures: [] }
  };
}

function incomplete(phase: string, code: string) {
  return { status: "incomplete", failures: [{ phase, name: "Error", code }] };
}

function flags(): ParsedFlags {
  return {
    variant: "longmemeval_s",
    historyRoot: "/tmp/history",
    embeddingMode: "disabled",
    embeddingProviderKind: "openai",
    policyShape: "stress",
    simulateReport: "none",
    force: false,
    snapshot: "/tmp/snapshot.db",
    qa: false,
    edgePlane: false
  };
}
