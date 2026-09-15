import {
  BoundSourceInterpretationSchema,
  canonicalJson,
  SourceInterpretationSignalSchema,
  type BoundSourceInterpretation,
  type EvidenceCapsule,
  type FieldContractSha256,
  type MemoryEntry,
  type SourceInterpretationSignal
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { AuditedSourceAdmission } from "./audited-source-admission.js";
import type { FieldFormationStores } from "./field-stores.js";
import {
  admitLocatedSpans,
  durableInterpretation,
  resolveCurrentSource,
  verifyAssertionAndScope
} from "./source-observation-currentness.js";
import {
  bindInterpretation,
  findCompletePublication,
  persistObservation,
  publicationIdentity,
  publicationReservationExists,
  type ObservationEvidencePort,
  type ObservationTemporalProjection,
  type ObservationMemoryPort
} from "./source-observation-identity.js";

export type SourceObservationPublicationInput = Readonly<{
  readonly signal: SourceInterpretationSignal;
  readonly sourceEventAnchor: Readonly<{
    readonly event_type: "soul.signal.emitted";
    readonly event_id: string;
    readonly occurred_at: string;
  }> | null;
}>;

export type SourceObservationPublicationResult = Readonly<{
  readonly bound: BoundSourceInterpretation;
  readonly evidence: Readonly<EvidenceCapsule>;
  readonly memory: Readonly<MemoryEntry>;
}>;

export type SourceObservationPublication = Readonly<{
  publish(input: SourceObservationPublicationInput): Promise<SourceObservationPublicationResult>;
}>;

/** Read-only verification of a retained publication using the live admission identities. */
export function verifySourceObservationPublication(input: Readonly<{
  stores: Pick<FieldFormationStores, "listRecords" | "getStoredRecord">;
  signal: SourceInterpretationSignal;
  bound: BoundSourceInterpretation;
  sha256: FieldContractSha256;
}>) {
  const signal = SourceInterpretationSignalSchema.parse(input.signal);
  const bound = BoundSourceInterpretationSchema.parse(input.bound);
  const located = signal.raw_payload.source_interpretation;
  if (signal.source !== "garden_compile" || located.outcome !== "candidates") {
    throw new CoreError("VALIDATION", "source observation has no publishable candidates");
  }
  const stored = resolveCurrentSource(input.stores, signal.workspace_id, located, input.sha256);
  verifyAssertionAndScope(stored, signal.workspace_id, signal.scope_hint, located);
  const durable = durableInterpretation(stored.content_bytes, located);
  const identity = publicationIdentity(stored, durable, input.sha256);
  const expected = bindInterpretation(durable, stored, identity.evidenceObjectId);
  if (canonicalJson(bound) !== canonicalJson(expected)) {
    throw new CoreError("VALIDATION", "stored source observation binding differs from its publication");
  }
  return Object.freeze({ stored, identity });
}

/** Core admission for located source observations. Protocol location cannot mint source_target. */
export function createSourceObservationPublication(input: Readonly<{
  readonly stores: FieldFormationStores;
  readonly sourceAdmission: AuditedSourceAdmission;
  readonly evidenceService: ObservationEvidencePort;
  readonly memoryService: ObservationMemoryPort;
  readonly sha256: FieldContractSha256;
  readonly deriveTemporalProjection: (assertion: string, sourceObservedAt: string | null) => ObservationTemporalProjection;
}>): SourceObservationPublication {
  return {
    async publish(request) {
      const signal = SourceInterpretationSignalSchema.parse(request.signal);
      if (signal.source !== "garden_compile") {
        throw new CoreError("VALIDATION", "source observation producer is not trusted");
      }
      const located = signal.raw_payload.source_interpretation;
      const stored = resolveCurrentSource(
        input.stores,
        signal.workspace_id,
        located,
        input.sha256
      );
      const scope = verifyAssertionAndScope(
        stored,
        signal.workspace_id,
        signal.scope_hint,
        located
      );
      const durable = durableInterpretation(stored.content_bytes, located);
      const identity = publicationIdentity(stored, durable, input.sha256);
      const assertSourceCurrent = () => {
        const current = resolveCurrentSource(input.stores, signal.workspace_id, located, input.sha256);
        if (current.record.identity !== stored.record.identity) {
          throw new CoreError("VALIDATION", "source revision is not current");
        }
        verifyAssertionAndScope(current, signal.workspace_id, signal.scope_hint, located);
      };
      const existing = await findCompletePublication(
        input.evidenceService,
        input.memoryService,
        signal.workspace_id,
        identity
      );
      assertSourceCurrent();
      if (existing !== null) return existing;
      if (!await publicationReservationExists(
        input.evidenceService,
        input.memoryService,
        signal.workspace_id,
        identity
      )) {
        await admitLocatedSpans(input.sourceAdmission, stored, durable);
      }
      const bound = bindInterpretation(durable, stored, identity.evidenceObjectId);
      return await persistObservation(
        { ...input, assertSourceCurrent,
          temporalProjection: input.deriveTemporalProjection(bound.assertion_binding.text, stored.record.event_time)
        }, signal, request.sourceEventAnchor, bound, identity, scope
      );
    }
  };
}
