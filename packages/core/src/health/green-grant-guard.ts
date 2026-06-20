import {
  GovernanceRoleState,
  RevokeReason,
  type GreenStatus,
  type MemoryEntry,
  type RevokeReason as RevokeReasonType,
  type ScopeClass,
  type VerificationBasis as VerificationBasisType
} from "@do-soul/alaya-protocol";

import { CoreError } from "../shared/errors.js";

import {
  ACTIVE_LIFECYCLE,
  basisAllowedForDimension,
  isSurfaceDetached,
  normalizeBoundSurfaces,
  requiresSurfaceBinding,
  type GreenServiceEventLogRepoPort,
  type GreenServiceMemoryRepoPort,
  type GreenServiceStatusResolverPort,
  type GreenWarnPort
} from "./green-service-ports.js";

export interface GreenGrantGuardDependencies {
  readonly memoryRepo: GreenServiceMemoryRepoPort;
  readonly eventLogRepo: GreenServiceEventLogRepoPort;
  readonly statusResolver?: GreenServiceStatusResolverPort;
  readonly now: () => string;
  readonly warn: GreenWarnPort;
}

export class GreenGrantGuard {
  private hasWarnedMissingStatusResolver = false;

  public constructor(private readonly deps: GreenGrantGuardDependencies) {}

  public async getMemoryOrThrow(targetObjectId: string): Promise<Readonly<MemoryEntry>> {
    const memory = await this.deps.memoryRepo.findById(targetObjectId);

    if (memory === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    return memory;
  }

  public async assertGrantPreconditions(params: {
    readonly memory: Readonly<MemoryEntry>;
    readonly workspaceId: string;
    readonly basis: VerificationBasisType;
    readonly boundSurfaces: readonly string[] | null;
    readonly boundScopeClass: ScopeClass | null;
  }): Promise<void> {
    if (params.memory.workspace_id !== params.workspaceId) {
      throw new CoreError("VALIDATION", "Memory entry does not belong to the workspace");
    }

    if (params.memory.lifecycle_state !== ACTIVE_LIFECYCLE) {
      throw new CoreError("VALIDATION", "Only active memory entries can enter Green");
    }

    if (params.memory.evidence_refs.length === 0) {
      throw new CoreError("VALIDATION", "Green status requires evidence_refs");
    }

    if (await this.isContested(params.memory.object_id, params.workspaceId)) {
      throw new CoreError("CONFLICT", "Contested memory entries cannot enter Green");
    }

    if (await this.hasOpenCorrection(params.memory.object_id, params.workspaceId)) {
      throw new CoreError("CONFLICT", "Open session overrides block Green grant");
    }

    if (await this.hasHighRiskGuardHit(params.memory.object_id, params.workspaceId)) {
      throw new CoreError("CONFLICT", "Security guard hit blocks Green grant");
    }

    if (!basisAllowedForDimension(params.memory.dimension, params.basis)) {
      throw new CoreError(
        "VALIDATION",
        `Verification basis ${params.basis} is not allowed for ${params.memory.dimension}`
      );
    }

    if (
      requiresSurfaceBinding(params.memory.dimension) &&
      normalizeBoundSurfaces(params.boundSurfaces, params.memory.surface_id) === null
    ) {
      throw new CoreError("VALIDATION", `${params.memory.dimension} Green status requires a bound surface`);
    }

    if (params.boundScopeClass !== null && params.boundScopeClass !== params.memory.scope_class) {
      throw new CoreError("VALIDATION", "boundScopeClass must match the target memory scope_class");
    }
  }

  public async evaluatePiercingReason(params: {
    readonly existing: Readonly<GreenStatus>;
    readonly memory: Readonly<MemoryEntry>;
    readonly workspaceId: string;
  }): Promise<RevokeReasonType | null> {
    if (await this.isContested(params.memory.object_id, params.workspaceId)) {
      return RevokeReason.CONTESTED;
    }

    if (await this.hasOpenCorrection(params.memory.object_id, params.workspaceId)) {
      return RevokeReason.CORRECTION_OPEN;
    }

    if (await this.hasHighRiskGuardHit(params.memory.object_id, params.workspaceId)) {
      return RevokeReason.SECURITY_HIT;
    }

    if (isSurfaceDetached(params.existing, params.memory.surface_id)) {
      return RevokeReason.SURFACE_DETACHED;
    }

    if (params.memory.lifecycle_state !== ACTIVE_LIFECYCLE || params.memory.evidence_refs.length === 0) {
      return RevokeReason.EXTERNAL_INVALIDATION;
    }

    return null;
  }

  private async isContested(targetObjectId: string, workspaceId: string): Promise<boolean> {
    if (this.deps.statusResolver === undefined) {
      this.warnMissingStatusResolver(workspaceId, targetObjectId);
      return false;
    }

    const governanceRole = await this.deps.statusResolver.getGovernanceRole({
      targetObjectId,
      workspaceId
    });
    return governanceRole === GovernanceRoleState.CONTESTED;
  }

  private async hasOpenCorrection(targetObjectId: string, workspaceId: string): Promise<boolean> {
    return await this.deps.eventLogRepo.hasOpenSessionOverrideCorrection({
      workspaceId,
      targetObjectId,
      nowIso: this.deps.now()
    });
  }

  private async hasHighRiskGuardHit(targetObjectId: string, workspaceId: string): Promise<boolean> {
    return await this.deps.eventLogRepo.hasSecurityHitForTarget({
      workspaceId,
      targetObjectId
    });
  }

  private warnMissingStatusResolver(workspaceId: string, targetObjectId: string): void {
    if (this.hasWarnedMissingStatusResolver) {
      return;
    }

    this.hasWarnedMissingStatusResolver = true;
    this.deps.warn("[GreenService] statusResolver missing; contested Green checks are disabled.", {
      workspaceId,
      targetObjectId
    });
  }
}
