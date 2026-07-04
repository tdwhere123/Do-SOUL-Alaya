import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { RecallSupplementaryData } from "./recall-service-types.js";

import { recallEnvFlagEnabled } from "../config/recall-env-access.js";

// Opt-in: gate the lane-count discount on orthogonal-field count so distinct-ref corroboration is not damped as redundant.
export function lexicalDecorrEnabled(): boolean {
  return recallEnvFlagEnabled("ALAYA_RECALL_LEXICAL_DECORR");
}

// porter+trigram collapse to one content field; each distinct evidence_ref is its own field; evidence^structural is one marker.
export function countOrthogonalLexicalFields(
  candidate: Readonly<{ readonly entry: Readonly<MemoryEntry>; readonly structuralScore?: number | null }>,
  supplementaryData: RecallSupplementaryData
): number {
  const objectId = candidate.entry.object_id;
  const contentHit =
    (supplementaryData.ftsRanks[objectId] ?? 0) > 0 ||
    (supplementaryData.trigramFtsRanks[objectId] ?? 0) > 0;
  const distinctEvidenceRefHits = countDistinctEvidenceRefHits(candidate.entry, supplementaryData);
  const structuralHit = (candidate.structuralScore ?? supplementaryData.structuralScores[objectId] ?? 0) > 0;
  const evidenceHit = (supplementaryData.evidenceFtsRanks[objectId] ?? 0) > 0;
  return (
    (contentHit ? 1 : 0) +
    distinctEvidenceRefHits +
    (evidenceHit && structuralHit ? 1 : 0)
  );
}

function countDistinctEvidenceRefHits(
  entry: Readonly<MemoryEntry>,
  supplementaryData: RecallSupplementaryData
): number {
  const perRef = supplementaryData.evidenceFtsRanksPerRef ?? {};
  let count = 0;
  for (const ref of entry.evidence_refs) {
    if ((perRef[ref] ?? 0) > 0) {
      count += 1;
    }
  }
  // perRef absent (older producers) → count the aggregate hit as one field.
  if (count === 0 && (supplementaryData.evidenceFtsRanks[entry.object_id] ?? 0) > 0) {
    return 1;
  }
  return count;
}
