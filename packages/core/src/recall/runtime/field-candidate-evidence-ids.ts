import type { RecallCandidate } from "@do-soul/alaya-protocol";

export type FieldCandidateEvidenceView = Readonly<{
  readonly entry: Readonly<{
    readonly object_id: string;
    readonly evidence_refs: readonly string[];
  }>;
  readonly objectKind?: RecallCandidate["object_kind"];
}>;

export function fieldCandidateEvidenceIds(
  candidate: FieldCandidateEvidenceView
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (id.length === 0 || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const id of candidate.entry.evidence_refs) push(id);
  if (candidate.objectKind === "evidence_capsule") push(candidate.entry.object_id);
  return ids;
}

export function directEvidenceCapsuleIds(
  fieldCandidates: readonly FieldCandidateEvidenceView[]
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of fieldCandidates) {
    if (candidate.objectKind !== "evidence_capsule") continue;
    const id = candidate.entry.object_id;
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function collectFieldSetEvidenceIds(
  fieldCandidates: readonly FieldCandidateEvidenceView[]
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of fieldCandidates) {
    for (const id of fieldCandidateEvidenceIds(candidate)) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
