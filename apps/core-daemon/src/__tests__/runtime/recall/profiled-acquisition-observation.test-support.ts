import type { SourceSemanticAccessProfile } from "@do-soul/alaya-protocol";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { acquireProfiledSourceSemanticIndex } from "../../../runtime/recall-read-worker/source-semantic-index-acquisition.js";
import { SourceSemanticObserver } from "../../../runtime/recall-read-worker/source-semantic-observation.js";
import { sourceSemanticRevision } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import { CLOCK, WS, QUERY_BUDGET, type withIndexedSources } from "./source-semantic-index-acquisition.test-support.js";

type Fixture = Parameters<Parameters<typeof withIndexedSources>[1]>[0];

/** Exercises the retained acquisition/observation adapter, not retired worker ingress.
 * The query vectors, SQLite capture, phase and witness all come from their real owners. */
export async function observeProfiledAcquisition(fixture: Fixture, profile: SourceSemanticAccessProfile,
  options?: ConstructorParameters<typeof SourceSemanticObserver>[1], hint?: string) {
  const prepared = await fixture.prepareQuery({ navigation: "needle", supplemental_navigation: hint,
    signal: new AbortController().signal, remainingMs: () => 60000 });
  const runtime = { database: fixture.database };
  const observer = options === undefined ? undefined : new SourceSemanticObserver(1, options);
  observer?.facts.begin(runtime, { operation: "prepare_query", workspace_id: WS, as_of: CLOCK,
    snapshot_revision: sourceSemanticRevision(runtime), index: null,
    preparation: { status: prepared.receipt.status, reason: prepared.receipt.reason } });
  const meter = new SourceSemanticReadBudget({ ...QUERY_BUDGET, work_units: 2000000, memory_bytes: 20000000 }, observer);
  const result = fixture.database.connection.transaction(() => acquireProfiledSourceSemanticIndex({ runtime,
    workspace: WS, navigation: "needle", authorized: ["project"], meter, metadataMeter: meter,
    vector: prepared.vector, canonicalBytes: 0, sourceCost: () => ({ work_units: 0, memory_bytes: 0 }),
    ...(hint === undefined ? {} : { supplemental: { navigation: hint, vector: prepared.supplemental!.vector } }) }, profile))();
  result.releaseCanonical();
  return { phase: result.phase, witness: result.witness,
    work: { logical_work: meter.spentWork, logical_memory_bytes: meter.spentBytes }, observation: observer?.finish("success") };
}
