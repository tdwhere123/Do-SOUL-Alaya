import { buildOfficialApiSourceCorpus, planOfficialApiSemanticWorkset } from "@do-soul/alaya-soul";
import type { LongMemEvalExtractionTurn } from "../turn-contents.js";

export interface EnrichmentOccurrenceProvenance {
  readonly assertion_id: number;
  readonly occurrenceIdentity: string;
  readonly source_message_id: string | null;
}

/** Native planning owns occurrence identity; native corpus prefixes locate the
 * containing message without duplicating normalization or assertion parsing. */
export function collectEnrichmentOccurrenceProvenance(
  turns: readonly LongMemEvalExtractionTurn[],
  datasetRevision: string
): ReadonlyMap<string, EnrichmentOccurrenceProvenance> {
  const collected = new Map<string, EnrichmentOccurrenceProvenance>();
  for (const turn of turns) {
    const ends = turn.turnMessages.map((_, index) => buildOfficialApiSourceCorpus(
      turn.turnContent, turn.turnMessages.slice(0, index + 1)
    ).length);
    const workset = planOfficialApiSemanticWorkset(turn.turnContent, turn.turnMessages, datasetRevision);
    for (const unit of workset.units) {
      const { start, end } = unit.binding.locator;
      const index = ends.findIndex((boundary, index) =>
        start >= (index === 0 ? 0 : ends[index - 1]! + 1) && end <= boundary);
      const messageId = index < 0 ? null : turn.turnMessages[index]!.message_id;
      const identity = unit.binding.occurrenceIdentity;
      const previous = collected.get(identity);
      collected.set(identity, Object.freeze({
        assertion_id: unit.assertionId,
        occurrenceIdentity: identity,
        source_message_id: previous !== undefined && previous.source_message_id !== messageId
          ? null : messageId
      }));
    }
  }
  return collected;
}
