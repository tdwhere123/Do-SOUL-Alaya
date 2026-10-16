import { sourceSemanticAcquisitionNotRun, SourceSemanticResourceLedger, SourceSemanticResourceExhausted, type SourceSemanticAcquisitionPhase,
  type SourceIndexQueryVector, type SourceIndexTarget, type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition, authorizeSemanticScope, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { quoteSemanticSourceObservation } from "./source-semantic-source-observation.js";
import { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";

/** One snapshot-owned pass. The native/scoring quote stays held through census/navigation,
 * until the observation owner starts the next actual canonical source. No refill is permitted.
 */
export function acquireSourceSemanticIndex(input: Readonly<{
  runtime: SourceSemanticReadRuntime; workspace: string; navigation: string; authorized: readonly string[] | null;
  meter: SourceSemanticReadBudget; vector: SourceIndexQueryVector;
  canonicalBytes: number; sourceCost: (length: number) => SourceSemanticResourceBudget;
}>): { phase: SourceSemanticAcquisitionPhase; nominations: readonly SourceIndexTarget[]; releaseCanonical: () => void } {
  const { meter } = input;
  const quote = quoteSemanticSourceObservation(input.sourceCost, Math.min(4096, input.canonicalBytes));
  let release: (() => void) | undefined, handedOff = false;
  let phase = sourceSemanticAcquisitionNotRun("canonical_observation_allowance");
  const finish = (nominations: readonly SourceIndexTarget[] = []) => {
    handedOff = true;
    return { phase, nominations, releaseCanonical: () => release?.() };
  };
  try {
    release = meter.hold(quote);
    // Measurement uses the capture owner. Its traversal is real planning work; the quoted
    // input/result envelope is held capacity, not fictitious acquisition expenditure.
    const navigation = SourceSemanticResourceLedger.measureRetain(input.navigation, meter.remaining(), meter);
    const vectorInput = SourceSemanticResourceLedger.measureRetain(input.vector.status === "available"
      ? input.vector.profile : input.vector.reason, meter.remaining(), meter);
    const budget = meter.remaining(), attempts = Math.min(128, budget.work_units);
    const allowance = { max_attempts: attempts, max_roots: Math.min(16, attempts),
      max_vector_windows: Math.min(4096, budget.work_units) };
    phase = { ...phase, allowance, budget, reason: "acquisition_envelope_allowance" };
    const dimensions = input.vector.status === "available" ? input.vector.profile.dimensions : 0;
    meter.reserve(1 + navigation.work_units + input.navigation.length + vectorInput.work_units +
      (dimensions === 0 ? 0 : 1 + 3 * dimensions),
      2048 + 8 * allowance.max_roots + navigation.memory_bytes + vectorInput.memory_bytes +
      (dimensions === 0 ? 0 : 256 + 4 * dimensions), "source acquisition envelope and input capture");
    if (attempts === 0) return finish();
    const result = new SourceIndexAcquisition(new SqliteSourceIndexRepository(input.runtime.database, fieldContractSha256),
      fieldContractSha256).nominate({ workspace_id: input.workspace, navigation_text: input.navigation,
      vector: input.vector, allowance, budget }, scope => {
        try { authorizeSemanticScope(scope, input.authorized); return "admitted"; }
        catch { return "denied"; }
      });
    meter.absorbIndex(result.resources);
    const failed = result.resource_refusals.some(row => row.phase === "acquisition_failed_unknown_additional_cost");
    phase = { ...phase, status: failed ? "failed" : "executed", reason: failed ? "acquisition_failed" : null,
      allowance, budget, result, accounting: failed ? "partial" : "complete" };
    return finish(result.nominations.map(row => row.source));
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted) || phase.status !== "not_run") throw error;
    return finish();
  } finally { if (!handedOff) release?.(); }
}
