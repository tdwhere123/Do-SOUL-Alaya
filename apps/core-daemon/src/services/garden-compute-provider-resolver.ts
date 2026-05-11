import {
  GardenProviderError,
  GardenProviderKind,
  OFFICIAL_API_GARDEN_MODEL,
  type GardenCompileContext,
  type GardenComputeProvider
} from "@do-soul/alaya-soul";
import type {
  CandidateMemorySignal,
  RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";

export interface GardenComputeProviderResolverDependencies {
  readonly configReader: {
    getRuntimeGardenComputeConfig(): Promise<RuntimeGardenComputeConfig>;
  };
  readonly secretReader: (secretRef: string) => string;
  readonly makeProvider: (config: {
    readonly apiKey: string;
    readonly model: string;
    readonly endpoint: string | null;
  }) => GardenComputeProvider;
  readonly fallbackProvider?: GardenComputeProvider;
}

export class GardenComputeProviderResolver implements GardenComputeProvider {
  public readonly provider_kind = GardenProviderKind.OFFICIAL_API;
  private cachedKey: string | null = null;
  private cachedProvider: GardenComputeProvider | null = null;

  public constructor(private readonly deps: GardenComputeProviderResolverDependencies) {}

  public async getProvider(): Promise<GardenComputeProvider> {
    const config = await this.deps.configReader.getRuntimeGardenComputeConfig();
    if (
      config.provider_kind !== GardenProviderKind.OFFICIAL_API ||
      !config.enabled ||
      config.secret_ref === null
    ) {
      if (this.deps.fallbackProvider !== undefined) {
        return this.deps.fallbackProvider;
      }
      throw new GardenProviderError("Official garden provider is not enabled.", "auth");
    }

    const model = config.model_id ?? OFFICIAL_API_GARDEN_MODEL;
    const endpoint = config.provider_url ?? null;
    const cacheKey = buildCacheKey({
      secretRef: config.secret_ref,
      model,
      endpoint
    });

    if (this.cachedKey === cacheKey && this.cachedProvider !== null) {
      return this.cachedProvider;
    }

    const apiKey = this.deps.secretReader(config.secret_ref);
    const provider = this.deps.makeProvider({ apiKey, model, endpoint });
    this.cachedKey = cacheKey;
    this.cachedProvider = provider;
    return provider;
  }

  public invalidate(): void {
    this.cachedKey = null;
    this.cachedProvider = null;
  }

  public async compile(
    turnContent: string,
    context: GardenCompileContext
  ): Promise<readonly CandidateMemorySignal[]> {
    return await (await this.getProvider()).compile(turnContent, context);
  }
}

function buildCacheKey(input: {
  readonly secretRef: string;
  readonly model: string;
  readonly endpoint: string | null;
}): string {
  return JSON.stringify([input.secretRef, input.model, input.endpoint]);
}
