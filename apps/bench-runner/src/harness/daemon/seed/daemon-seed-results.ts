import type {
  SeededMemoryResult,
  SeededObjectResult
} from "./daemon-seed-types.js";

export function isSeededMemoryResult(
  seed: SeededObjectResult
): seed is SeededMemoryResult {
  return seed.kind !== "evidence_capsule";
}
