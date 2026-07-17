export interface SeededMemoryResult {
  readonly memoryId: string;
  readonly signalId: string;
  readonly proposalId: string;
  readonly evidenceId: string | null;
  readonly truncated: boolean;
  readonly charsClipped: number;
}

export interface BenchSynthesisSeedInput {
  readonly evidenceRefs: readonly string[];
  readonly summary: string;
  readonly topicKey: string;
}

export interface SeededSynthesisResult {
  readonly synthesisId: string | null;
}

export type CompileSeedDropReason = "candidate_absent" | "materialization_drop";

export interface CompileSeedSignalDrop {
  readonly reason: CompileSeedDropReason;
  readonly detail: string;
}

export interface CompileSeedBatchResult {
  readonly seeds: readonly SeededMemoryResult[];
  readonly dropped: readonly CompileSeedSignalDrop[];
}

export interface BenchSignalSeedInput {
  readonly signalKind: string;
  readonly objectKind: string;
  readonly confidence: number;
  readonly distilledFact: string;
  readonly turnContent: string;
  readonly matchedText?: string;
  readonly surfaceId?: string | null;
  readonly productionRawPayload?: Readonly<Record<string, unknown>>;
  readonly evidenceRef: string;
  readonly turnSeedIndex: number;
  readonly extractionProvider: "official_api_compile" | "no_credentials_fallback";
  readonly sourceObservedAt?: string;
  readonly sourceMemoryRefs?: readonly string[];
}

export interface BenchContextUsageObject {
  readonly objectId: string;
  readonly objectKind?: string;
  readonly usageStatus: "used" | "skipped" | "not_applicable";
}

export interface BenchReportContextUsageInput {
  readonly deliveryId: string;
  readonly usageState: "used" | "skipped" | "not_applicable";
  readonly usedObjectIds?: readonly string[];
  readonly deliveredObjects?: readonly BenchContextUsageObject[];
  readonly turnIndex?: number;
  readonly turnDigest?: {
    readonly lastMessages: readonly {
      readonly role: string;
      readonly contentExcerpt: string;
    }[];
  };
  readonly reason?: string;
}
