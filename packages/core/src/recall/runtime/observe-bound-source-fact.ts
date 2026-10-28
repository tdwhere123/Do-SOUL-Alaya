import { CONDITIONAL_FIELD_SCHEMA_VERSION, SNAPSHOT_PIN_NATIVE_WORK } from "@do-soul/alaya-protocol";
import { SourceFactDemands } from "../conditional-field/engine/observation-frontier.js";
import { applyObserverPage } from "../conditional-field/engine/field-engine.js";
import { sourceFactEligible } from "../conditional-field/observers/observation-admission.js";
import { SOURCE_IDENTITY_HYDRATE_RESERVE, sourceNativeReadCounts, validateSourceObserverPage } from "../conditional-field/observers/observe-ports.js";
import { ObservedSourceFacts, retainSourceFact } from "./observed-source-facts.js";
import { cursorOf, interruptAtomicWork, interruptObservedField } from "./observe-field-residuals.js";
import type { ObservationSession } from "./conditional-field-observe-session.js";

export function consumeBoundSourceFact(session: ObservationSession): boolean {
  const { input } = session;
  const demands = new SourceFactDemands(session.state.source_fact_demands,
    session.state.source_fact_pending_count, session.state.source_fact_scan_offset,
    session.state.source_fact_demand_bytes);
  if (!demands.hasPending()) return false;
  const pinWork = input.readers.snapshotPin === undefined ? 0 : SNAPSHOT_PIN_NATIVE_WORK;
  // One indexed lookup and the maximum singleton source read must both fit before
  // invoking the reader. A completed fact can use less, but never more.
  const readReserve = 2 + (input.readers.source === undefined ? 0 : SOURCE_IDENTITY_HYDRATE_RESERVE) + pinWork;
  if (session.state.remaining_exploration < 1 + readReserve) {
    session.state = interruptAtomicWork(session, "source_fact", 1 + readReserve);
    return true;
  }
  const pending = demands.nextPending(session.state.remaining_exploration - readReserve);
  input.cost?.add("observe", { joins: pending.work });
  session.state = { ...session.state, remaining_exploration: session.state.remaining_exploration - pending.work,
    source_fact_scan_offset: pending.index ?? pending.next };
  if (session.state.source_fact_scan_offset !== demands.offset) input.on_retained_progress?.();
  if (pending.key === undefined) {
    session.state = interruptObservedField(session.state);
    return true;
  }
  const objectId = pending.key;
  if (session.sourceFacts.has(objectId)) {
    demands.complete(objectId);
    input.cost?.add("observe", { joins: 1 });
    session.state = { ...session.state, remaining_exploration: session.state.remaining_exploration - 1,
      source_fact_demands: demands.snapshot, source_fact_pending_count: demands.pending,
      source_fact_scan_offset: pending.next };
    input.on_retained_progress?.();
    return true;
  }
  const pin = input.readers.snapshotPin?.(input.workspace_id);
  if (pinWork > 0) {
    input.cost?.add("observe", { native_visits: pinWork });
    session.state = { ...session.state, remaining_exploration: session.state.remaining_exploration - pinWork };
  }
  if (pin !== undefined && input.expected_source_revision !== undefined
    && pin.source_revision !== input.expected_source_revision) {
    session.state = applyObserverPage(session.state, { page: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      query_id: session.interpretation.query_id, snapshot_id: session.interpretation.snapshot_id,
      cursor: cursorOf(session.cursors, session.interpretation, "adjacency"), observations: [],
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "invalidated" },
      open_regions: session.state.residuals.map((region) => ({ ...region, status: "invalidated" as const }))
    }, effects: [] });
    return true;
  }
  const page = input.readers.source?.({ workspaceId: input.workspace_id, objectId });
  if (page !== undefined) validateSourceObserverPage(page);
  const work = 2 + (page?.rowsRead ?? 0);
  input.cost?.add("observe", { ...(page === undefined ? {} : sourceNativeReadCounts(page)), joins: 2 });
  const charged = { ...session.state, remaining_exploration: session.state.remaining_exploration - work };
  if (page?.resourceLimited === true) {
    session.state = interruptObservedField(charged);
    return true;
  }
  const sourceFacts = new ObservedSourceFacts(session.sourceFacts.snapshot, session.sourceFacts.bytes);
  if (page?.unavailable !== true && page?.row !== null && page?.row !== undefined
    && sourceFactEligible(page.row, input.authorized_scopes, input.as_of)) {
    retainSourceFact(sourceFacts, objectId, page.row, input.workspace_id, session.observedAt);
  }
  const retainedBytes = sourceFacts.bytes - session.sourceFacts.bytes;
  if (retainedBytes > charged.remaining_memory_bytes) {
    session.state = { ...interruptObservedField(charged), memory_exhausted: true };
    return true;
  }
  demands.complete(objectId);
  session.sourceFacts = sourceFacts;
  session.state = { ...charged,
    remaining_memory_bytes: charged.remaining_memory_bytes - retainedBytes,
    admitted_allocation_bytes: (charged.admitted_allocation_bytes ?? 0) + retainedBytes,
    source_facts: sourceFacts.snapshot, source_fact_bytes: sourceFacts.bytes,
    source_fact_demands: demands.snapshot, source_fact_pending_count: demands.pending,
    source_fact_scan_offset: pending.next };
  input.on_retained_progress?.();
  return true;
}
