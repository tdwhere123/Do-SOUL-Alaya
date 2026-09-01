import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import { readLiveLexicalClosureSource } from
  "../adapters/lexical-bound/source-authority.js";
import { closeLexicalBoundChannel } from "../closure/lexical-bound.js";
import { captureVerifiedLiveClosureAuthority } from
  "../closure/live-authority-binding.js";
import { verifyChannelClosureResult } from "../closure/verify.js";
import type { LiveQueryProofAuthority } from "../live-query-proof-authority.js";
import type { SealCheckerInputV1 } from "./checker.js";
import {
  decideWorldCapture,
  decideWorldRuntimeCapture
} from "./world-capture.js";

export type DecisionClosureManifestV1 = Readonly<{
  readonly manifest_digest: RecallFieldDigest;
}>;

export function decisionClosureManifest(
  input: SealCheckerInputV1,
  authority: LiveQueryProofAuthority
): DecisionClosureManifestV1 | null {
  try {
    const captured = captureVerifiedLiveClosureAuthority(authority);
    const capabilities = captured.authority.snapshot_read_lease.capabilities;
    const active = capabilities.filter(({ view_kind }) => view_kind !== "unavailable");
    if (!unavailableCapabilitiesAreClosed(capabilities)) return null;
    const source = readLiveLexicalClosureSource(captured.source_authority);
    if (source === null || active.length !== 1 ||
        active[0]?.source_owner !== source.scope.channel_id) return null;
    const expected = closeLexicalBoundChannel(captured.source_authority);
    if (expected === null || expected.status !== "exact_closed" ||
        expected.remaining_effects.length !== 0 || input.closures.length !== 1) return null;
    const verified = verifyChannelClosureResult(input.closures[0]!, captured.source_authority);
    if (verified.result_digest !== expected.result_digest) return null;
    const worldKeys = [...input.world.candidates.map(({ candidate_key }) => candidate_key)].sort();
    if (digestRecallFieldIdentity(worldKeys) !==
        digestRecallFieldIdentity(source.candidate_keys)) return null;
    const worldCapture = decideWorldCapture(input.world);
    const runtimeCapture = decideWorldRuntimeCapture(input.world);
    if (worldCapture === null || runtimeCapture === null ||
        (worldKeys.length > 0 && worldCapture.source_evidence_digest === null)) return null;
    const body = Object.freeze({
      kind: "query_proof_decision_closure_manifest_v1",
      authority_digest: captured.binding.authority_digest,
      lease_id: captured.authority.snapshot_read_lease.lease_id,
      runtime_capture_digest: runtimeCapture.manifest_digest,
      candidate_universe_digest: worldCapture.candidate_universe_digest,
      source_evidence_digest: worldCapture.source_evidence_digest,
      active_source_owners: Object.freeze(active.map(({ source_owner }) => source_owner).sort()),
      unavailable_source_owners: Object.freeze(capabilities
        .filter(({ view_kind }) => view_kind === "unavailable")
        .map(({ source_owner }) => source_owner).sort()),
      closure_result_digest: verified.result_digest,
      closure_universe_digest: verified.universe_digest,
      source_receipt_digests: verified.source_receipt_digests,
      finite_fixture_digest: digestRecallFieldIdentity(input.fixture),
      coordinate_manifest_digest: digestRecallFieldIdentity(input.coordinates)
    });
    return Object.freeze({ manifest_digest: digestRecallFieldIdentity(body) });
  } catch {
    return null;
  }
}

function unavailableCapabilitiesAreClosed(
  capabilities: LiveQueryProofAuthority["snapshot_read_lease"]["capabilities"]
): boolean {
  return capabilities.every((capability) => capability.view_kind !== "unavailable" ||
    capability.declaration.lag_bound.kind === "not_applicable");
}
