import {
  BoundSourceStatementSchema, SourceStatementSignalSchema, HostOccurrenceInventorySchema, sourceStatementArtifact,
  type BoundSourceStatement, type EvidenceCapsule, type FieldContractSha256, type MemoryEntry,
  type SourceStatementSignal, type LocatedSourceStatement, type SourceScopeClass
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { FieldFormationStores, StoredSourceRecord } from "./field-stores.js";
import { resolveCurrentSource } from "./source-observation-currentness.js";
import { assertPublicationBinding, bindInterpretation, findCompletePublication, persistObservation,
  publicationIdentity, type ObservationEvidencePort, type ObservationMemoryPort, type ObservationTemporalProjection
} from "./source-observation-identity.js";

export type SourceObservationPublicationInput = Readonly<{
  signal: SourceStatementSignal;
  sourceEventAnchor: Readonly<{ event_type: "soul.signal.emitted"; event_id: string; occurred_at: string }> | null;
}>;
export type SourceObservationPublicationResult = Readonly<{
  bound: BoundSourceStatement; evidence: Readonly<EvidenceCapsule>; memory: Readonly<MemoryEntry>;
}>;
export type SourceObservationPublication = Readonly<{
  publish(input: SourceObservationPublicationInput): Promise<SourceObservationPublicationResult>;
}>;

export function verifySourceObservationPublication(input: Readonly<{
  stores: Pick<FieldFormationStores, "getCurrentRecord" | "getStoredRecord" | "getHostInventory">;
  signal: SourceStatementSignal; bound: BoundSourceStatement; sha256: FieldContractSha256;
}>) {
  const signal = SourceStatementSignalSchema.parse(input.signal);
  const bound = BoundSourceStatementSchema.parse(input.bound);
  const located = signal.raw_payload.source_statement;
  const stored = resolveCurrentSource(input.stores, signal.workspace_id, located, input.sha256);
  verifyMessage(input.stores, stored, signal, located, input.sha256);
  const identity = publicationIdentity(stored, located, input.sha256);
  assertPublicationBinding(bound, bindInterpretation(located, stored));
  return { stored, identity };
}

/** The existing authorization/audit/recovery owner now publishes one minimal statement at a time. */
export function createSourceObservationPublication(input: Readonly<{
  stores: FieldFormationStores;
  evidenceService: ObservationEvidencePort; memoryService: ObservationMemoryPort; sha256: FieldContractSha256;
  deriveTemporalProjection: (sourceMessage: string, sourceObservedAt: string | null) => ObservationTemporalProjection;
}>): SourceObservationPublication {
  return { async publish(request) {
    const signal = SourceStatementSignalSchema.parse(request.signal);
    const located = signal.raw_payload.source_statement;
    const stored = resolveCurrentSource(input.stores, signal.workspace_id, located, input.sha256);
    const scope = verifyMessage(input.stores, stored, signal, located, input.sha256);
    const identity = publicationIdentity(stored, located, input.sha256);
    const assertSourceCurrent = () => {
      const current = resolveCurrentSource(input.stores, signal.workspace_id, located, input.sha256);
      if (current.record.identity !== stored.record.identity) throw new CoreError("VALIDATION", "source revision changed");
      verifyMessage(input.stores, current, signal, located, input.sha256);
    };
    const existing = await findCompletePublication(input.evidenceService, input.memoryService, signal.workspace_id, identity);
    assertSourceCurrent();
    if (existing !== null) {
      verifySourceObservationPublication({ stores: input.stores, signal, bound: existing.bound, sha256: input.sha256 });
      persistArtifact(existing.bound, existing.evidence.object_id);
      persistMemoryBinding();
      return existing;
    }
    const bound = bindInterpretation(located, stored);
    function persistArtifact(bound: BoundSourceStatement, evidenceId: string): void {
      input.stores.runAtomic(() => {
        assertSourceCurrent();
        input.stores.putSourceStatementArtifact(sourceStatementArtifact(bound, evidenceId, input.sha256));
      });
    }
    function persistMemoryBinding(inMemoryTransaction = false): void {
      const write = () => {
        assertSourceCurrent();
        input.stores.putSourceStatementMemoryBinding(signal.workspace_id, identity.memoryObjectId, identity.evidenceObjectId);
      };
      // Memory creation already owns audit + row + dependency atomically. Recovery owns a new field transaction.
      if (inMemoryTransaction) write(); else input.stores.runAtomic(write);
    }
    // Host source time remains the authority. Statement dates are not event-time evidence.
    return persistObservation({ ...input, assertSourceCurrent, persistMemoryBinding,
      persistArtifact: evidence => persistArtifact(bound, evidence.object_id),
      temporalProjection: input.deriveTemporalProjection(located.message.text, stored.record.event_time)
    }, signal, request.sourceEventAnchor, bound, identity, scope);
  } };
}

function verifyMessage(stores: Pick<FieldFormationStores, "getHostInventory" | "getCurrentRecord" | "getStoredRecord">, stored: StoredSourceRecord,
  signal: SourceStatementSignal, located: LocatedSourceStatement, sha256: FieldContractSha256): SourceScopeClass {
  if (located.source_root_id !== stored.record.identity) {
    throw new CoreError("VALIDATION", "statement source revision is no longer current");
  }
  const scope = stored.record.scope_class ?? "project";
  if (stored.record.workspace_id !== signal.workspace_id || signal.scope_hint !== null && signal.scope_hint !== scope) {
    throw new CoreError("VALIDATION", "source statement scope differs from its admitted source");
  }
  if (located.message.recorded_time?.level === "session" && located.message.recorded_at !== stored.record.event_time) {
    throw new CoreError("VALIDATION", "statement session time differs from the admitted source observation");
  }
  for (const dependency of located.source_context) {
    if (dependency.workspace_id !== signal.workspace_id) throw new CoreError("VALIDATION", "statement context crosses workspace");
    const context = resolveCurrentSource(stores, signal.workspace_id,
      { artifact_key: dependency.source_id, source_corpus_digest: dependency.content_digest.slice("sha256:".length) }, sha256);
    if (context.record.identity !== dependency.root_id || context.record.source_version !== dependency.source_version ||
        (context.record.scope_class ?? "project") !== scope) {
      throw new CoreError("VALIDATION", "statement model-visible context is no longer current in its captured scope");
    }
  }
  const bytes = Buffer.from(stored.content_bytes, "utf8"), [start, end] = located.source_span;
  if (end > bytes.length || bytes.subarray(start, end).toString("utf8") !== located.message.text) {
    throw new CoreError("VALIDATION", "statement message span differs from current source");
  }
  const raw = stores.getHostInventory(signal.workspace_id, stored.record.identity);
  if (raw === null) throw new CoreError("VALIDATION", "statement message has no admitted host binding");
  const inventory = HostOccurrenceInventorySchema.parse(JSON.parse(raw));
  const occurrence = inventory.occurrences.find(row => row.utf8_span[0] === start && row.utf8_span[1] === end);
  if (occurrence === undefined || occurrence.occurrence_id !== located.message.message_id || occurrence.role !== located.message.role) {
    throw new CoreError("VALIDATION", "statement message role or extent differs from admitted host occurrence");
  }
  return scope;
}
