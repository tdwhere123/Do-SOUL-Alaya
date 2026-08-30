import { ShadowContractError } from "../../contract-primitives.js";
import type { SupportEdgeKind, SupportEndpointV1, SupportNodeKind } from "./types.js";

type Incidence = Readonly<{
  readonly from: readonly SupportNodeKind[];
  readonly to: readonly SupportNodeKind[];
}>;

const INCIDENCE: Readonly<Record<SupportEdgeKind, Incidence>> = {
  expresses: { from: ["candidate_projection"], to: ["answer_binding"] },
  yields: { from: ["answer_binding"], to: ["proposition"] },
  grounds: { from: ["evidence_unit"], to: ["proposition"] },
  supports: { from: ["evidence_unit"], to: ["proposition"] },
  refutes: { from: ["evidence_unit"], to: ["proposition"] },
  supersedes: { from: ["proposition"], to: ["proposition"] },
  sourced_from: { from: ["evidence_unit"], to: ["source_lineage"] },
  correlated: { from: ["evidence_unit"], to: ["evidence_unit"] }
};

export function assertEdgeIncidence(
  kind: SupportEdgeKind,
  from: SupportEndpointV1,
  to: SupportEndpointV1
): void {
  const rule = INCIDENCE[kind];
  if (!rule.from.includes(from.kind) || !rule.to.includes(to.kind)) {
    throw new ShadowContractError(`${kind} rejects ${from.kind} -> ${to.kind}`);
  }
  if (kind === "supersedes" && from.id === to.id) {
    throw new ShadowContractError("supersedes cannot be reflexive");
  }
  if (kind === "correlated" && from.id === to.id) {
    throw new ShadowContractError("correlated cannot be reflexive");
  }
}
