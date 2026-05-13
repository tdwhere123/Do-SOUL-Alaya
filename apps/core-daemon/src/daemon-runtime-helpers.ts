import {
  ManifestationBudgetConfigSchema,
  type ManifestationBudgetConfig
} from "@do-soul/alaya-protocol";
import type { WorkspaceService } from "@do-soul/alaya-core";

type ConfigRepoPort = {
  get<TValue>(key: string): TValue | null | Promise<TValue | null>;
};

type CurrencyRecord = Readonly<{
  updated_at: string;
}>;

type CurrencyRecordRepo = {
  findById(id: string): Promise<CurrencyRecord | null>;
};

export type WarnLogger = Readonly<{
  warn(message: string, meta: Record<string, unknown>): void;
}>;

export function createWarnLogger(): WarnLogger {
  return Object.freeze({
    warn: (message: string, meta: Record<string, unknown>) => {
      console.warn(message, meta);
    }
  });
}

export type ReconcileBootstrapPathsForAllWorkspacesDeps = Readonly<{
  readonly workspaceRepo: Readonly<{
    list(): Promise<readonly Readonly<{ readonly workspace_id: string }>[]>;
  }>;
  readonly workspaceService: Pick<WorkspaceService, "reconcileBootstrapPaths">;
  readonly warn: WarnLogger["warn"];
}>;

export async function reconcileBootstrapPathsForAllWorkspaces(
  deps: ReconcileBootstrapPathsForAllWorkspacesDeps
): Promise<void> {
  let workspaces: readonly Readonly<{ readonly workspace_id: string }>[];
  try {
    workspaces = await deps.workspaceRepo.list();
  } catch (error) {
    deps.warn("bootstrap reconcile enumeration failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  for (const workspace of workspaces) {
    try {
      await deps.workspaceService.reconcileBootstrapPaths(workspace.workspace_id);
    } catch (error) {
      deps.warn("bootstrap reconcile failed", {
        workspace_id: workspace.workspace_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export function createManifestationBudgetConfigProvider(configRepo: ConfigRepoPort): Readonly<{
  getConfig(workspaceId: string): Promise<Readonly<ManifestationBudgetConfig> | null>;
}> {
  return Object.freeze({
    getConfig: async (workspaceId: string): Promise<Readonly<ManifestationBudgetConfig> | null> => {
      const configKey = `workspace:${workspaceId}:manifestation_budget`;
      const rawConfig = await configRepo.get<ManifestationBudgetConfig>(configKey);
      return rawConfig === null ? null : ManifestationBudgetConfigSchema.parse(rawConfig);
    }
  });
}

export function createTargetCurrencyCheckPort(input: {
  readonly claimFormRepo: CurrencyRecordRepo;
  readonly slotRepo: CurrencyRecordRepo;
}): Readonly<{
  checkCurrency(
    targetEntityType: string,
    targetEntityId: string,
    sinceTimestamp: string
  ): Promise<
    | Readonly<{ status: "missing" }>
    | Readonly<{ status: "fresh" }>
    | Readonly<{ status: "stale"; stale_since: string }>
  >;
}> {
  return Object.freeze({
    checkCurrency: async (targetEntityType, targetEntityId, sinceTimestamp) => {
      const sinceEpoch = Date.parse(sinceTimestamp);
      if (!Number.isFinite(sinceEpoch)) {
        return { status: "missing" as const };
      }

      const resolveStatus = (updatedAt: string) => {
        const updatedEpoch = Date.parse(updatedAt);
        if (!Number.isFinite(updatedEpoch)) {
          return { status: "missing" as const };
        }

        return updatedEpoch > sinceEpoch
          ? { status: "stale" as const, stale_since: updatedAt }
          : { status: "fresh" as const };
      };

      switch (targetEntityType) {
        case "claim":
        case "claim_form": {
          const claim = await input.claimFormRepo.findById(targetEntityId);
          return claim === null ? { status: "missing" as const } : resolveStatus(claim.updated_at);
        }
        case "slot": {
          const slot = await input.slotRepo.findById(targetEntityId);
          return slot === null ? { status: "missing" as const } : resolveStatus(slot.updated_at);
        }
        default:
          return { status: "missing" as const };
      }
    }
  });
}
