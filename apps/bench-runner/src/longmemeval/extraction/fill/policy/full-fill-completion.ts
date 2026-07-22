import type { CompileSeedExtractionStats } from "../../../compile-seed.js";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import type { ExtractionFillCompletion } from "../fill-completion.js";
import { assertExtractionFillComplete } from "../fill-completion.js";
import { countTerminalProviderFailures, type FillRetryTelemetry } from "../fill-stats.js";
import type { PreparedExtractionFill } from "../fill-preparation.js";
import type { ExtractionFillStatus } from "../manifest/fill-manifest-contract.js";

export function resolveFullFillStatus(input: {
  readonly prepared: PreparedExtractionFill;
  readonly stats: CompileSeedExtractionStats;
  readonly completion: ExtractionFillCompletion;
  readonly telemetry: FillRetryTelemetry;
  readonly repairScopeTurns: number | undefined;
  readonly allowProviderTaskFailures: boolean;
  readonly intentionalSkippedTurns: number;
}): ExtractionFillStatus {
  const failures = countTerminalProviderFailures(input.telemetry);
  assertIntentionalSkippedTurns(input.intentionalSkippedTurns);
  if (failures > 0 && !input.allowProviderTaskFailures) {
    assertExtractionFillComplete(input.completion);
  }
  if (input.intentionalSkippedTurns > 0 || failures > 0) {
    assertHonestPartialCompletion(input, failures);
    return "in_progress";
  }
  assertExtractionFillComplete(input.completion);
  assertTaskConservation(input, 0);
  return "complete";
}

function assertHonestPartialCompletion(
  input: Parameters<typeof resolveFullFillStatus>[0],
  failures: number
): void {
  const completion = input.completion;
  const unresolved = completion.missingTurns + completion.invalidTurns;
  const explained = input.intentionalSkippedTurns + failures;
  const invalidRepairState = input.repairScopeTurns === undefined && completion.invalidTurns !== 0;
  if (invalidRepairState || completion.orphanTurns !== 0 || unresolved !== explained ||
      completion.validTurns + unresolved !== completion.expectedTurns) {
    throw new ExtractionCacheInvariantError(
      "authorized skips and isolated provider failures do not explain the incomplete fill: " +
        `missing=${completion.missingTurns} skipped=${input.intentionalSkippedTurns} ` +
        `failures=${failures} ` +
        `invalid=${completion.invalidTurns} orphan=${completion.orphanTurns}`
    );
  }
  assertTaskConservation(input, failures);
}

function assertTaskConservation(
  input: Parameters<typeof resolveFullFillStatus>[0],
  failures: number
): void {
  const completedTasks = input.stats.cacheHits + input.stats.llmCalls + failures +
    input.intentionalSkippedTurns;
  const executionTurns = input.repairScopeTurns ?? input.prepared.requestedTurns;
  if (completedTasks === executionTurns &&
      input.completion.expectedTurns === input.prepared.requestedTurns) return;
  throw new ExtractionCacheInvariantError(
    "extraction-fill task conservation failed: " +
      `cache_hits=${input.stats.cacheHits} newly_extracted=${input.stats.llmCalls} ` +
      `failures=${failures} skipped=${input.intentionalSkippedTurns} ` +
      `requested=${executionTurns} ` +
      `expected=${input.completion.expectedTurns}`
  );
}

function assertIntentionalSkippedTurns(value: number): void {
  if (Number.isSafeInteger(value) && value >= 0) return;
  throw new ExtractionCacheInvariantError(
    "intentional skipped turn count must be a non-negative safe integer"
  );
}
