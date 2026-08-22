import type { LongMemEvalVariant } from "../../longmemeval/ingestion/dataset.js";
import type { DiagnosticLoopMode, DiagnosticLoopPhase } from "./phases.js";

export const DIAGNOSTIC_LOOP_FAILURE_CLASSES = [
  "infrastructure",
  "authority",
  "formation",
  "candidate",
  "selection",
  "delivery"
] as const;

export type DiagnosticLoopFailureClass =
  (typeof DIAGNOSTIC_LOOP_FAILURE_CLASSES)[number];

export interface DiagnosticLoopIdentity {
  readonly datasetRevision: string;
  readonly requestedKeys: readonly string[];
  readonly providerRoute: string;
  readonly model: string;
  readonly requestProfile: string;
  readonly promptDigest: string;
  readonly schemaDigest: string;
  readonly operatorDigest: string;
  readonly cacheMode: "cache_only";
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly worker: boolean;
}

export interface DiagnosticLoopRequest extends DiagnosticLoopIdentity {
  readonly extractionCacheRoot?: string;
  readonly snapshotPath?: string;
  readonly snapshotOutPath?: string;
  readonly treatmentFactorCachePath?: string;
  readonly embeddingCacheOverlayReceiptPath?: string;
  readonly historyRoot?: string;
  readonly dataDir?: string;
}

export interface DiagnosticLoopAvoidedWork {
  readonly phasesSkipped: number;
  readonly providerCallsAvoided: number;
  readonly questionsSkipped: number;
  readonly snapshotsReused: number;
}

export interface DiagnosticLoopPhaseResult {
  readonly contentIdentity: string;
  readonly physicalCalls: number;
  readonly artifactPaths: Readonly<Record<string, string>>;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly avoidedWork?: Partial<DiagnosticLoopAvoidedWork>;
  readonly noProviderCallReceipt?: DiagnosticNoProviderCallReceipt;
}

export interface DiagnosticNoProviderCallReceipt {
  readonly schema_version: 1;
  readonly kind: "credentialless_environment" | "injected_no_provider_port" |
    "internal_no_provider_port";
  readonly provider_port: "absent";
  readonly physical_calls: 0;
}

export interface DiagnosticLoopPhaseContext {
  readonly workRoot: string;
  readonly request: DiagnosticLoopRequest;
  readonly mode: DiagnosticLoopMode;
  readonly checkpoints: ReadonlyMap<DiagnosticLoopPhase, DiagnosticLoopCheckpoint>;
}

export type DiagnosticLoopPhaseHandler = (
  context: DiagnosticLoopPhaseContext
) => Promise<DiagnosticLoopPhaseResult>;

export interface DiagnosticLoopAdapters {
  readonly preflight: DiagnosticLoopPhaseHandler;
  readonly authority_cache: DiagnosticLoopPhaseHandler;
  readonly extraction: DiagnosticLoopPhaseHandler;
  readonly snapshot: DiagnosticLoopPhaseHandler;
  readonly control_recall: DiagnosticLoopPhaseHandler;
  readonly treatment_recall: DiagnosticLoopPhaseHandler;
  readonly miss_ledger: DiagnosticLoopPhaseHandler;
}

export interface DiagnosticLoopCheckpoint {
  readonly schema_version: 3;
  readonly kind: "diagnostic_loop_checkpoint";
  readonly phase: DiagnosticLoopPhase;
  readonly status: "completed" | "failed";
  readonly identity_digest: string;
  readonly content_identity: string;
  readonly depends_on: Readonly<Record<string, string>>;
  readonly physical_calls: number;
  readonly avoided_work: DiagnosticLoopAvoidedWork;
  readonly artifact_paths: Readonly<Record<string, string>>;
  readonly details: Readonly<Record<string, unknown>>;
  readonly completed_at: string;
  readonly checkpoint_digest: string;
}

export interface DiagnosticLoopRunResult {
  readonly identityDigest: string;
  readonly completedPhases: readonly DiagnosticLoopPhase[];
  readonly skippedPhases: readonly DiagnosticLoopPhase[];
  readonly avoidedWork: DiagnosticLoopAvoidedWork;
  readonly reportPath: string;
  readonly smokeGate: "passed" | "failed" | "absent";
}

export interface DiagnosticLoopRunInput {
  readonly workRoot: string;
  readonly request: DiagnosticLoopRequest;
  readonly mode: DiagnosticLoopMode;
  readonly fromPhase?: DiagnosticLoopPhase;
  readonly adapters: DiagnosticLoopAdapters;
  readonly argv: readonly string[];
  readonly gate7UnlockPath?: string;
  readonly now?: () => string;
}
