import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../../../field/field-identity.js";
import {
  verifyLiveQueryProofAuthority,
  type LiveQueryProofAuthority
} from "../live-query-proof-authority.js";
import {
  CLOSURE_SENSITIVITY_EFFECTS,
  normalizeClosureQuerySensitivities,
  type ChannelClosureScope,
  type ClosureSensitivityEffect
} from "./contract.js";

export type LiveClosureAuthorityBinding = Readonly<Pick<ChannelClosureScope,
  "authority_digest" | "query_digest" | "request_digest" | "snapshot_digest" |
  "principal_digest" | "workspace_id" | "sensitivities">>;

export function deriveLiveClosureAuthorityBinding(
  authority: LiveQueryProofAuthority
): LiveClosureAuthorityBinding {
  const pins = verifyLiveQueryProofAuthority(authority);
  const compilation = authority.canonical_query_compilation;
  const principalDigest = digestRecallFieldIdentity({
    principal: authority.snapshot_vector.principal,
    authorized_scopes: authority.snapshot_vector.authorized_scopes
  });
  const sensitivities = normalizeClosureQuerySensitivities(
    compilation.sensitivities.map((row) => Object.freeze({
      sensitivity_id: `${row.effect}:${row.target}`,
      effect: closureEffect(row.effect),
      target: row.target
    }))
  );
  const binding = Object.freeze({
    query_digest: compilation.digest,
    request_digest: authority.query_condition.identity as RecallFieldDigest,
    snapshot_digest: pins.snapshot_digest as RecallFieldDigest,
    principal_digest: principalDigest,
    workspace_id: pins.workspace_id,
    sensitivities
  });
  return Object.freeze({
    ...binding,
    authority_digest: digestRecallFieldIdentity({
      operator_id: "verified_live_query_proof_authority_binding_v1",
      ...binding,
      snapshot_coherence_receipt_digest:
        authority.snapshot_coherence_receipt.receipt_digest,
      snapshot_read_lease_id: authority.snapshot_read_lease.lease_id
    })
  });
}

function closureEffect(effect: string): ClosureSensitivityEffect {
  if (effect === "extremum_range") return "extremum_interval";
  if (CLOSURE_SENSITIVITY_EFFECTS.has(effect)) return effect as ClosureSensitivityEffect;
  throw new Error("canonical query sensitivity effect is unsupported");
}
