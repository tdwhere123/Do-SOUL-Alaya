import {
  buildSourceSemanticCorrespondenceEndpointCatalog, canonicalJson, sourceSemanticQueryBranchViews,
  sourceSemanticCorrespondenceIdentity, type SourceTaskAssociation, type SourceTaskObservationDraftSchema,
  type SourceTaskObservationFormationInput
} from "@do-soul/alaya-protocol";
import { admitSourceSemanticCorrespondence, fieldContractSha256 } from "@do-soul/alaya-core";
import type { z } from "zod";

type DraftRow = z.infer<typeof SourceTaskObservationDraftSchema>["observations"][number];

/** Addressability only: C's structural admission is not an executable binding or semantic proof. */
export function buildObservationEndpointCatalogs(input: SourceTaskObservationFormationInput, formationIdentity: string) {
  const request = fieldContractSha256(canonicalJson({ formationIdentity, input }));
  return input.sources.map((source, sourceIndex) => {
    const associations: { ref: string; association: SourceTaskAssociation }[] = [];
    const temporal_operands: { ref: string; endpoint: NonNullable<SourceTaskAssociation["temporal_operand"]>; reading?: string }[] = [];
    const selected = source.selected_interpretation, query = input.query_semantics;
    const empty = (reason: string) => ({ source_ref: source.source_ref, reason, associations, temporal_operands });
    if (selected === undefined || query === undefined) return empty("missing_query_or_interpretation");
    if (canonicalJson(selected.source_target) !== canonicalJson(source.target)) return empty("interpretation_source_mismatch");
    const correspondences = input.semantic_correspondences ?? [];
    const identities = correspondences.map(row => sourceSemanticCorrespondenceIdentity(row, fieldContractSha256));
    const seen = new Set<string>();
    for (const [index, correspondence] of correspondences.entries()) {
      if (correspondence.source_interpretation_id !== selected.interpretation_id
        || identities.indexOf(identities[index]!) !== identities.lastIndexOf(identities[index]!)) continue;
      const admitted = admitSourceSemanticCorrespondence({ query_semantics: query, source_interpretation: selected.interpretation,
        semantic_correspondence: correspondence, original_query: input.query });
      if (admitted.kind !== "admitted" || admitted.interpretation_id !== selected.interpretation_id) continue;
      const catalog = buildSourceSemanticCorrespondenceEndpointCatalog(admitted.query,
        [{ source_interpretation_handle: "source1", interpretation: admitted.interpretation }]);
      if (temporal_operands.length === 0) for (const endpoint of catalog.source_endpoints) {
        if (endpoint.kind !== "slot") continue;
        temporal_operands.push({ ref: `t:${request}:${sourceIndex}:${temporal_operands.length}`,
          endpoint: { kind: "slot", frame: endpoint.frame!, slot: endpoint.slot! }, reading: endpoint.reading });
      }
      for (const pair of correspondence.correspondences) {
        const q = pair.query_endpoint, h = pair.source_endpoint;
        if (q.kind !== "predicate" || h.kind !== "frame") continue;
        // The production catalog owns endpoint eligibility; branch views own target membership.
        if (!catalog.query_endpoints.some(row => row.kind === q.kind && row.alternative === q.alternative && row.frame === q.frame)
          || !catalog.source_endpoints.some(row => row.kind === h.kind && row.frame === h.frame)) continue;
        for (const branch of sourceSemanticQueryBranchViews(admitted.query.alternatives[q.alternative]!)) {
          if (!branch.alternative.frames.some(frame => frame.id === q.frame)) continue;
          const association: SourceTaskAssociation = { semantic_correspondence_id: admitted.semantic_correspondence_id,
            alternative: q.alternative, target: branch.target, query_frame: q.frame, source_frame: h.frame };
          const key = canonicalJson(association);
          if (seen.has(key)) continue;
          seen.add(key);
          associations.push({ ref: `a:${request}:${sourceIndex}:${associations.length}`, association });
        }
      }
    }
    return { source_ref: source.source_ref,
      reason: associations.length === 0 ? "no_admitted_association_endpoints" : null, associations, temporal_operands };
  });
}

/** Resolve only the supplied references. No first-candidate, role-label, date or record-clock inference. */
export function resolveObservationEndpointSelection(catalog: ReturnType<typeof buildObservationEndpointCatalogs>[number], row: DraftRow) {
  if ((row.association_status === "selected") !== (row.association_ref !== null)
    || (row.temporal_operand_status === "selected") !== (row.temporal_operand_ref !== null)) {
    return { error: "incoherent_endpoint_selection" } as const;
  }
  const selection = { source_ref: row.source_ref, association_status: row.association_status,
    temporal_operand_status: row.temporal_operand_status };
  if (row.association_status !== "selected") {
    return row.temporal_operand_status === "selected" ? { error: "temporal_selection_without_association" } as const
      : { selection };
  }
  const selected = catalog.associations.find(entry => entry.ref === row.association_ref);
  if (selected === undefined) return { error: "unknown_association_ref" } as const;
  if (row.temporal_operand_status !== "selected") {
    return row.time_status === "interpreted" ? { error: "interpreted_time_without_operand" } as const
      : { selection, association: selected.association };
  }
  const operand = catalog.temporal_operands.find(entry => entry.ref === row.temporal_operand_ref);
  if (operand === undefined) return { error: "unknown_temporal_operand_ref" } as const;
  if (operand.endpoint.frame !== selected.association.source_frame) return { error: "cross_frame_temporal_operand" } as const;
  return { selection, association: { ...selected.association, temporal_operand: operand.endpoint } };
}
