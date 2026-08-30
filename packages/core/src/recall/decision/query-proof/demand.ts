import { MemoryDimension } from "@do-soul/alaya-protocol";
import type {
  RecallQueryDemand,
  RecallQueryDemandKind
} from "../../query/recall-query-demand.js";
import { hasTemporalQuerySignal } from "../../query/recall-query-plan.js";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import { freezeShadow } from "../contract-primitives.js";
import type { ShadowLineageId } from "./observations.js";

export type ShadowFieldArm = "E0" | "E1";

export type ShadowDemandApplicabilityInput = Readonly<{
  readonly demand: Readonly<RecallQueryDemand>;
  readonly probes: Readonly<RecallQueryProbes>;
  readonly arm: ShadowFieldArm;
}>;

export type ShadowLineageApplicability = Readonly<Record<ShadowLineageId, boolean>>;

export function shadowLineageApplicability(
  input: Readonly<ShadowDemandApplicabilityInput>
): ShadowLineageApplicability {
  return freezeShadow({
    lexical: hasDemandKind(input.demand, "lexical_term") ||
      hasDemandKind(input.demand, "phrase"),
    embedding: input.arm === "E1",
    temporal: hasDemandKind(input.demand, "temporal") ||
      hasTemporalQuerySignal(input.probes),
    subject_preference: input.probes.dimensions.includes(MemoryDimension.PREFERENCE) ||
      input.probes.subject_hints.includes("self_reference")
  });
}

function hasDemandKind(
  demand: Readonly<RecallQueryDemand>,
  kind: RecallQueryDemandKind
): boolean {
  return demand.atoms.some((atom) => atom.kind === kind);
}
