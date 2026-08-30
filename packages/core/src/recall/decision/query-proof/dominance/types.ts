import type { D1EnvelopeIdentity } from "../adapters/lexical-bound/legal-envelope.js";
import type {
  MeasurementAdmissionV1,
  MeasurementCollapseV1,
  MeasurementCoordinateIdentityV1,
  PropositionStateCollapseV1
} from "../measurement/index.js";
import type { LexDomain } from "../observations.js";

export type PsiV2CoordinateV1 = Readonly<{
  readonly proposition_id: string;
  readonly proposition_schema: string;
  readonly identity: MeasurementCoordinateIdentityV1 | null;
  readonly collapse: MeasurementCollapseV1 | PropositionStateCollapseV1;
  readonly admission: MeasurementAdmissionV1 | null;
  readonly applicable: boolean;
  readonly lex_domain: LexDomain | null;
  readonly envelope_identity: D1EnvelopeIdentity | null;
}>;

export type PsiV2CandidateV1 = Readonly<{
  readonly candidate_id: string;
  readonly coordinates: readonly PsiV2CoordinateV1[];
}>;

export type PsiV2VerdictKind =
  | "dominates"
  | "dominated_by"
  | "incomparable"
  | "tradeoff"
  | "equal"
  | "blocked";

export type PsiV2VerdictV1 = Readonly<{
  readonly kind: PsiV2VerdictKind;
  readonly reasons: readonly string[];
}>;
