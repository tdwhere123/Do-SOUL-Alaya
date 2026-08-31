import type { RecallFieldDigest } from
  "../../../field/field-identity.js";
import type { ChannelClosureResult } from "./contract.js";
import {
  verifyLiveQueryProofAuthority,
  type LiveQueryProofAuthority
} from "../live-query-proof-authority.js";

export const EXTREMUM_CLOSURE_WITNESS_OPERATOR_ID =
  "query_proof_extremum_closure_witness_v1";

export type ExtremumClosureWitness = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof EXTREMUM_CLOSURE_WITNESS_OPERATOR_ID;
  readonly operator: "argmax" | "argmin";
  readonly closure_result_digest: RecallFieldDigest;
  readonly query_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly universe_digest: RecallFieldDigest;
  readonly sensitivity_id: string;
  readonly extremal_binding_ids: readonly string[];
  readonly interval_digest: RecallFieldDigest;
  readonly witness_digest: RecallFieldDigest;
}>;

export function createExtremumClosureWitness(params: Readonly<{
  readonly authority: LiveQueryProofAuthority;
  readonly closure: ChannelClosureResult;
  readonly operator: "argmax" | "argmin";
  readonly sensitivity_id: string;
}>): ExtremumClosureWitness | null {
  try {
    verifyLiveQueryProofAuthority(params.authority);
  } catch {
    return null;
  }
  // The verified live authority currently carries no source-owned interval/tie
  // coverage receipt, so Card 14 cannot admit an extremum witness.
  return null;
}
