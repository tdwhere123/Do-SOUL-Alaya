import { CanonicalJsonSubtrees } from "../recall/selection/capture/canonical-json.js";
import { sourceSemanticAccessPhasesWithCaptures, sourceSemanticCanonicalPhaseCapture,
  type sourceSemanticAccessPhases } from "./source-semantic-phase-codec.js";
import type { SourceSemanticQueryPreparation, SourceSemanticAcquisitionPhase } from "./source-semantic-phase-semantics.js";
import type { SourceSemanticAccessPhases, SourceSemanticCompactPreparation,
  SourceSemanticReadableAccessPhases } from "./source-semantic-phase-wire.js";
import type { SourceSemanticProfiledAcquisitionPhase } from "./source-semantic-access-profile.js";
import type { SourceSemanticResourceLedger } from "./source-semantic-resources.js";

type ChargeMeter = Pick<SourceSemanticResourceLedger, "charge">;
type PhaseMeter = Pick<SourceSemanticResourceLedger, "charge" | "retain">;
type BorrowPreparation = (expected: SourceSemanticCompactPreparation) => SourceSemanticQueryPreparation | undefined;
type Acquisition<P extends SourceSemanticReadableAccessPhases> = P extends SourceSemanticAccessPhases
  ? SourceSemanticAcquisitionPhase : SourceSemanticProfiledAcquisitionPhase;
type BorrowAcquisition<P extends SourceSemanticReadableAccessPhases> = (expected: P[2]) => Acquisition<P> | undefined;

/** Exported internal-consumer source API. No wire, retained lease or digest authority. */
export interface PreparedSourceSemanticCanonicalSubtrees<P extends SourceSemanticReadableAccessPhases = SourceSemanticAccessPhases> {
  accessPhases(access: Readonly<{ phases: P }>, meter: PhaseMeter): Omit<ReturnType<typeof sourceSemanticAccessPhases>, "acquisition"> & { acquisition: Acquisition<P> };
  quote(value: unknown, execution: ChargeMeter, planner: ChargeMeter): Iterable<number>;
  chunks(value: unknown, meter: ChargeMeter): Iterable<string>;
  close(): void;
}

class RequestCanonicalPhases<P extends SourceSemanticReadableAccessPhases> implements PreparedSourceSemanticCanonicalSubtrees<P> {
  private preparation?: SourceSemanticQueryPreparation;
  private acquisition?: Acquisition<P>;
  private canonical?: CanonicalJsonSubtrees;
  constructor(private compactPreparation: SourceSemanticCompactPreparation | undefined,
    private compactAcquisition: P[2] | undefined,
    private borrowPreparation: BorrowPreparation | undefined, private borrowAcquisition: BorrowAcquisition<P> | undefined,
    planner: ChargeMeter) {
    // Eight reference/state slots at most. Cross-owner references are not copied trees.
    planner.charge(1, 128, "source phase canonical request record");
    try {
      planner.charge(8, 0, "source phase request capture borrowing");
      this.preparation = sourceSemanticCanonicalPhaseCapture(compactPreparation!, borrowPreparation!(compactPreparation!), planner);
      this.acquisition = sourceSemanticCanonicalPhaseCapture(compactAcquisition!, borrowAcquisition!(compactAcquisition!), planner);
      this.canonical = new CanonicalJsonSubtrees(this.preparation, this.acquisition, planner);
    } catch (error) { this.close(); throw error; }
  }

  accessPhases(access: Readonly<{ phases: P }>, meter: PhaseMeter): ReturnType<PreparedSourceSemanticCanonicalSubtrees<P>["accessPhases"]> {
    this.assertOpen();
    meter.charge(10, 0, "source phase request binding identity checks");
    if (access.phases[1] !== this.compactPreparation || access.phases[2] !== this.compactAcquisition ||
        sourceSemanticCanonicalPhaseCapture(this.compactPreparation!, this.borrowPreparation!(this.compactPreparation!), meter) !== this.preparation ||
        sourceSemanticCanonicalPhaseCapture(this.compactAcquisition!, this.borrowAcquisition!(this.compactAcquisition!), meter) !== this.acquisition) {
      this.close();
      // Never replace a quoted plan by a heavier, unquoted expansion at binding.
      throw new TypeError("source phase canonical preparation binding changed");
    }
    // P binds the compact discriminator to its captured semantic family above.
    return sourceSemanticAccessPhasesWithCaptures(access, meter, this.preparation, this.acquisition) as
      ReturnType<PreparedSourceSemanticCanonicalSubtrees<P>["accessPhases"]>;
  }

  quote(value: unknown, execution: ChargeMeter, planner: ChargeMeter): Iterable<number> {
    this.assertOpen();
    return this.canonical!.quote(value, execution, planner);
  }

  chunks(value: unknown, meter: ChargeMeter): Iterable<string> {
    this.assertOpen();
    return this.canonical!.chunks(value, meter);
  }

  close(): void {
    this.canonical?.close(); this.canonical = undefined;
    this.preparation = this.acquisition = undefined;
    this.compactPreparation = this.compactAcquisition = undefined;
    this.borrowPreparation = this.borrowAcquisition = undefined;
  }

  private assertOpen(): void {
    if (this.canonical === undefined) throw new TypeError("source phase canonical preparation is closed");
  }
}

/** Named daemon consumers must lend only actual capture/compact pairs from the codec
 * callbacks. Missing ownership or non-equivalent normal form uses ordinary expansion.
 * Plans own no meter and are sealed only by a completely consumed quotation. */
export function prepareSourceSemanticCanonicalSubtreesForRequest<P extends SourceSemanticReadableAccessPhases>(phases: P,
  borrowPreparation: BorrowPreparation, borrowAcquisition: BorrowAcquisition<P>,
  planner: ChargeMeter): PreparedSourceSemanticCanonicalSubtrees<P> {
  // Entry frame and post-census bridge slots. The request owner charges the two
  // earlier slots and the actual acquisition-borrower allocation at its call site.
  planner.charge(1, 64 + 6 * 8, "source phase canonical request bridge");
  return new RequestCanonicalPhases(phases[1], phases[2], borrowPreparation, borrowAcquisition, planner);
}
