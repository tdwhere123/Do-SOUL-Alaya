import {
  buildGardenTurnEvidenceFallback
} from "@do-soul/alaya-soul";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import type { BenchSignalSeedInput } from "./daemon-seed-types.js";
import type { CreateBenchSeedOpsInput } from "./daemon-seed-ops-types.js";

interface BenchSourceEvidenceFallback {
  readonly signal: CandidateMemorySignal;
  readonly truncated: boolean;
  readonly charsClipped: number;
}

type TrustedSourceFallbackSeed = BenchSignalSeedInput & Readonly<{
  evidenceFallbackReason: NonNullable<
    BenchSignalSeedInput["evidenceFallbackReason"]
  >;
}>;

export function buildBenchSourceEvidenceFallback(
  input: CreateBenchSeedOpsInput,
  seed: BenchSignalSeedInput
): BenchSourceEvidenceFallback {
  assertTrustedSourceFallback(seed);
  const signalId = seed.evidenceRef;
  const observedAt = seed.sourceObservedAt ?? new Date().toISOString();
  const signal = buildGardenTurnEvidenceFallback({
    turnContent: seed.turnContent,
    ...(seed.turnMessages === undefined ? {} : { turnMessages: seed.turnMessages }),
    reason: seed.evidenceFallbackReason,
    signalId,
    workspaceId: input.activeContext.workspaceId,
    runId: input.activeContext.runId,
    surfaceId: seed.surfaceId ?? null,
    createdAt: observedAt,
    sourceObservation: {
      observed_at: observedAt,
      authority: "trusted_host_event",
      source_event_id: signalId
    }
  });
  if (signal === null) {
    throw new Error("source evidence fallback requires non-empty turn content");
  }
  const preservation = signal.raw_payload.evidence_preservation;
  if (readRecord(preservation)?.version !== 2) {
    throw new Error("source evidence fallback requires a complete trusted User projection");
  }
  return {
    signal,
    truncated: readBoolean(preservation, "truncated"),
    charsClipped: readNumber(preservation, "chars_clipped")
  };
}

function assertTrustedSourceFallback(
  seed: BenchSignalSeedInput
): asserts seed is TrustedSourceFallbackSeed {
  if (
    seed.evidenceFallbackReason === undefined ||
    seed.extractionProvider !== "official_api_compile" ||
    seed.signalKind !== "potential_evidence_anchor" ||
    seed.objectKind !== "source_turn" ||
    seed.confidence !== 1
  ) {
    throw new Error("source evidence fallback requires a trusted compile source turn");
  }
}

function readBoolean(value: unknown, key: string): boolean {
  return readRecord(value)?.[key] === true;
}

function readNumber(value: unknown, key: string): number {
  const field = readRecord(value)?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}
