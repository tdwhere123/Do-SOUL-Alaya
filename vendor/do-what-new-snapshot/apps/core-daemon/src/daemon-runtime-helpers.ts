import {
  ExecutionStancePolicySchema,
  ManifestationBudgetConfigSchema,
  type ExecutionStancePolicy,
  type ManifestationBudgetConfig
} from "@do-what/protocol";

type ConfigRepoPort = {
  get<TValue>(key: string): Promise<TValue | null>;
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

export function createStancePolicyProvider(configRepo: ConfigRepoPort): Readonly<{
  getPolicy(workspaceId: string): Promise<Readonly<ExecutionStancePolicy> | null>;
}> {
  return Object.freeze({
    getPolicy: async (workspaceId: string): Promise<Readonly<ExecutionStancePolicy> | null> => {
      const configKey = `workspace:${workspaceId}:stance_policy`;
      const rawPolicy = await configRepo.get<ExecutionStancePolicy>(configKey);
      return rawPolicy === null ? null : ExecutionStancePolicySchema.parse(rawPolicy);
    }
  });
}

export function createManifestationBudgetConfigProvider(configRepo: ConfigRepoPort): Readonly<{
  getConfig(workspaceId: string): Promise<Readonly<ManifestationBudgetConfig> | null>;
}> {
  return Object.freeze({
    getConfig: async (
      workspaceId: string
    ): Promise<Readonly<ManifestationBudgetConfig> | null> => {
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
