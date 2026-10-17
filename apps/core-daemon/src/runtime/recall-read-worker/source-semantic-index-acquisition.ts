import { sourceSemanticAcquisitionNotRun, SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
  capturePackSourceSemanticAcquisitionForRequest, type SourceSemanticCompactAcquisition, type SourceSemanticAcquisitionPhase,
  type SourceIndexQueryVector, type SourceIndexTarget, type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition, authorizeSemanticScope, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { quoteSemanticSourceObservation } from "./source-semantic-source-observation.js";
import { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import type { ResearchLexicalPrefixCapture } from "./source-semantic-research-lexical-prefix.js";

type Route = Readonly<{ navigation: string; vector: SourceIndexQueryVector }>;
type Allowance = SourceSemanticAcquisitionPhase["allowance"];

/** Original first, then a distinct hint with only the remaining SAME envelope. One canonical
 * quote survives both routes until the observation owner begins that source. No refill.
 * Route receipts retain native ranks/windows independently, including duplicate roots.
 * Catalog admission sees each source-record identity once; root_key is the gold-root authority.
 */
export function acquireSourceSemanticIndex(input: Readonly<{
  runtime: SourceSemanticReadRuntime; workspace: string; navigation: string; authorized: readonly string[] | null;
  meter: SourceSemanticReadBudget; metadataMeter: SourceSemanticReadBudget; vector: SourceIndexQueryVector;
  supplemental?: Route; canonicalBytes: number; sourceCost: (length: number) => SourceSemanticResourceBudget;
  control?: Parameters<SourceIndexAcquisition["nominate"]>[2]; lexicalCapture?: ResearchLexicalPrefixCapture;
}>): { phase: SourceSemanticAcquisitionPhase; nominations: readonly SourceIndexTarget[]; releaseCanonical: () => void } {
  const { meter } = input;
  const quote = quoteSemanticSourceObservation(input.sourceCost, Math.min(4096, input.canonicalBytes));
  let release: (() => void) | undefined, handedOff = false;
  let phase = sourceSemanticAcquisitionNotRun("canonical_observation_allowance");
  function finish(capture: SourceSemanticAcquisitionPhase, compact: SourceSemanticCompactAcquisition): void;
  function finish(nominations?: readonly SourceIndexTarget[]): ReturnType<typeof acquireSourceSemanticIndex>;
  function finish(value: SourceSemanticAcquisitionPhase | readonly SourceIndexTarget[] = [], compact?: SourceSemanticCompactAcquisition) {
    if (compact !== undefined) {
      // Keep the codec's actual owned capture in the existing side slot. The
      // observation ledger and all receipts continue carrying only compact data.
      phase = value as SourceSemanticAcquisitionPhase; meter.acquisition = compact; return;
    }
    capturePackSourceSemanticAcquisitionForRequest(phase, input.metadataMeter, finish);
    handedOff = true;
    return { phase, nominations: value as readonly SourceIndexTarget[], releaseCanonical: () => release?.() };
  }
  try {
    release = meter.hold(quote);
    const budget = meter.remaining(), attempts = Math.min(128, budget.work_units);
    const allowance = { max_attempts: attempts, max_roots: Math.min(16, attempts),
      max_vector_windows: Math.min(4096, budget.work_units) };
    const repository = new SqliteSourceIndexRepository(input.runtime.database, fieldContractSha256);
    const acquisition = new SourceIndexAcquisition(repository, fieldContractSha256);
    const original = input.lexicalCapture === undefined ? acquisition : new SourceIndexAcquisition(
      input.lexicalCapture.repository(repository, input.runtime), fieldContractSha256);
    const run = (route: Route, remaining: Allowance): SourceSemanticAcquisitionPhase =>
      acquireRoute(route === input ? original : acquisition, input.workspace, input.authorized, route, remaining, meter, input.control);
    phase = run(input, allowance);
    const nominations = phase.result?.nominations.map(row => row.source) ?? [];
    const hint = input.supplemental;
    if (hint !== undefined && hint.navigation !== input.navigation) {
      const spent = phase.result; // Native acquisition already owns distinct-root admission.
      const remaining = { max_attempts: Math.max(0, allowance.max_attempts - (spent?.accounting.attempted ?? 0)),
        max_roots: Math.max(0, allowance.max_roots - nominations.length),
        max_vector_windows: Math.max(0, allowance.max_vector_windows - (spent?.vector.inspected_windows ?? 0)) };
      let supplemental = { ...sourceSemanticAcquisitionNotRun("supplemental_route_allowance"),
        allowance: remaining, budget: meter.remaining() };
      // A true cap-zero skip must not look like a later union-reference failure.
      if (remaining.max_attempts === 0 || remaining.max_roots === 0) {
        supplemental = run(hint, remaining);
      } else {
        try {
          meter.charge(nominations.length, 64 + 16 * nominations.length, "source route union references");
          supplemental = run(hint, remaining);
        } catch (error) {
          if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
          supplemental = { ...supplemental, reason: error.phase, budget: meter.remaining() };
        }
      }
      // Keep both occurrences in phase evidence; union catalog list is unique by admission identity.
      phase = { ...phase, supplemental: [supplemental] };
      for (const row of supplemental.result?.nominations ?? []) {
        if (nominations.some(existing => existing.source_id === row.source.source_id
          && existing.root_key === row.source.root_key)) continue;
        nominations.push(row.source);
      }
    }
    return finish(nominations);
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted) || phase.status !== "not_run") throw error;
    return finish();
  } finally { if (!handedOff) release?.(); }
}

function acquireRoute(acquisition: SourceIndexAcquisition, workspace: string, authorized: readonly string[] | null,
  route: Route, allowance: Allowance, meter: SourceSemanticReadBudget,
  control?: Parameters<SourceIndexAcquisition["nominate"]>[2]): SourceSemanticAcquisitionPhase {
  let phase = { ...sourceSemanticAcquisitionNotRun("acquisition_envelope_allowance"), allowance, budget: meter.remaining() };
  if (allowance.max_attempts === 0 || allowance.max_roots === 0) return { ...phase, reason: "shared_nomination_allowance" };
  try {
    // Capture planning is expenditure, unlike the canonical hold. Actual query capture is
    // separately charged by the native owner, including every prepared vector it consumes.
    const navigation = SourceSemanticResourceLedger.measureRetain(route.navigation, meter.remaining(), meter);
    const vectorInput = SourceSemanticResourceLedger.measureRetain(route.vector.status === "available"
      ? route.vector.profile : route.vector.reason, meter.remaining(), meter);
    const budget = meter.remaining();
    phase = { ...phase, budget };
    const dimensions = route.vector.status === "available" ? route.vector.profile.dimensions : 0;
    meter.reserve(1 + navigation.work_units + route.navigation.length + vectorInput.work_units +
      (dimensions === 0 ? 0 : 1 + 3 * dimensions),
      2048 + 8 * allowance.max_roots + navigation.memory_bytes + vectorInput.memory_bytes +
      (dimensions === 0 ? 0 : 256 + 4 * dimensions), "source acquisition envelope and input capture");
    const result = acquisition.nominate({ workspace_id: workspace, navigation_text: route.navigation,
      vector: route.vector, allowance, budget }, scope => {
        try { authorizeSemanticScope(scope, authorized); return "admitted"; }
        catch { return "denied"; }
      }, control);
    meter.absorbIndex(result.resources);
    const failed = result.resource_refusals.some(row => row.phase === "acquisition_failed_unknown_additional_cost");
    return { ...phase, status: failed ? "failed" : "executed", reason: failed ? "acquisition_failed" : null,
      result, accounting: failed ? "partial" : "complete" };
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    return phase;
  }
}
