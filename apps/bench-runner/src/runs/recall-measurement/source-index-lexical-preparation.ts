import { join } from "node:path";
import { AlayaError, captureSourceIndexLexicalPreparationAllocation,
  type SourceIndexLexicalPreparationAllocation, type SourceIndexLexicalRepresentation } from "@do-soul/alaya-protocol";
import type { BenchDaemonHandle } from "../../harness/daemon.js";
import { refuseBenchWorkAfterCancel } from "../../harness/daemon-task.js";
import { writeChainArtifact } from "./contract.js";
import type { SourceIndexLexicalProducerPassReceipt } from
  "../../../../core-daemon/src/runtime/source-index/source-index-producer.js";

export type SourceIndexLexicalPreparationReport = {
  requested_allocation: SourceIndexLexicalPreparationAllocation | null;
  stop_reason: string;
  passes: { pass: number; receipt: SourceIndexLexicalProducerPassReceipt; effective_work: number | null }[];
};

/** Model-free phase on the same idle daemon/producer after vector setup. */
export async function runSourceIndexLexicalPreparation(input: {
  live: { runtime: Pick<BenchDaemonHandle["runtime"], "runSourceIndexLexicalPass"> };
  workspace: string; representation: SourceIndexLexicalRepresentation;
  maxPasses: number; expired: () => boolean; root: string; allocation?: SourceIndexLexicalPreparationAllocation;
}): Promise<SourceIndexLexicalPreparationReport> {
  const { live, workspace, representation, maxPasses, expired, root } = input;
  const allocation = input.allocation === undefined ? undefined : captureSourceIndexLexicalPreparationAllocation(input.allocation);
  const run = live.runtime.runSourceIndexLexicalPass;
  if (run === undefined) throw new AlayaError("UNAVAILABLE", "Source lexical preparation is unwired");
  const report: SourceIndexLexicalPreparationReport = {
    requested_allocation: allocation ?? null, passes: [], stop_reason: "setup_pass_exhausted"
  };
  const finish = (reason: string) => { report.stop_reason = reason; return report; };
  let last: string | undefined;
  try {
    for (let pass = 0; pass < maxPasses; pass++) {
      if (expired()) return finish("setup_soft_deadline");
      const receipt = structuredClone(await run(workspace, representation, undefined, allocation));
      const observed = receipt.preparation_allocation;
      const entry = { pass: pass + 1, receipt, effective_work: observed?.effective_work ?? null };
      report.passes.push(entry);
      // Retain every actual lexical receipt before cancellation or another pass.
      writeChainArtifact(join(root, "lexical-passes", `pass-${pass + 1}.json`), entry);
      refuseBenchWorkAfterCancel();
      if (allocation !== undefined && (observed?.requested_work !== allocation.work ||
          observed.effective_work !== allocation.work || receipt.resources.work > observed.effective_work)) {
        return finish("lexical_allocation_receipt_mismatch");
      }
      if (receipt.status === "ready") return finish("ready");
      const continuable = receipt.status === "partial" && receipt.generation !== null &&
        (receipt.reason === "incomplete" || receipt.reason === "read_budget" || receipt.reason === "deadline_exceeded");
      if (!continuable) return finish(`lexical_${receipt.status}:${receipt.reason ?? "none"}`);
      const g = receipt.generation!, progress = `${g.completed_count}/${g.target_count}/${g.enumeration_complete}`;
      if (progress === last) return finish("lexical_no_progress");
      last = progress;
    }
    return report;
  } catch (error) {
    writeChainArtifact(join(root, "lexical-failure-prefix.json"), { ...report, stop_reason: "threw",
      failure: error instanceof Error ? { name: error.name, message: error.message } : String(error) });
    throw error;
  }
}
