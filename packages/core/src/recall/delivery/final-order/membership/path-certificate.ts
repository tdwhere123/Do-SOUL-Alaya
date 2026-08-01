import { PathAnchorRefSchema } from "@do-soul/alaya-protocol";
import { isWorkspaceMemoryCandidate } from
  "../../../runtime/recall-service-helpers.js";
import type { PathInflowEdge } from
  "../../../runtime/recall-service-types.js";
import type { FineAssessmentCandidate } from
  "../../fine-assessment-selection/types.js";

type PathCandidate = Readonly<{
  readonly candidateKey: string;
  readonly rawEmbeddingRank?: number;
  readonly sourceCandidate: FineAssessmentCandidate;
}>;

type PathMembershipContext<T extends PathCandidate> = Readonly<{
  readonly candidatesByObjectId: ReadonlyMap<string, T>;
  readonly pathInflowByTarget: Readonly<Record<string, readonly PathInflowEdge[]>>;
  readonly headWidth: number;
}>;

export type ReciprocalAnswersWithCertificate = Readonly<{
  readonly sourceCandidateKey: string;
  readonly targetCandidateKey: string;
  readonly pathId: string;
  readonly pathSourceVersion: string;
  readonly relationKind: "answers_with";
}>;

export function isFinitePositiveRank(rank: number | null): rank is number {
  return rank !== null && Number.isFinite(rank) && rank > 0;
}

export function isRankWithinHead(rank: number | null, headWidth: number): boolean {
  return isFinitePositiveRank(rank) && rank <= headWidth;
}

export function reciprocalAnswersWithCertificate<T extends PathCandidate>(
  candidate: T,
  context: PathMembershipContext<T>,
  requireEmbeddingRank = true
): ReciprocalAnswersWithCertificate | null {
  const rank = candidate.rawEmbeddingRank;
  if (
    requireEmbeddingRank &&
    (rank === undefined || rank <= 0 || rank > context.headWidth)
  ) return null;
  if (!isWorkspaceMemoryCandidate(candidate.sourceCandidate)) return null;
  const targetId = candidate.sourceCandidate.entry.object_id;
  for (const inbound of completeAnswersWithEdges(targetId, context.pathInflowByTarget)) {
    const source = context.candidatesByObjectId.get(inbound.seedObjectId);
    if (source === undefined || inbound.pathId === undefined) continue;
    const reciprocal = completeAnswersWithEdges(
      source.sourceCandidate.entry.object_id, context.pathInflowByTarget
    ).some((edge) =>
      edge.pathId === inbound.pathId &&
      edge.pathSourceVersion === inbound.pathSourceVersion &&
      edge.seedObjectId === targetId
    );
    if (!reciprocal) continue;
    return Object.freeze({
      sourceCandidateKey: source.candidateKey,
      targetCandidateKey: candidate.candidateKey,
      pathId: inbound.pathId,
      pathSourceVersion: inbound.pathSourceVersion!,
      relationKind: "answers_with"
    });
  }
  return null;
}

function completeAnswersWithEdges(
  targetObjectId: string,
  pathInflowByTarget: Readonly<Record<string, readonly PathInflowEdge[]>>
): readonly PathInflowEdge[] {
  return (pathInflowByTarget[targetObjectId] ?? []).filter((edge) =>
    edge.relationKind === "answers_with" &&
    edge.targetObjectId === targetObjectId &&
    isNonEmpty(edge.pathId) &&
    isNonEmpty(edge.pathSourceVersion) &&
    hasBoundObjectAnchor(edge.seedAnchor, edge.seedObjectId) &&
    hasBoundObjectAnchor(edge.targetAnchor, edge.targetObjectId) &&
    Number.isFinite(edge.weight)
  );
}

function hasBoundObjectAnchor(anchor: unknown, objectId: string): boolean {
  const parsed = PathAnchorRefSchema.safeParse(anchor);
  return parsed.success && parsed.data.kind === "object" &&
    parsed.data.object_id === objectId;
}

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
