import { GovernanceRoleState, type ClaimForm, type GovernanceRoleState as Role } from "@do-soul/alaya-protocol";
import type { GreenServiceStatusResolverPort } from "./green-service-ports.js";

/** Claim lifecycle is the durable authority for a memory's contested role. */
export class GreenClaimStatusResolver implements GreenServiceStatusResolverPort {
  public constructor(private readonly claims: {
    findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<ClaimForm>[]>;
  }) {}

  public async getGovernanceRole(params: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
  }): Promise<Role> {
    const claims = (await this.claims.findByWorkspaceId(params.workspaceId)).filter(claim =>
      claim.workspace_id === params.workspaceId && claim.source_object_refs.includes(params.targetObjectId));
    if (claims.some(claim => claim.claim_status === "contested")) return GovernanceRoleState.CONTESTED;
    if (claims.some(claim => claim.claim_status === "winner")) return GovernanceRoleState.WINNER;
    if (claims.some(claim => claim.claim_status === "active")) return GovernanceRoleState.CLAIMED;
    return GovernanceRoleState.STANDALONE;
  }
}
