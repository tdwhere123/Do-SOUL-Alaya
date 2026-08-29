import type { LexicalIntervalSourceReceiptV1 } from
  "../../field/retrieval/lexical-interval-source-receipt.js";
import type { RecallRetrievalFieldBundle } from
  "../../field/retrieval/retrieval-field-bundle.js";
import { verifyLexicalIntervalSourceObservationV1 } from
  "../../field/retrieval/retrieval-field-source-authority.js";
import type { SnapshotReadLeaseV1 } from
  "../../runtime/snapshot-coherence/index.js";
import { requireNonemptyString, ShadowContractError } from "../envelope.js";
import type { MeasurementCollapseV1 } from "./collapse.js";
import type { MeasurementGroupContractV1 } from "./contract.js";
import { LEXICAL_INTERVAL_MEASUREMENT_CONTRACT } from "./lexical-interval.js";
import type {
  AdmissibleMeasurementCollapseV1,
  LexicalMeasurementAuthorityEvidenceV1,
  VerifiedMeasurementAuthorityV1
} from "./admission.js";

type CollapsedNumericMeasurementV1 =
  Extract<MeasurementCollapseV1, { status: "collapsed" }>;

const sources = new WeakMap<object, Readonly<{
  readonly receipt: Readonly<LexicalIntervalSourceReceiptV1>;
  readonly bundle: Readonly<RecallRetrievalFieldBundle>;
  readonly lease: SnapshotReadLeaseV1;
}>>();

export function bindLexicalMeasurementAuthoritySource(
  authority: VerifiedMeasurementAuthorityV1,
  evidence: LexicalMeasurementAuthorityEvidenceV1
): void {
  sources.set(authority, Object.freeze({
    receipt: evidence.lexical_source_receipt,
    bundle: evidence.lexical_source_bundle,
    lease: evidence.snapshot_read_lease
  }));
}

export function assertLexicalMeasurementSourceObservation(
  authority: VerifiedMeasurementAuthorityV1,
  contract: MeasurementGroupContractV1,
  collapse: AdmissibleMeasurementCollapseV1
): void {
  if (contract !== LEXICAL_INTERVAL_MEASUREMENT_CONTRACT ||
      !isNumericCollapse(collapse)) {
    throw new ShadowContractError("measurement authority lacks source-owned jurisdiction");
  }
  const source = sources.get(authority);
  const payload = collapse.witness.payload;
  if (source === undefined || payload === null || payload.lower !== payload.upper ||
      !isLexicalAdapterProvenance(collapse.witness.provenance)) {
    throw new ShadowContractError("lexical measurement is not bound to issued source bytes");
  }
  try {
    verifyLexicalIntervalSourceObservationV1(source.receipt, {
      bundle: source.bundle,
      lease: source.lease,
      candidate_key: requireNonemptyString(
        collapse.witness.identity.candidate_id,
        "candidate_id"
      ),
      normalized_rank: payload.lower
    });
  } catch {
    throw new ShadowContractError("lexical measurement source authority is not active and exact");
  }
}

function isNumericCollapse(
  collapse: AdmissibleMeasurementCollapseV1
): collapse is CollapsedNumericMeasurementV1 {
  return collapse.witness.domain === "numeric_interval";
}

function isLexicalAdapterProvenance(
  provenance: CollapsedNumericMeasurementV1["witness"]["provenance"]
): boolean {
  return provenance.length === 1 &&
    provenance[0]?.source_id === "lexical.interval.primary" &&
    provenance[0]?.producer === "lexical.interval.adapter.v1";
}
