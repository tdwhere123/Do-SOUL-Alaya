import { afterEach, describe, expect, it } from "vitest";
import {
  assertRecallEvalRecycleRequired,
  executeRecallEvalRun
} from "../../../runs/lifecycle/recall-eval/recall-eval-execute.js";
import type { RecallEvalRunContext } from
  "../../../runs/lifecycle/recall-eval/recall-eval-run-context.js";
import type { RecallEvalDiagnosticsSpool } from
  "../../../runs/provenance/recall-eval/recall-eval-diagnostics-spool.js";

const SKIP_RECYCLE_ENV = "ALAYA_RECALL_EVAL_SKIP_RECYCLE";

describe("recall-eval recycle is mandatory", () => {
  afterEach(() => {
    delete process.env[SKIP_RECYCLE_ENV];
  });

  it("fail-closes when ALAYA_RECALL_EVAL_SKIP_RECYCLE is 1 or true", async () => {
    process.env[SKIP_RECYCLE_ENV] = "1";
    expect(() => assertRecallEvalRecycleRequired()).toThrow(
      /path-switch smoke is NOT_VERIFIED; recycle remains required/
    );
    await expect(executeRecallEvalRun(
      { options: {} } as RecallEvalRunContext,
      {} as RecallEvalDiagnosticsSpool
    )).rejects.toThrow(/path-switch smoke is NOT_VERIFIED; recycle remains required/);

    process.env[SKIP_RECYCLE_ENV] = "true";
    expect(() => assertRecallEvalRecycleRequired()).toThrow(
      /ALAYA_RECALL_EVAL_SKIP_RECYCLE is not allowed/
    );
  });

  it("fail-closes programmatic skipRecycle and cannot skip recycle", async () => {
    expect(() => assertRecallEvalRecycleRequired({ skipRecycle: true })).toThrow(
      /path-switch smoke is NOT_VERIFIED; recycle remains required/
    );
    await expect(executeRecallEvalRun(
      { options: { skipRecycle: true } } as RecallEvalRunContext,
      {} as RecallEvalDiagnosticsSpool
    )).rejects.toThrow(/recycle remains required/);
    expect(() => assertRecallEvalRecycleRequired()).not.toThrow();
  });
});
