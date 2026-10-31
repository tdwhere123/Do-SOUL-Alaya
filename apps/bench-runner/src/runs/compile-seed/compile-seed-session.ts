import type {
  BenchSynthesisSeedInput
} from "../../harness/daemon.js";

/** One seeded turn's content plus the real evidence_capsule id it materialized. */
export interface SessionSeededTurn {
  /** The full source turn content seeded for this turn. */
  readonly turnContent: string;
  /** evidence_capsule object_id the turn's signal materialized, or null. */
  readonly evidenceId: string | null;
}

// Synthesis summary digest cap — keep the digest comfortably under the
// 16384-char soul.emit_candidate_signal raw_payload limit.
const SYNTHESIS_DIGEST_MAX_CHARS = 4_000;
const SYNTHESIS_PER_TURN_MAX_CHARS = 400;

/**
 * @anchor longmemeval-session-synthesis — deterministic, LLM-free synthesis seed
 *
 * Build the session-level potential_synthesis seed input from a session's
 * seeded turns. The summary is a deterministic concat/digest of each turn's
 * content (no LLM call): turns are joined in seed order, each clipped to a
 * fixed per-turn span, the whole digest clipped to a fixed cap. Determinism
 * is required so a re-run of the bench produces a byte-identical synthesis
 * row, mirroring the no-LLM seed discipline of extractSeedInputs.
 *
 * Returns null when fewer than 2 turns materialized a real evidence_capsule
 * id — the MaterializationRouter only routes potential_synthesis with
 * evidence_refs.length >= 2 to synthesisService.create.
 *
 * see also: packages/soul/src/garden/materialization/materialization-router/router.ts materializeSynthesis
 */
export function buildSessionSynthesisInput(input: {
  readonly topicKey: string;
  readonly turns: readonly SessionSeededTurn[];
}): BenchSynthesisSeedInput | null {
  const evidenceRefs = input.turns
    .map((turn) => turn.evidenceId)
    .filter((id): id is string => id !== null);
  if (evidenceRefs.length < 2) {
    return null;
  }
  const digest = input.turns
    .map((turn) => turn.turnContent.replace(/\s+/gu, " ").trim())
    .filter((content) => content.length > 0)
    .map((content) =>
      content.length > SYNTHESIS_PER_TURN_MAX_CHARS
        ? content.slice(0, SYNTHESIS_PER_TURN_MAX_CHARS)
        : content
    )
    .join(" | ");
  const summary =
    digest.length > SYNTHESIS_DIGEST_MAX_CHARS
      ? digest.slice(0, SYNTHESIS_DIGEST_MAX_CHARS)
      : digest;
  // summary must be non-empty for SynthesisCapsuleSchema; an all-blank
  // session cannot synthesize anything meaningful.
  if (summary.length === 0) {
    return null;
  }
  return {
    topicKey: input.topicKey,
    evidenceRefs,
    summary
  };
}
