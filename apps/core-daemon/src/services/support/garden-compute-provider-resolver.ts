import {
  GardenProviderError,
  GardenProviderKind,
  OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
  OFFICIAL_API_GARDEN_MODEL,
  type GardenCompileContext,
  type GardenComputeProvider
} from "@do-soul/alaya-soul";
import type {
  CandidateMemorySignal,
  OpenSemanticFactorGraphProposal,
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
  readonly now?: () => number;
  readonly semanticFactorFailureTtlMs?: number;
}

interface SemanticFactorFailureCacheEntry {
  readonly error: unknown;
  readonly retryAtMs: number;
}

export class GardenComputeProviderResolver implements GardenComputeProvider {
  public readonly operator_id = OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID;
  private cachedKey: string | null = null;
  private cachedProvider: GardenComputeProvider | null = null;
  private readonly semanticFactorCache = new Map<
    string,
    Readonly<OpenSemanticFactorGraphProposal> | null
  >();
  private readonly semanticFactorFailureCache = new Map<string, SemanticFactorFailureCacheEntry>();
  private semanticFactorProviderFailure: SemanticFactorFailureCacheEntry | null = null;
  private readonly now: () => number;
  private readonly semanticFactorFailureTtlMs: number;
  // Starts at the resolver's nominal kind; getProvider() corrects it to the kind it
  // actually resolved, so a compute-routing tie-breaker on provider.provider_kind does
  // not see OFFICIAL_API while the resolver is serving the local-heuristics fallback.
  private lastResolvedKind: GardenProviderKind = GardenProviderKind.OFFICIAL_API;

  public constructor(private readonly deps: GardenComputeProviderResolverDependencies) {
    this.now = deps.now ?? Date.now;
    this.semanticFactorFailureTtlMs = Math.max(0, deps.semanticFactorFailureTtlMs ?? 30_000);
  }

  public get provider_kind(): GardenProviderKind {
    return this.lastResolvedKind;
  }

  public async getProvider(): Promise<GardenComputeProvider> {
    const config = await this.deps.configReader.getRuntimeGardenComputeConfig();
    const cacheKey = buildCacheKey({
      providerKind: config.provider_kind,
      enabled: config.enabled,
      secretRef: config.secret_ref,
      model: config.model_id,
      endpoint: config.provider_url
    });
    if (this.cachedKey === cacheKey && this.cachedProvider !== null) {
      this.lastResolvedKind = this.cachedProvider.provider_kind;
      return this.cachedProvider;
    }
    if (
      config.provider_kind !== GardenProviderKind.OFFICIAL_API ||
      !config.enabled ||
      config.secret_ref === null
    ) {
      if (this.deps.fallbackProvider !== undefined) {
        return this.activateProvider(cacheKey, this.deps.fallbackProvider);
      }
      throw new GardenProviderError("Official garden provider is not enabled.", "auth");
    }

    const model = config.model_id ?? OFFICIAL_API_GARDEN_MODEL;
    const endpoint = config.provider_url ?? null;
    const apiKey = this.deps.secretReader(config.secret_ref);
    const provider = this.deps.makeProvider({ apiKey, model, endpoint });
    return this.activateProvider(cacheKey, provider);
  }

  public invalidate(): void {
    this.cachedKey = null;
    this.cachedProvider = null;
    this.clearSemanticFactorState();
  }

  public async compile(
    turnContent: string,
    context: GardenCompileContext
  ): Promise<readonly CandidateMemorySignal[]> {
    return await (await this.getProvider()).compile(turnContent, context);
  }

  public async extractOpenSemanticFactors(
    sourceKind: "evidence" | "query",
    sourceText: string
  ): Promise<Readonly<OpenSemanticFactorGraphProposal> | null> {
    const provider = await this.getProvider();
    const key = `${sourceKind}\u0000${sourceText}`;
    if (this.semanticFactorCache.has(key)) {
      return this.semanticFactorCache.get(key)!;
    }
    this.throwActiveProviderFailure();
    this.throwActiveQueryFailure(key);
    try {
      const graph = provider.extractOpenSemanticFactors === undefined
        ? null
        : await provider.extractOpenSemanticFactors(sourceKind, sourceText);
      this.semanticFactorFailureCache.delete(key);
      this.semanticFactorProviderFailure = null;
      this.semanticFactorCache.set(key, graph);
      evictOldest(this.semanticFactorCache, 256);
      return graph;
    } catch (error) {
      const failure = this.createFailureEntry(error);
      this.semanticFactorFailureCache.set(key, failure);
      evictOldest(this.semanticFactorFailureCache, 256);
      if (isProviderAvailabilityFailure(error)) {
        this.semanticFactorProviderFailure = failure;
      }
      throw error;
    }
  }

  private activateProvider(cacheKey: string, provider: GardenComputeProvider): GardenComputeProvider {
    if (this.cachedKey !== cacheKey || this.cachedProvider !== provider) {
      this.clearSemanticFactorState();
    }
    this.cachedKey = cacheKey;
    this.cachedProvider = provider;
    this.lastResolvedKind = provider.provider_kind;
    return provider;
  }

  private clearSemanticFactorState(): void {
    this.semanticFactorCache.clear();
    this.semanticFactorFailureCache.clear();
    this.semanticFactorProviderFailure = null;
  }

  private createFailureEntry(error: unknown): SemanticFactorFailureCacheEntry {
    return {
      error,
      retryAtMs: this.now() + this.semanticFactorFailureTtlMs
    };
  }

  private throwActiveProviderFailure(): void {
    const failure = this.semanticFactorProviderFailure;
    if (failure === null) return;
    if (failure.retryAtMs <= this.now()) {
      this.semanticFactorProviderFailure = null;
      return;
    }
    throw failure.error;
  }

  private throwActiveQueryFailure(key: string): void {
    const failure = this.semanticFactorFailureCache.get(key);
    if (failure === undefined) return;
    if (failure.retryAtMs <= this.now()) {
      this.semanticFactorFailureCache.delete(key);
      return;
    }
    throw failure.error;
  }
}

function evictOldest<T>(cache: Map<string, T>, limit: number): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

function buildCacheKey(input: {
  readonly providerKind: RuntimeGardenComputeConfig["provider_kind"];
  readonly enabled: boolean;
  readonly secretRef: string | null;
  readonly model: string | null;
  readonly endpoint: string | null;
}): string {
  return JSON.stringify([
    input.providerKind,
    input.enabled,
    input.secretRef,
    input.model,
    input.endpoint
  ]);
}

function isProviderAvailabilityFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly name?: unknown; readonly kind?: unknown };
  return candidate.name === "SignalExtractorError" &&
    (candidate.kind === "timeout" || candidate.kind === "transport_failure");
}
