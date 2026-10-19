import { createHash } from "node:crypto";
import { canonicalJson } from "@do-soul/alaya-protocol";
import type { ExtractionTransportProvenance } from "../extraction/transport-route.js";
import type { SemanticProposalKind } from "./workset.js";

/** Revision, root binding and receipt identity never renew this ledger's attempts. */
export function proposalAttemptLineage(input: Readonly<{
  kind: SemanticProposalKind; model: string; request_profile: string;
  transport_provenance: ExtractionTransportProvenance;
}>): string {
  return createHash("sha256").update(canonicalJson({ contract: "semantic-proposal-execution-lineage-v1",
    kind: input.kind, model: input.model, request_profile: input.request_profile,
    transport_provenance: input.transport_provenance })).digest("hex");
}
