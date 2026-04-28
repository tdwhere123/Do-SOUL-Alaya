import { ToolCategorySchema, type ClaimForm, type ToolCategory } from "@do-what/protocol";

export interface SoulClaimRegistryReader {
  listClaimsForWorkspace(workspaceId: string): Promise<readonly Readonly<ClaimForm>[]>;
}

export interface SoulHazardProjectionReader {
  listActiveHazardObjectRefs(workspaceId: string): Promise<readonly string[]>;
}

export interface SoulPolicyProjectionReader {
  listGlobalDeniedToolCategories(): Promise<readonly ToolCategory[]>;
  listWorkspaceHardStopRefs(workspaceId: string): Promise<readonly string[]>;
}

export interface SoulWorkerSafetyReaderDependencies {
  readonly claimRegistryReader: SoulClaimRegistryReader;
  readonly hazardProjectionReader: SoulHazardProjectionReader;
  readonly policyProjectionReader: SoulPolicyProjectionReader;
}

/**
 * Read-only SOUL projection used by Worker Baseline Safety.
 * It centralizes the mapping from existing SOUL state readers to the four
 * query shapes required by A3-4 without introducing mutation behavior.
 */
export class SoulWorkerSafetyReader {
  public constructor(private readonly dependencies: SoulWorkerSafetyReaderDependencies) {}

  public async listStrictClaimRefs(workspaceId: string): Promise<readonly string[]> {
    const claims = await this.dependencies.claimRegistryReader.listClaimsForWorkspace(workspaceId);

    return dedupeStrings(
      claims
        .filter(
          (claim) =>
            claim.workspace_id === workspaceId &&
            claim.enforcement_level === "strict"
        )
        .map((claim) => claim.object_id)
    );
  }

  public async listActiveHazardObjectRefs(workspaceId: string): Promise<readonly string[]> {
    return dedupeStrings(
      await this.dependencies.hazardProjectionReader.listActiveHazardObjectRefs(workspaceId)
    );
  }

  public async listGlobalDeniedCategories(): Promise<readonly ToolCategory[]> {
    const categories = await this.dependencies.policyProjectionReader.listGlobalDeniedToolCategories();
    return dedupeToolCategories(categories);
  }

  public async listHardStopRefs(workspaceId: string): Promise<readonly string[]> {
    return dedupeStrings(await this.dependencies.policyProjectionReader.listWorkspaceHardStopRefs(workspaceId));
  }
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  const unique = new Set<string>();

  for (const value of values) {
    if (typeof value !== "string") {
      throw new Error("Worker safety projections must return string refs.");
    }

    const normalized = value.trim();

    if (normalized.length === 0) {
      throw new Error("Worker safety projections must not return empty refs.");
    }

    unique.add(normalized);
  }

  return Object.freeze([...unique]);
}

function dedupeToolCategories(values: readonly ToolCategory[]): readonly ToolCategory[] {
  const unique = new Set<ToolCategory>();

  for (const value of values) {
    unique.add(ToolCategorySchema.parse(value));
  }

  return Object.freeze([...unique]);
}
