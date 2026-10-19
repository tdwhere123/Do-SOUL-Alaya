import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { materializeSemanticProposalLines } from "../semantic-proposal/workset.js";
import { captureCorrespondenceGenerationContext, type CorrespondenceGenerationContext } from "../semantic-proposal/correspondence-generation-context.js";
import type { SourceQualifiedSelectionInput } from "./source-qualified-selection-input.js";
import type { compareResearchSourceQualifiedSelection } from "../../../../core-daemon/src/runtime/recall/source-semantic-research-acquisition-controls.js";

export function contextForQualifiedCorrespondence(row: SourceQualifiedSelectionInput["nominees"][number],
  context?: CorrespondenceGenerationContext) {
  return row.interpretation?.interpretation_id === context?.target_interpretation_id ? context : undefined;
}

/** C's existing physical key commits the complete native request. No second context digest or selector. */
export function captureQualifiedCorrespondenceContext(input: SourceQualifiedSelectionInput,
  offered?: CorrespondenceGenerationContext): CorrespondenceGenerationContext | undefined {
  const context = offered === undefined ? undefined : captureCorrespondenceGenerationContext(offered);
  let targets = 0;
  for (const row of input.nominees) {
    const c = row.correspondence;
    if (c === undefined) continue;
    const selected = contextForQualifiedCorrespondence(row, context);
    let lines: ReturnType<typeof materializeSemanticProposalLines>;
    try { lines = materializeSemanticProposalLines(c.workset, c.max_output_tokens, undefined, undefined, selected); }
    catch (error) {
      // Default inventories retain malformed model-view references independently of
      // semantic admission. Explicit context never falls back; native read still rejects.
      if (context !== undefined) throw error;
      continue;
    }
    if (lines.length !== 1 || lines[0]!.key !== c.artifact.key) {
      throw new AlayaError("CONFLICT", "qualified correspondence runtime context differs from its exact producer key");
    }
    if (selected === undefined) continue;
    targets++;
    const request = lines[0]!.request as SourceSemanticCorrespondenceRequest;
    for (const descriptor of request.source_interpretation_descriptors) {
      const members = input.nominees.filter(member => member.interpretation?.interpretation_id === descriptor.source_interpretation_id);
      const member = members[0], source = descriptor.interpretation.source;
      if (members.length !== 1 || member === undefined || member.interpretation?.interpretation === undefined ||
          canonicalJson(member.interpretation.interpretation) !== canonicalJson(descriptor.interpretation) ||
          member.current.source_id !== source.source_id || member.current.source_version !== source.source_version ||
          member.current.content_digest !== source.content_digest) {
        throw new AlayaError("CONFLICT", "correspondence generation context lacks its exact required qualified nominee");
      }
    }
  }
  if (context !== undefined && targets !== 1) throw new AlayaError("CONFLICT", "correspondence context requires its single target C artifact");
  return context;
}

/** Sole context-qualified delivery sink. Canonical C/cache/raw and native proofs remain H1-local history.
 * Each new execution must pass the native pool's transaction-bound H/current-body checks again.
 * The comparison has rolled back before returning: this creates no durable/live lease. */
export function assertContextQualifiedDelivery(input: SourceQualifiedSelectionInput, context: CorrespondenceGenerationContext | undefined,
  comparison: Awaited<ReturnType<typeof compareResearchSourceQualifiedSelection>>): void {
  if (context === undefined) return;
  captureQualifiedCorrespondenceContext(input, context);
  const required = [context.target_interpretation_id, context.additional_interpretation.source_interpretation_id];
  if (comparison.outcome !== "complete" || required.some(id => !comparison.selection?.eligibility.some(row =>
    row.h === "ready" && row.source.interpretation?.interpretation_id === id))) {
    throw new AlayaError("CONFLICT", "context-qualified delivery requires both exact interpretations ready in the native snapshot");
  }
}
