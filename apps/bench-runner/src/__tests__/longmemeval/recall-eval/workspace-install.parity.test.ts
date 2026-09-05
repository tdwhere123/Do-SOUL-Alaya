import { describe, expect, it } from "vitest";
import { P00_PERFORMANCE_PROOF_CONTRACT } from
  "../../../runs/lifecycle/recall-eval/performance-proof/attribution-receipt.js";
import { compareExactParity } from
  "../../../runs/lifecycle/recall-eval/performance-proof/exact-parity.js";
import {
  hasResourceLeak,
  runProviderFreePerformanceProof
} from "../../../runs/lifecycle/recall-eval/performance-proof/provider-free-run.js";
import {
  CLOCK_A_REASON,
  P02_WORKSPACE_INSTALL_CONTRACT
} from "../../../runs/lifecycle/recall-eval/workspace-install/install.js";
import { measureProviderFreeWorkspaceInstallBothModes } from
  "../../../runs/lifecycle/recall-eval/workspace-install/provider-free.js";

describe("A4 workspace-install composed provider-free exact parity", () => {
  it("keeps P00 control result bytes before any disk or wall claim", async () => {
    expect(P02_WORKSPACE_INSTALL_CONTRACT.cites).toBe(P00_PERFORMANCE_PROOF_CONTRACT.name);

    const left = await runProviderFreePerformanceProof();
    const right = await runProviderFreePerformanceProof();
    const comparison = compareExactParity(left.receipt, right.receipt);
    const measured = await measureProviderFreeWorkspaceInstallBothModes();

    expect(comparison.identityBound).toBe(true);
    expect(comparison.resultEquivalent).toBe(true);
    expect(comparison.byteCountEquivalent).toBe(true);
    expect(comparison.diagnosticTimersExcluded).toBe(true);
    expect(left.receipt.result.deliveredObjectIds).toEqual(["mem-a", "mem-b"]);
    expect(left.receipt.result.providerCalls).toEqual([]);
    expect(left.receipt.result.cacheCalls).toEqual([]);
    expect(measured.reflink.sourceDigestBefore).toBe(left.receipt.result.sourceDigestBefore);
    expect(measured.reflink.sourceDigestAfter).toBe(left.receipt.result.sourceDigestAfter);
    expect(measured.copyFallback.overlayDigestBefore).toBe(left.receipt.result.overlayDigestBefore);
    expect(measured.copyFallback.overlayDigestAfter).toBe(left.receipt.result.overlayDigestAfter);
    expect(measured.reflink.io.clockAMs).toEqual({
      status: "not_observed",
      reason: CLOCK_A_REASON
    });
    expect(hasResourceLeak(left.leaks)).toBe(false);
    expect(hasResourceLeak(right.leaks)).toBe(false);
    expect(hasResourceLeak(measured.reflink.leaks)).toBe(false);
    expect(hasResourceLeak(measured.copyFallback.leaks)).toBe(false);
    expect(measured.decision.status).toBe("NO_OPTIMIZATION_JUSTIFIED");
  });
});
