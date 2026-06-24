import {
  ACTIVE_CONSTRAINT_CLAIM_STATUSES,
  listActiveConstraintCandidateMemoryIds,
  selectActiveConstraintRecords,
  type ActiveConstraintQueryResult
} from "@do-soul/alaya-protocol";
import type { ClaimFormRepo } from "./claim-form-repo.js";
import type { MemoryEntryRepo } from "../memory-entry/index.js";
import type { PathRelationRepo } from "../path/path-relation-repo.js";

export {
  DEFAULT_ACTIVE_CONSTRAINTS_CAP,
  MAX_ACTIVE_CONSTRAINTS_CAP,
  normalizeActiveConstraintsCap,
  type ActiveConstraintQueryResult,
  type ActiveConstraintRecord,
  type ActiveConstraintSourceChannel
} from "@do-soul/alaya-protocol";

export async function findActiveConstraints(input: {
  readonly workspaceId: string;
  readonly memoryRepo: Pick<MemoryEntryRepo, "findByIds">;
  readonly claimFormRepo: Pick<ClaimFormRepo, "findByStatus">;
  readonly pathRelationRepo: Pick<PathRelationRepo, "findActiveAll">;
  readonly cap?: number | null;
}): Promise<Readonly<ActiveConstraintQueryResult>> {
  const activeClaims = await Promise.all(
    ACTIVE_CONSTRAINT_CLAIM_STATUSES.map((status) =>
      input.claimFormRepo.findByStatus(input.workspaceId, status)
    )
  );
  const claims = activeClaims.flat();
  const paths = await input.pathRelationRepo.findActiveAll(input.workspaceId);
  const linkedMemories = await input.memoryRepo.findByIds(
    input.workspaceId,
    listActiveConstraintCandidateMemoryIds({ claims, paths })
  );
  return selectActiveConstraintRecords({
    workspaceId: input.workspaceId,
    memories: linkedMemories,
    claims,
    paths,
    cap: input.cap
  });
}
