import {
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

/** Core admission for located source observations. Protocol location cannot mint source_target. */
export function createSourceObservationPublication(input: Readonly<{
  readonly stores: FieldFormationStores;
  readonly sourceAdmission: AuditedSourceAdmission;
  readonly evidenceService: ObservationEvidencePort;
  readonly memoryService: ObservationMemoryPort;
  readonly sha256: FieldContractSha256;
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
      const existing = await findCompletePublication(
        input.evidenceService,
        input.memoryService,
        signal.workspace_id,
        identity
      );
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
        input, signal, request.sourceEventAnchor, bound, identity, scope
      );
    }
  };
}
