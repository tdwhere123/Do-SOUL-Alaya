import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { RecallSupplementaryData } from "./recall-service-types.js";

// Opt-in: the lane-count corroboration discount cannot tell a porter+trigram
// pair firing on the SAME content string (redundant) from a content hit plus a
// DISTINCT evidence_ref hit (independent corroboration). With this flag the
// discount is gated on orthogonal-field count, not raw lane count, so only
// genuinely-redundant same-field multi-lane hits are damped.
export function lexicalDecorrEnabled(): boolean {
  const raw = process.env.ALAYA_RECALL_LEXICAL_DECORR;
  return raw === "on" || raw === "1" || raw === "true";
}

// Counts how many ORTHOGONAL lexical fields actually hit this candidate.
// porter + trigram collapse to one `content` field (a trigram is a redundant
// view of the same content string); each distinct evidence_ref that hit is its
// own independent field; the evidence^structural co-agreement is one marker.
// A discount is redundancy only when raw lane count exceeds this field count.
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
  // perRef absent (older producers only emit the aggregate) → fall back to the
  // aggregate evidence hit as a single field so the field count never collapses
  // below the lane signal it represents.
  if (count === 0 && (supplementaryData.evidenceFtsRanks[entry.object_id] ?? 0) > 0) {
    return 1;
  }
  return count;
}
