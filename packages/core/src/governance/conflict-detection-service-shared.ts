import {
  MemoryGraphEdgeType,
  type MemoryEntry,
  type MemoryGraphEdgeTypeValue
} from "@do-soul/alaya-protocol";
import {
  CONTRADICTS_SEED_PROFILE,
  INCOMPATIBLE_SEED_PROFILE,
  type PathSeedProfile
} from "../path-graph/path-relation-proposal-service.js";

export type ConflictVerdictSource = "rule" | "llm";

export interface ConflictDetectionMemoryRepoPort {
  findByDimension(
    workspaceId: string,
    dimension: MemoryEntry["dimension"],
    page?: {
      readonly limit: number;
      readonly offset: number;
    }
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByDimensionAll?(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findBySharedDomainTags(
    workspaceId: string,
    tags: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

export interface ConflictDetectionLlmPort {
  classifyPair(input: {
    readonly newContent: string;
    readonly existingContent: string;
    readonly dimension: string;
    readonly scopeClass: string;
  }): Promise<"contradicts" | "incompatible_with" | "none">;
}

export interface ConflictDetectionKarmaEmitterPort {
  emitKarmaEvent(input: {
    readonly kind: "supersede_penalty";
    readonly objectId: string;
    readonly workspaceId: string;
    readonly runId?: string | null;
  }): Promise<void>;
}

export interface ConflictDetectionServiceDeps {
  readonly memoryRepo: ConflictDetectionMemoryRepoPort;
  readonly pathCandidatePort: import("../path-graph/path-candidate-sink.js").PathCandidateSink;
  readonly llmPort?: ConflictDetectionLlmPort;
  readonly karmaEmitter?: ConflictDetectionKarmaEmitterPort;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly llmMaxPairsPerNewMemory?: number;
  readonly ruleEnabled?: boolean;
}

export const TAG_OVERLAP_CONTRADICTS_THRESHOLD = 0.35;
export const TOKEN_JACCARD_CONTRADICTS_MAX = 0.35;
export const DEFAULT_LLM_MAX_PAIRS = 4;
const CONFLICT_DETECTION_MEMORY_SCAN_PAGE_LIMIT = 500;

const RULE_CONTRADICTS_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "contradicts",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.4,
  evidenceBasis: Object.freeze(["contradiction_evidence"]) as readonly string[]
});

const RULE_INCOMPATIBLE_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "incompatible_with",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.3,
  evidenceBasis: Object.freeze(["incompatibility_evidence"]) as readonly string[]
});

export function negativeProfileForEdgeType(
  edgeType: MemoryGraphEdgeTypeValue,
  verdictSource: ConflictVerdictSource
): PathSeedProfile {
  if (verdictSource === "rule") {
    return edgeType === MemoryGraphEdgeType.INCOMPATIBLE_WITH
      ? RULE_INCOMPATIBLE_SEED_PROFILE
      : RULE_CONTRADICTS_SEED_PROFILE;
  }
  return edgeType === MemoryGraphEdgeType.INCOMPATIBLE_WITH
    ? INCOMPATIBLE_SEED_PROFILE
    : CONTRADICTS_SEED_PROFILE;
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((token) => token.length >= 2)
  );
}

export function jaccardIndex(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): number {
  if (left.size === 0 && right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export async function readConflictDimensionCandidates(
  memoryRepo: ConflictDetectionMemoryRepoPort,
  workspaceId: string,
  dimension: MemoryEntry["dimension"]
): Promise<readonly Readonly<MemoryEntry>[]> {
  if (memoryRepo.findByDimensionAll !== undefined) {
    return await memoryRepo.findByDimensionAll(workspaceId, dimension);
  }

  const rows: Readonly<MemoryEntry>[] = [];
  for (let offset = 0; ; offset += CONFLICT_DETECTION_MEMORY_SCAN_PAGE_LIMIT) {
    const page = await memoryRepo.findByDimension(workspaceId, dimension, {
      limit: CONFLICT_DETECTION_MEMORY_SCAN_PAGE_LIMIT,
      offset
    });
    rows.push(...page);
    if (page.length < CONFLICT_DETECTION_MEMORY_SCAN_PAGE_LIMIT) {
      break;
    }
  }
  return Object.freeze(rows);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
